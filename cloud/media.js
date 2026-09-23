const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { Transform, Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn } = require("node:child_process");
const archiver = require("archiver");
const ffmpegPath = require("ffmpeg-static");
const exifr = require("exifr");

const VERSION = "4.2.4";

function canonicalizeUrl(value) {
  const u = new URL(value);
  u.hash = "";
  ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach(k => u.searchParams.delete(k));
  u.searchParams.sort();
  return u.toString();
}

function cleanName(value, max = 110) {
  return String(value || "").replace(/\s+/g," ").trim().replace(/[<>:"/\\|?*]/g,"")
    .replace(/[\u0000-\u001F\u007F]/g,"").replace(/[^\p{L}\p{N}\s._()\-]/gu,"")
    .replace(/\s+/g,"-").replace(/-+/g,"-").slice(0,max);
}

function normalizeCollectionName(value) {
  const name = String(value || "").replace(/\s+/g," ").trim().replace(/[\\/]/g,"-").replace(/[\u0000-\u001F\u007F]/g,"");
  if (!name) return "";
  const chars = [...name];
  chars[0] = chars[0].toLocaleUpperCase("es");
  return chars.join("").slice(0,90);
}

function extFrom(url, contentType, hinted) {
  const mime = String(contentType || "").split(";")[0].toLowerCase();
  const byMime = {"image/jpeg":"jpg","image/png":"png","image/gif":"gif","image/webp":"webp","video/mp4":"mp4","video/webm":"webm","video/quicktime":"mov","video/x-m4v":"m4v"};
  if (byMime[mime]) return byMime[mime];
  if (hinted && hinted !== "other") return String(hinted).toLowerCase().replace("jpeg","jpg");
  try { const m = new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/); if (m) return m[1].replace("jpeg","jpg"); } catch {}
  return "bin";
}

function category(ext, mime, kind) {
  if (kind === "video" || String(mime).startsWith("video/") || ["mp4","m4v","mov","webm","avi","mkv"].includes(ext)) return "VIDEO";
  if (["jpg","jpeg"].includes(ext)) return "JPG";
  if (ext === "png") return "PNG";
  if (ext === "gif") return "GIF";
  if (ext === "webp") return "WEBP";
  return "OTROS";
}

function uniqueUrls(values) {
  return [...new Set((values || []).filter(Boolean).map(v => { try { return canonicalizeUrl(v); } catch { return String(v || ""); } }).filter(Boolean))];
}

function pinterestVariants(value) {
  try {
    const u = new URL(value);
    if (u.hostname !== "i.pinimg.com") return [];
    const match = u.pathname.match(/^\/(originals|1200x|736x|564x|474x|236x)\/(.+)$/i);
    if (!match) return [];
    const rest = match[2];
    return uniqueUrls([match[1],"736x","564x","474x","236x","originals"].map(size => { const v = new URL(u.href); v.pathname = `/${size}/${rest}`; return v.href; }));
  } catch { return []; }
}

function downloadCandidates(primary, alternates = []) {
  const initial = uniqueUrls([primary, ...(Array.isArray(alternates) ? alternates : [])]);
  const expanded = [];
  for (const value of initial) expanded.push(value, ...pinterestVariants(value));
  return uniqueUrls(expanded);
}

function requestHeaders(sourcePage = "") {
  const headers = {
    "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    "Accept":"image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,*/*;q=0.8",
    "Accept-Language":"es-CO,es;q=0.9,en;q=0.8"
  };
  try { const ref = new URL(sourcePage); if (["http:","https:"].includes(ref.protocol)) headers.Referer = ref.href; } catch {}
  return headers;
}

async function downloadAndHash(url, alternateUrls = [], sourcePage = "") {
  const errors = [];
  for (const candidate of downloadCandidates(url, alternateUrls)) {
    let response;
    try { response = await fetch(candidate,{redirect:"follow",headers:requestHeaders(sourcePage),signal:AbortSignal.timeout(30000)}); }
    catch (e) { errors.push(`${candidate} -> ${e.name || "ERROR"}`); continue; }
    if (!response.ok || !response.body) { errors.push(`${candidate} -> HTTP ${response.status}`); try { await response.body?.cancel(); } catch {} continue; }
    const mime = response.headers.get("content-type") || "application/octet-stream";
    const temp = path.join(os.tmpdir(),`wmc-${crypto.randomUUID()}.tmp`);
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    const tap = new Transform({transform(chunk,enc,cb){ hash.update(chunk); bytes += chunk.length; cb(null,chunk); }});
    try {
      await pipeline(Readable.fromWeb(response.body),tap,fs.createWriteStream(temp));
      return {temp,sha256:hash.digest("hex"),bytes,mime,finalUrl:response.url || candidate,requestedUrl:url};
    } catch (e) { await fsp.unlink(temp).catch(()=>{}); errors.push(`${candidate} -> ${e.message}`); }
  }
  throw new Error(`No se pudo descargar el recurso. ${errors.slice(0,6).join(" | ")}${errors.length>6?" | ...":""}`);
}


function runFfmpeg(args, { allowNonZero = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("FFmpeg no está disponible en el servidor."));
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", chunk => {
      if (stderr.length < 2_000_000) stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0 || allowNonZero) return resolve({ code, stderr });
      reject(new Error(stderr.trim() || `FFmpeg terminó con código ${code}`));
    });
  });
}

async function probeVideo(tempPath) {
  if (!ffmpegPath) {
    return { available:false, hasVideo:true, hasAudio:false, videoCodec:null, audioCodec:null, raw:"" };
  }
  const { stderr } = await runFfmpeg(["-hide_banner", "-i", tempPath], { allowNonZero:true });
  const video = stderr.match(/Stream #.*?: Video:\s*([a-zA-Z0-9_]+)/i);
  const audio = stderr.match(/Stream #.*?: Audio:\s*([a-zA-Z0-9_]+)/i);
  return {
    available:true,
    hasVideo:Boolean(video),
    hasAudio:Boolean(audio),
    videoCodec:video?.[1]?.toLowerCase() || null,
    audioCodec:audio?.[1]?.toLowerCase() || null,
    raw:stderr
  };
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  await pipeline(
    fs.createReadStream(filePath),
    new Transform({
      transform(chunk, enc, cb) {
        hash.update(chunk);
        bytes += chunk.length;
        cb(null, chunk);
      }
    }),
    new Transform({
      transform(chunk, enc, cb) { cb(); }
    })
  );
  return { sha256:hash.digest("hex"), bytes };
}

async function normalizeVideoForWindows(videoPath, ext, audioPath = "") {
  const probe = await probeVideo(videoPath);
  if (probe.available && !probe.hasVideo) {
    return { skipped:true, reason:"audio-only", probe };
  }

  const videoCodec = probe.videoCodec || "";
  const audioCodec = probe.audioCodec || "";
  const mp4Like = ["mp4","m4v"].includes(String(ext || "").toLowerCase());
  const needsAudioMerge = Boolean(audioPath && probe.available && !probe.hasAudio);
  const compatibleVideo = !probe.available || (mp4Like && videoCodec === "h264");
  const compatibleAudio = !probe.available || !probe.hasAudio || audioCodec === "aac";

  if (compatibleVideo && compatibleAudio && !needsAudioMerge) {
    return { path:videoPath, extension:"mp4", mime:"video/mp4", normalized:false, probe };
  }

  const output = path.join(os.tmpdir(), `wmc-video-${crypto.randomUUID()}.mp4`);
  const args = ["-y","-hide_banner","-loglevel","error","-i",videoPath];
  if (needsAudioMerge) args.push("-i",audioPath);

  args.push("-map","0:v:0");
  if (probe.hasAudio) args.push("-map","0:a:0?");
  else if (needsAudioMerge) args.push("-map","1:a:0?");

  if (videoCodec === "h264") {
    args.push("-c:v","copy");
  } else {
    args.push("-c:v","libx264","-preset","veryfast","-crf","23","-pix_fmt","yuv420p");
  }

  if (probe.hasAudio || needsAudioMerge) {
    if (probe.hasAudio && audioCodec === "aac" && !needsAudioMerge) args.push("-c:a","copy");
    else args.push("-c:a","aac","-b:a","128k");
  }

  args.push("-movflags","+faststart",output);

  try {
    await runFfmpeg(args);
    const stat = await fsp.stat(output);
    if (!stat.size) throw new Error("FFmpeg generó un archivo vacío.");
    return { path:output, extension:"mp4", mime:"video/mp4", normalized:true, probe };
  } catch (error) {
    await fsp.unlink(output).catch(()=>{});
    throw error;
  }
}

function countBytes(buffer, value) { let n=0; for (let i=0;i<buffer.length;i++) if (buffer[i]===value) n++; return n; }
function animationInfo(buffer, ext) {
  if (ext === "gif") { const frames = countBytes(buffer,0x2c); return {animated:frames>1,frameCount:frames || 1}; }
  if (ext === "webp") { const text = buffer.toString("latin1"); const frames = (text.match(/ANMF/g)||[]).length; return {animated:text.includes("ANIM") || frames>1,frameCount:frames || null}; }
  return {animated:false,frameCount:null};
}

function first(meta, keys) { for (const k of keys) if (meta?.[k] !== undefined && meta?.[k] !== null && String(meta[k]).trim() !== "") return meta[k]; return null; }
function rationalText(v) { if (v == null) return null; if (typeof v === "number") return v; if (typeof v === "object" && Number.isFinite(v.numerator) && Number.isFinite(v.denominator) && v.denominator) return v.numerator / v.denominator; return v; }
function gps(meta) {
  const lat = Number(first(meta,["latitude","GPSLatitude"]));
  const lon = Number(first(meta,["longitude","GPSLongitude"]));
  return {latitude:Number.isFinite(lat)?lat:null,longitude:Number.isFinite(lon)?lon:null};
}

async function extractEmbeddedMetadata(tempPath, mime, ext) {
  const result = {parser:"none",parsed:{},summary:{}};
  if (!String(mime).startsWith("image/") && !["jpg","jpeg","png","gif","webp"].includes(ext)) return result;
  const stat = await fsp.stat(tempPath);
  if (stat.size > 80*1024*1024) return {parser:"skipped",parsed:{},summary:{},warning:"Archivo de imagen >80 MB; metadatos profundos omitidos."};
  const buffer = await fsp.readFile(tempPath);
  let meta = {};
  try { meta = await exifr.parse(buffer,true) || {}; } catch (e) { result.warning = e.message; }
  const anim = animationInfo(buffer,ext);
  const g = gps(meta);
  const keywordsRaw = first(meta,["Keywords","Subject","XPKeywords","HierarchicalSubject"]);
  const keywords = Array.isArray(keywordsRaw) ? keywordsRaw : String(keywordsRaw || "").split(/[;,]/).map(x=>x.trim()).filter(Boolean);
  const dateRaw = first(meta,["DateTimeOriginal","CreateDate","DateTimeDigitized","ModifyDate","DateCreated"]);
  result.parser = "exifr";
  result.parsed = meta;
  result.summary = {
    width: Number(first(meta,["ExifImageWidth","ImageWidth","PixelXDimension"])) || null,
    height: Number(first(meta,["ExifImageHeight","ImageHeight","PixelYDimension"])) || null,
    animated: anim.animated,
    frameCount: anim.frameCount,
    title: first(meta,["Title","ObjectName","XPTitle"]),
    description: first(meta,["Description","ImageDescription","CaptionAbstract","XPComment"]),
    creator: first(meta,["Creator","Artist","Byline","XPAuthor"]),
    keywords:[...new Set(keywords)],
    city:first(meta,["City"]),
    country:first(meta,["Country","CountryName","CountryPrimaryLocationName"]),
    locationName:first(meta,["Location","SubLocation","Sublocation"]),
    dateTaken: dateRaw instanceof Date ? dateRaw.toISOString() : (dateRaw ? String(dateRaw) : null),
    cameraMake:first(meta,["Make"]),
    cameraModel:first(meta,["Model"]),
    lensMake:first(meta,["LensMake"]),
    lensModel:first(meta,["LensModel","Lens"]),
    software:first(meta,["Software"]),
    iso:rationalText(first(meta,["ISO","ISOSpeedRatings","PhotographicSensitivity"])),
    aperture:rationalText(first(meta,["FNumber","ApertureValue"])),
    exposure:rationalText(first(meta,["ExposureTime","ShutterSpeedValue"])),
    focalLength:rationalText(first(meta,["FocalLength"])),
    focalLength35mm:rationalText(first(meta,["FocalLengthIn35mmFormat","FocalLengthIn35mmFilm"])),
    orientation:first(meta,["Orientation"]),
    latitude:g.latitude,
    longitude:g.longitude,
    copyright:first(meta,["Copyright","CopyrightNotice"])
  };
  return result;
}

function mergeMetadata(itemMetadata, embedded, technical) {
  const base = itemMetadata && typeof itemMetadata === "object" ? itemMetadata : {};
  return {
    ...base,
    technical:{...(base.technical||{}),...technical},
    embedded:embedded || {},
    exif:{...(base.exif||{}),...(embedded?.summary||{})},
    location:{
      ...(base.location||{}),
      latitude:embedded?.summary?.latitude ?? base.location?.latitude ?? null,
      longitude:embedded?.summary?.longitude ?? base.location?.longitude ?? null,
      city:embedded?.summary?.city ?? base.location?.city ?? null,
      country:embedded?.summary?.country ?? base.location?.country ?? null,
      locationName:embedded?.summary?.locationName ?? base.location?.locationName ?? null
    }
  };
}

async function analyzeOne(item) {
  const canonical = canonicalizeUrl(item.url);
  const dl = await downloadAndHash(canonical,item.alternateUrls || [],item.sourcePage || "");
  try {
    const ext = extFrom(dl.finalUrl || canonical,dl.mime,item.extension);
    const cat = category(ext,dl.mime,item.kind);
    const embedded = await extractEmbeddedMetadata(dl.temp,dl.mime,ext);
    const technical = {sha256:dl.sha256,bytes:dl.bytes,mimeType:dl.mime,extension:ext,category:cat,finalUrl:dl.finalUrl};
    return {url:canonical,ok:true,technical,embedded};
  } finally { await fsp.unlink(dl.temp).catch(()=>{}); }
}

function uniqueZipPath(requested, used) {
  let name=requested,i=2; const ext=path.posix.extname(requested); const base=requested.slice(0,requested.length-ext.length);
  while (used.has(name.toLowerCase())) name=`${base}-${i++}${ext}`;
  used.add(name.toLowerCase()); return name;
}

async function buildZip(candidates) {
  const zipPath = path.join(os.tmpdir(),`web-media-collector-${crypto.randomUUID()}.zip`);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip",{zlib:{level:0}});
  const done = new Promise((resolve,reject)=>{
    output.on("close",resolve);
    output.on("error",reject);
    archive.on("error",reject);
  });
  archive.pipe(output);

  const inventory=[];
  const used=new Set();
  const temps=[];

  for (let i=0;i<candidates.length;i++) {
    const item=candidates[i];
    let canonical="";
    let dl=null;
    try {
      canonical=canonicalizeUrl(item.url);
      dl=await downloadAndHash(canonical,item.alternateUrls || [],item.sourcePage || "");
      temps.push(dl.temp);

      let ext=extFrom(dl.finalUrl || canonical,dl.mime,item.extension);
      let mime=dl.mime;
      let cat=category(ext,mime,item.kind);
      let filePath=dl.temp;
      let sha256=dl.sha256;
      let bytes=dl.bytes;
      let normalized=false;
      let videoProbe=null;

      if (cat === "VIDEO") {
        let audioDl=null;
        if (item.audioUrl) {
          try {
            audioDl=await downloadAndHash(item.audioUrl,[],item.sourcePage || "");
            temps.push(audioDl.temp);
          } catch {}
        }

        const converted=await normalizeVideoForWindows(filePath,ext,audioDl?.temp || "");
        videoProbe=converted.probe || null;

        if (converted.skipped) {
          inventory.push({
            index:i+1,
            url:canonical,
            downloadedUrl:dl.finalUrl || canonical,
            skipped:true,
            reason:"stream de audio sin video",
            category:"VIDEO",
            metadata:item.metadata || {}
          });
          continue;
        }

        if (converted.path !== filePath) temps.push(converted.path);
        filePath=converted.path;
        ext=converted.extension;
        mime=converted.mime;
        normalized=converted.normalized;
        cat="VIDEO";
        const hashed=await hashFile(filePath);
        sha256=hashed.sha256;
        bytes=hashed.bytes;
      }

      const base=cleanName(item.suggestedName) || `recurso-${String(i+1).padStart(4,"0")}`;
      const zipEntry=uniqueZipPath(`${cat}/${String(i+1).padStart(4,"0")} - ${base}.${ext}`,used);
      archive.file(filePath,{name:zipEntry});
      inventory.push({
        index:i+1,
        zipEntry,
        url:canonical,
        downloadedUrl:dl.finalUrl || canonical,
        sha256,
        bytes,
        mimeType:mime,
        extension:ext,
        category:cat,
        normalizedVideo:normalized,
        videoCodec:videoProbe?.videoCodec || null,
        audioCodec:videoProbe?.audioCodec || null,
        hasAudio:videoProbe?.hasAudio ?? null,
        suggestedName:item.suggestedName || null,
        metadata:item.metadata || {}
      });
    } catch (e) {
      inventory.push({
        index:i+1,
        url:canonical || item.url,
        error:e.message,
        metadata:item.metadata || {}
      });
    }
  }

  archive.append(JSON.stringify({
    generatedAt:new Date().toISOString(),
    version:VERSION,
    totalRequested:candidates.length,
    successful:inventory.filter(x=>!x.error && !x.skipped).length,
    skipped:inventory.filter(x=>x.skipped).length,
    failed:inventory.filter(x=>x.error).length,
    items:inventory
  },null,2),{name:"inventario.json"});

  await archive.finalize();
  await done;
  for (const temp of [...new Set(temps)]) await fsp.unlink(temp).catch(()=>{});
  const stat=await fsp.stat(zipPath);
  return {zipPath,inventory,bytes:stat.size};
}

module.exports = {VERSION,canonicalizeUrl,cleanName,normalizeCollectionName,extFrom,category,downloadAndHash,extractEmbeddedMetadata,mergeMetadata,analyzeOne,buildZip};
