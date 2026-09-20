const scanBtn=document.querySelector("#scan");
const copyBtn=document.querySelector("#copy");
const results=document.querySelector("#results");
const status=document.querySelector("#status");
const count=document.querySelector("#count");
const pinimgOnly=document.querySelector("#pinimgOnly");
let urls=[];

function normalize(value){
  if(!value) return null;
  try{
    const u=new URL(value,location.href);
    return /^https?:$/.test(u.protocol)?u.href:null;
  }catch{return null}
}

function collectImages(){
  const found=new Set();
  const add=v=>{const u=normalize(v);if(u)found.add(u)};
  document.querySelectorAll("img").forEach(img=>{
    add(img.currentSrc); add(img.src);
    if(img.srcset){
      img.srcset.split(",").forEach(part=>add(part.trim().split(/\s+/)[0]));
    }
  });
  document.querySelectorAll("*").forEach(el=>{
    const bg=getComputedStyle(el).backgroundImage;
    if(bg&&bg!=="none"){
      [...bg.matchAll(/url\(["']?(.*?)["']?\)/g)].forEach(m=>add(m[1]));
    }
  });
  return [...found];
}

function render(){
  const filtered=pinimgOnly.checked?urls.filter(u=>{
    try{return new URL(u).hostname.endsWith("pinimg.com")}catch{return false}
  }):urls;
  count.textContent=filtered.length;
  copyBtn.disabled=!filtered.length;
  results.innerHTML="";
  filtered.forEach(url=>{
    const row=document.createElement("div"); row.className="item";
    const img=document.createElement("img"); img.className="thumb"; img.src=url; img.alt="";
    const text=document.createElement("div"); text.className="url"; text.textContent=url;
    const btn=document.createElement("button"); btn.className="mini"; btn.textContent="Copiar";
    btn.addEventListener("click",async()=>{await navigator.clipboard.writeText(url);btn.textContent="✓";setTimeout(()=>btn.textContent="Copiar",900)});
    row.append(img,text,btn); results.append(row);
  });
  status.textContent=filtered.length?filtered.length+" URL(s) únicas detectadas.":"No se detectaron imágenes con el filtro actual.";
}

scanBtn.addEventListener("click",async()=>{
  status.textContent="Escaneando…";
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:collectImages});
    urls=[...new Set(result)];
    render();
  }catch(e){
    status.textContent="No se pudo leer esta pestaña: "+e.message;
  }
});

copyBtn.addEventListener("click",async()=>{
  const filtered=pinimgOnly.checked?urls.filter(u=>{try{return new URL(u).hostname.endsWith("pinimg.com")}catch{return false}}):urls;
  await navigator.clipboard.writeText(filtered.join("\n"));
  status.textContent=filtered.length+" URL(s) copiadas al portapapeles.";
});
pinimgOnly.addEventListener("change",render);
