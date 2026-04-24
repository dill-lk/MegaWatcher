'use strict';

const express = require('express');
const { File } = require('megajs');
const path = require('path');

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
 * GET /api/stream?url=<encoded mega url>
 * Streams the Mega file to the client, supporting HTTP Range requests for
 * seek / quality-switching behaviour in the video player.
 */
app.get('/api/stream', async (req, res) => {
  const { url } = req.query;

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
