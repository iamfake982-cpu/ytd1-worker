import express from 'express';
import { spawn } from 'child_process';
import { mkdirSync, statSync, createReadStream, existsSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import PQueue from 'p-queue';

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.WORKER_TOKEN;
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || '';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '2', 10);
const COOKIES_PATH = process.env.YTDLP_COOKIES_PATH || '/tmp/ytdlp-cookies.txt';

if (!TOKEN) { console.error('WORKER_TOKEN env var is required'); process.exit(1); }
mkdirSync(DATA_DIR, { recursive: true });

if (process.env.YTDLP_COOKIES) {
  const raw = process.env.YTDLP_COOKIES.trim();
  const cookieText = raw.startsWith('# Netscape') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  writeFileSync(COOKIES_PATH, cookieText, { mode: 0o600 });
}

const app = express();
app.use(express.json({ limit: '1mb' }));
const queue = new PQueue({ concurrency: CONCURRENCY });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (h !== `Bearer ${TOKEN}`) return res.status(401).json({ error: 'unauthorized' });
  next();
}

async function postBack(webhookUrl, webhookToken, body) {
  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${webhookToken}` },
      body: JSON.stringify(body),
    });
    return await r.json().catch(() => ({}));
  } catch (e) { console.error('webhook fail', e); return {}; }
}

function trimLog(text, max = 1400) {
  return text.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim().slice(-max);
}

function ytdlpBaseArgs(url, outTpl) {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--progress',
    '--restrict-filenames',
    '--force-ipv4',
    '--retries', '5',
    '--fragment-retries', '5',
    '--retry-sleep', 'linear=1::5',
    '-o', outTpl,
  ];
  if (existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
  if (/music\.youtube\./i.test(url)) {
    args.push('--extractor-args', 'youtube:player_client=web_music,web');
  }
  return args;
}

function ytdlpArgs(url, format, outTpl) {
  const base = ytdlpBaseArgs(url, outTpl);
  if (format === 'mp3') {
    return [...base, '-f', 'ba/bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      '--embed-thumbnail', '--add-metadata', url];
  }
  if (format === 'mp4_720') {
    return [...base, '-f', 'bv*[height<=720]+ba/b[height<=720]', '--merge-output-format', 'mp4', url];
  }
  return [...base, '-f', 'bv*+ba/b', '--merge-output-format', 'mp4', url];
}

function metadataArgs(url) {
  const args = ['--no-playlist', '--dump-single-json', '--no-warnings', '--force-ipv4'];
  if (existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
  if (/music\.youtube\./i.test(url)) args.push('--extractor-args', 'youtube:player_client=web_music,web');
  args.push(url);
  return args;
}

function playlistArgs(url, playlistLimit) {
  const args = ['--flat-playlist', '--dump-json', '--no-warnings', '--force-ipv4'];
  if (existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
  if (/music\.youtube\./i.test(url)) args.push('--extractor-args', 'youtube:player_client=web_music,web');
  if (playlistLimit) args.push('--playlist-end', String(playlistLimit));
  args.push(url);
  return args;
}

function runJob({ jobId, url, format, webhookUrl, webhookToken }) {
  return new Promise((resolve) => {
    const jobDir = join(DATA_DIR, jobId);
    mkdirSync(jobDir, { recursive: true });
    const outTpl = join(jobDir, '%(title).180B.%(ext)s');
    const args = ytdlpArgs(url, format, outTpl);

    postBack(webhookUrl, webhookToken, { jobId, status: 'downloading', progress: 0 });

    const proc = spawn('yt-dlp', args);
    let meta = {};
    let lastProgress = 0;
    let stderr = '';

    const metaProc = spawn('yt-dlp', metadataArgs(url));
    let metaBuf = '';
    metaProc.stdout.on('data', (d) => (metaBuf += d.toString()));
    metaProc.on('close', () => {
      try {
        const j = JSON.parse(metaBuf);
        meta = {
          title: j.title, artist: j.artist || j.uploader,
          duration_seconds: j.duration ? Math.round(j.duration) : undefined,
          thumbnail_url: j.thumbnail,
        };
        postBack(webhookUrl, webhookToken, { jobId, ...meta });
      } catch {}
    });

    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      const m = s.match(/\[download\]\s+(\d+\.\d+)%/);
      if (m) {
        const p = Math.min(99, parseFloat(m[1]));
        if (p - lastProgress >= 2) {
          lastProgress = p;
          postBack(webhookUrl, webhookToken, { jobId, status: 'downloading', progress: p });
        }
      }
      if (s.includes('[ExtractAudio]') || s.includes('[Merger]')) {
        postBack(webhookUrl, webhookToken, { jobId, status: 'converting', progress: 99 });
      }
    });
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      console.error(s);
    });

    proc.on('error', (err) => {
      postBack(webhookUrl, webhookToken, { jobId, status: 'error', error_message: `Failed to start yt-dlp: ${err.message}` });
      resolve();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const detail = trimLog(stderr) || `yt-dlp exited ${code}`;
        postBack(webhookUrl, webhookToken, { jobId, status: 'error', error_message: detail });
        return resolve();
      }
      const files = readdirSync(jobDir);
      const file = files.find(f => f.endsWith('.mp3') || f.endsWith('.mp4') || f.endsWith('.m4a') || f.endsWith('.webm')) || files[0];
      if (!file) {
        postBack(webhookUrl, webhookToken, { jobId, status: 'error', error_message: 'No output file' });
        return resolve();
      }
      const full = join(jobDir, file);
      const size = statSync(full).size;
      const base = PUBLIC_BASE || '';
      const file_url = `${base}/files/${jobId}/${encodeURIComponent(file)}`;
      postBack(webhookUrl, webhookToken, {
        jobId, status: 'done', progress: 100,
        file_url, file_size_bytes: size, ...meta,
      });
      resolve();
    });
  });
}

async function runPlaylist({ jobId, url, format, playlistLimit, webhookUrl, webhookToken }) {
  postBack(webhookUrl, webhookToken, { jobId, status: 'downloading', progress: 0, is_playlist: true });

  const proc = spawn('yt-dlp', playlistArgs(url, playlistLimit));
  let buf = '';
  let stderr = '';
  const items = [];
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        const childUrl = j.url && j.url.startsWith('http')
          ? j.url
          : `https://www.youtube.com/watch?v=${j.id}`;
        items.push({ url: childUrl, title: j.title });
      } catch {}
    }
  });
  proc.stderr.on('data', (d) => {
    const s = d.toString();
    stderr += s;
    console.error(s);
  });

  const code = await new Promise((res) => proc.on('close', res));
  if (code !== 0) {
    return postBack(webhookUrl, webhookToken, { jobId, status: 'error', error_message: trimLog(stderr) || `yt-dlp exited ${code}` });
  }

  if (!items.length) {
    return postBack(webhookUrl, webhookToken, { jobId, status: 'error', error_message: 'Playlist enumeration returned no items' });
  }

  postBack(webhookUrl, webhookToken, {
    jobId, playlist_total: items.length, title: `Playlist (${items.length} tracks)`,
  });

  for (const item of items) {
    const r = await postBack(webhookUrl, webhookToken, {
      jobId, child: { source_url: item.url, title: item.title },
    });
    if (r?.childId) {
      queue.add(() => runJob({
        jobId: r.childId, url: item.url, format, webhookUrl, webhookToken,
      }));
    }
  }

  postBack(webhookUrl, webhookToken, { jobId, status: 'done', progress: 100 });
}

