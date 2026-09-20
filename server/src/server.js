import express from 'express';
import cors from 'cors';
import { canonicalizeUrl } from './dedupe.js';
import { config } from './config.js';

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

// Foundation API. Database/Drive adapters are wired after credentials are configured.
const seenUrls = new Map();

app.get('/api/health', (_req,res) => res.json({ok:true, service:'web-media-collector', driveRoot:config.drive.root}));

app.post('/api/ingest/check', (req,res) => {
  try {
    const canonicalUrl = canonicalizeUrl(req.body.url);
    const prior = seenUrls.get(canonicalUrl);
    res.json({ canonicalUrl, status: prior ? 'DUPLICATE_URL' : 'NEW', assetId: prior || null });
  } catch {
    res.status(400).json({error:'INVALID_URL'});
  }
});

app.post('/api/ingest/candidates', (req,res) => {
  const candidates = Array.isArray(req.body.candidates) ? req.body.candidates : [];
  const results = candidates.map((item) => {
    try {
      const canonicalUrl = canonicalizeUrl(item.url);
      const duplicate = seenUrls.has(canonicalUrl);
      if (!duplicate) seenUrls.set(canonicalUrl, null);
      return {url:item.url, canonicalUrl, status:duplicate?'DUPLICATE_URL':'QUEUED'};
    } catch {
      return {url:item.url, status:'INVALID_URL'};
    }
  });
  res.json({received:candidates.length, results});
});

app.get('/api/assets', (_req,res) => res.json({items:[], total:0, note:'Catalog database adapter pending credentials.'}));

app.listen(config.port, '127.0.0.1', () => console.log(`Web Media Collector API: http://127.0.0.1:${config.port}`));
