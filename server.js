// server.js
const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PROVIDED_FILE = path.join(DATA_DIR, 'provided.txt');
const LOGS_FILE = path.join(DATA_DIR, 'logs.txt');
const KEYS_FILE = path.join(DATA_DIR, 'keys.txt');
const PUBLIC_DIR = path.join(ROOT, 'public');

// Create data folder and default files if missing
async function ensureDataFiles(){
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch(e) {
    // ignore
  }
  // create files only if they don't exist
  if(!fsSync.existsSync(PROVIDED_FILE)) await fs.writeFile(PROVIDED_FILE, '', 'utf8');
  if(!fsSync.existsSync(LOGS_FILE)) {
    // sample logs
    const sample = [
      '2025-12-01 error user@example.com failed login from 1.2.3.4',
      '2025-12-02 info user2@example.com purchased item #123',
      '2025-12-03 warn suspicious access to admin panel',
      '2025-12-05 error payment failed invoice 987'
    ].join('\n') + '\n';
    await fs.writeFile(LOGS_FILE, sample, 'utf8');
  }
  if(!fsSync.existsSync(KEYS_FILE)) {
    // sample key format: key|YYYY-MM-DD
    const sampleKeys = [
      'dev-key-123|2026-01-01',
      'testkey-xyz|2026-06-30'
    ].join('\n') + '\n';
    await fs.writeFile(KEYS_FILE, sampleKeys, 'utf8');
  }
}

// Read provided file into a Set
async function readProvidedSet(){
  await ensureDataFiles();
  const txt = await fs.readFile(PROVIDED_FILE, 'utf8');
  const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return new Set(lines);
}

// Append new lines to provided file
async function appendProvidedLines(lines){
  if(!Array.isArray(lines) || lines.length === 0) return 0;
  await ensureDataFiles();
  const unique = Array.from(new Set(lines.map(s => String(s).trim()).filter(Boolean)));
  if(unique.length === 0) return 0;
  const toWrite = unique.join('\n') + '\n';
  await fs.appendFile(PROVIDED_FILE, toWrite, 'utf8');
  return unique.length;
}

/*
  Simple in-process serialisation lock for /claim.
  If you horizontally scale to multiple instances, use a central DB
  (Postgres/Redis) to guarantee atomic claims across instances.
*/
let claimLock = Promise.resolve();

// serve static client
app.use(express.static(PUBLIC_DIR));

// expose logs & provided & keys
app.get('/logs.txt', async (req, res) => {
  await ensureDataFiles();
  res.sendFile(LOGS_FILE);
});
app.get('/provided.txt', async (req, res) => {
  await ensureDataFiles();
  res.sendFile(PROVIDED_FILE);
});
// WARNING: this serves keys publicly. For production, prefer env vars or server-side validation.
app.get('/keys.txt', async (req, res) => {
  try{
    await ensureDataFiles();
    res.sendFile(KEYS_FILE);
  }catch(e){
    res.status(404).send('');
  }
});

// append endpoint (best-effort)
app.post('/provided_append', async (req, res) => {
  try{
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    const added = await appendProvidedLines(lines);
    res.json({ ok:true, added });
  }catch(err){
    console.error(err);
    res.status(500).json({ ok:false, error: String(err) });
  }
});

/*
  POST /claim
  body: { lines: [...], limit?: number }
  returns { claimed: [...], rejected: [...] }
*/
app.post('/claim', async (req, res) => {
  const candidates = Array.isArray(req.body.lines) ? req.body.lines.map(s => String(s).trim()).filter(Boolean) : [];
  const limit = Math.max(0, Number(req.body.limit) || candidates.length);

  if(candidates.length === 0){
    return res.json({ claimed: [], rejected: [] });
  }

  claimLock = claimLock.then(async () => {
    try{
      const providedSet = await readProvidedSet();
      const claimed = [];
      const rejected = [];

      for(const c of candidates){
        if(claimed.length >= limit){
          // exceed limit: treat as rejected for this call
          rejected.push(c);
          continue;
        }
        if(providedSet.has(c)){
          rejected.push(c);
        } else {
          providedSet.add(c);
          claimed.push(c);
        }
      }

      if(claimed.length > 0){
        await appendProvidedLines(claimed);
      }

      return { claimed, rejected };
    }catch(err){
      console.error('Claim error', err);
      return { claimed: [], rejected: candidates, error: String(err) };
    }
  });

  try{
    const result = await claimLock;
    if(result && Array.isArray(result.claimed) && Array.isArray(result.rejected)){
      res.json(result);
    } else {
      res.json({ claimed: [], rejected: candidates });
    }
  }catch(err){
    console.error('Claim final error', err);
    res.status(500).json({ claimed: [], rejected: candidates, error: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await ensureDataFiles();
  console.log(`Server listening on port ${PORT}`);
});