app.post('/jobs', auth, (req, res) => {
  const { jobId, url, format, playlist, playlistLimit, webhookUrl, webhookToken } = req.body || {};
  if (!jobId || !url || !webhookUrl || !webhookToken) return res.status(400).json({ error: 'bad request' });
  if (playlist) {
    queue.add(() => runPlaylist({ jobId, url, format: format || 'mp3', playlistLimit, webhookUrl, webhookToken }));
  } else {
    queue.add(() => runJob({ jobId, url, format: format || 'mp3', webhookUrl, webhookToken }));
  }
  res.json({ accepted: true, queueSize: queue.size });
});

app.get('/files/:jobId/:name', (req, res) => {
  const { jobId, name } = req.params;
  const p = join(DATA_DIR, jobId, decodeURIComponent(name));
  if (!existsSync(p)) return res.status(404).end();
  res.setHeader('Content-Disposition', `attachment; filename="${decodeURIComponent(name)}"`);
  createReadStream(p).pipe(res);
});

app.delete('/jobs/:jobId', auth, (req, res) => {
  const dir = join(DATA_DIR, req.params.jobId);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) unlinkSync(join(dir, f));
  }
  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ ok: true, queue: queue.size, cookies: existsSync(COOKIES_PATH) }));

app.listen(PORT, () => console.log(`worker listening on :${PORT}`));
