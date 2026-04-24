'use strict';

const express = require('express');
const { File } = require('megajs');
const path = require('path');
const { spawn } = require('child_process');
const rateLimit = require('express-rate-limit');

// Supported transcode resolutions (height in pixels)
const TRANSCODE_HEIGHTS = { '480p': 480, '360p': 360, '240p': 240, '144p': 144 };

// Limit stream requests to prevent runaway ffmpeg processes
const streamLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 20,              // max 20 stream requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many stream requests — please wait a moment.' },
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/**
 * POST /api/mega-info
 * Body: { url: "https://mega.nz/file/..." }
 * Returns: { name, size }
 */
app.post('/api/mega-info', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A Mega URL is required.' });
  }

  try {
    const file = File.fromURL(url.trim());
    await file.loadAttributes();
    res.json({
      name: file.name,
      size: file.size,
    });
  } catch (err) {
    res.status(400).json({ error: `Failed to load Mega file: ${err.message}` });
  }
});

/**
 * GET /api/stream?url=<encoded mega url>[&transcode=480p|360p|240p|144p]
 *
 * Without `transcode`: streams the original file with HTTP Range support
 * (enables seeking in the player).
 *
 * With `transcode`: pipes Mega → ffmpeg → client in a fragmented MP4 stream
 * at the requested height. Range requests are not honoured in this mode
 * because the output size is unknown before encoding completes.
 */
app.get('/api/stream', streamLimiter, async (req, res) => {
  const { url, transcode } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A Mega URL is required.' });
  }

  let file;
  try {
    file = File.fromURL(decodeURIComponent(url));
    await file.loadAttributes();
  } catch (err) {
    return res.status(400).json({ error: `Failed to load Mega file: ${err.message}` });
  }

  // ── Transcoded mode (ffmpeg) ────────────────────────────────────────────
  if (transcode && TRANSCODE_HEIGHTS[transcode]) {
    const height = TRANSCODE_HEIGHTS[transcode];

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-cache',
    });

    const megaStream = file.download();
    const ff = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-vf', `scale=-2:${height}`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });

    megaStream.pipe(ff.stdin);
    ff.stdout.pipe(res);

    const killFf = () => {
      try {
        ff.kill('SIGTERM');
        setTimeout(() => { try { ff.kill('SIGKILL'); } catch (_) {} }, 3000);
      } catch (_) {}
    };
    res.on('close', killFf);
    ff.on('error', killFf);
    megaStream.on('error', () => { killFf(); if (!res.writableEnded) res.end(); });
    return;
  }

  // ── Direct stream (with HTTP Range support) ─────────────────────────────
  const fileSize = file.size;
  const rangeHeader = req.headers.range;

  // Derive a sensible Content-Type from the file name
  const name = (file.name || '').toLowerCase();
  let contentType = 'video/mp4';
  if (name.endsWith('.mkv')) contentType = 'video/x-matroska';
  else if (name.endsWith('.webm')) contentType = 'video/webm';
  else if (name.endsWith('.avi')) contentType = 'video/x-msvideo';
  else if (name.endsWith('.mov')) contentType = 'video/quicktime';

  try {
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).end();
      }

      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });

      const stream = file.download({ start, end });
      stream.on('error', () => res.end());
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
      });

      const stream = file.download();
      stream.on('error', () => res.end());
      stream.pipe(res);
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: `Streaming error: ${err.message}` });
    }
  }
});

app.listen(PORT, () => {
  console.log(`MegaWatcher is running → http://localhost:${PORT}`);
});
