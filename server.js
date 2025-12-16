// server.js
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const PROVIDED_FILE = path.join(DATA_DIR, 'provided.txt');
const LOGS_FILE = path.join(DATA_DIR, 'logs.txt');
const PUBLIC_DIR = path.join(__dirname, 'public');

async function ensureDataFiles(){
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { await fs.access(PROVIDED_FILE); } catch(e){ await fs.writeFile(PROVIDED_FILE, '', 'utf8'); }
  try { await fs.access(LOGS_FILE); } catch(e){ await fs.writeFile(LOGS_FILE, '', 'utf8'); }
}

async function readProvidedSet(){
  await ensureDataFiles();
  const txt = await fs.readFile(PROVIDED_FILE, 'utf8');
  const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return new Set(lines);
}

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
  Simple in-process claim lock to avoid races while running a single process.
  If you use multiple instances/processes, migrate to a DB (Postgres/Redis/SQLite).
*/
let claimLock = Promise.resolve();

app.use(express.static(PUBLIC_DIR));

// serve logs and provided (from data folder)
app.get('/logs.txt', async (req, res) => {
  await ensureDataFiles();
  res.sendFile(LOGS_FILE);
});

app.get('/provided.txt', async (req, res) => {
  await ensureDataFiles();
  res.sendFile(PROVIDED_FILE);
});

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
  returns: { claimed: [...], rejected: [...] }
  Server atomically claims lines and appends them to provided.txt.
*/
app.post('/claim', async (req, res) => {
  const candidates = Array.isArray(req.body.lines) ? req.body.lines.map(s => String(s).trim()).filter(Boolean) : [];
  const limit = Math.max(0, Number(req.body.limit) || candidates.length);
  if(candidates.length === 0){
    return res.json({ claimed: [], rejected: [] });
  }

  // serialize claim operations
  claimLock = claimLock.then(async () => {
    try{
      const providedSet = await readProvidedSet();
      const claimed = [];
      const rejected = [];

      for(const c of candidates){
        if(claimed.length >= limit){
          // cannot claim more (respect limit); put the rest into rejected
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