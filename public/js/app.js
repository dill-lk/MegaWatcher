'use strict';

/* ── Constants ───────────────────────────────────────────────── */
const DEFAULT_QUALITIES = [
  { label: '1080p', url: '' },
  { label: '720p',  url: '' },
  { label: '480p',  url: '' },
  { label: '360p',  url: '' },
];

/* ── State ───────────────────────────────────────────────────── */
let player = null;          // Video.js instance
let currentQualityIndex = -1;
let qualities = [];         // [{ label, url, streamUrl, name, size }]

/* ── DOM refs ────────────────────────────────────────────────── */
const qualityRowsEl  = document.getElementById('quality-rows');
const addQualityBtn  = document.getElementById('add-quality-btn');
const loadBtn        = document.getElementById('load-btn');
const resetBtn       = document.getElementById('reset-btn');
const statusMsg      = document.getElementById('status-msg');
const linkSection    = document.getElementById('link-section');
const playerSection  = document.getElementById('player-section');
const videoTitleEl   = document.getElementById('video-title');
const videoMetaEl    = document.getElementById('video-meta');
const qualityBar     = document.getElementById('quality-bar');
const speedSelect    = document.getElementById('playback-speed');
const volumeSlider   = document.getElementById('volume-slider');
const volumeDisplay  = document.getElementById('volume-display');
const pipBtn         = document.getElementById('pip-btn');
const fullscreenBtn  = document.getElementById('fullscreen-btn');
const backBtn        = document.getElementById('back-btn');

/* ── Helpers ─────────────────────────────────────────────────── */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function setStatus(msg, type = '') {
  statusMsg.innerHTML = msg;
  statusMsg.className = `status-msg ${type}`;
}

function isMegaUrl(url) {
  return /^https?:\/\/(www\.)?mega\.nz\/(file|folder|#)/.test(url.trim());
}

/* ── Quality row builder ─────────────────────────────────────── */
function buildQualityRow(label = '', url = '', index = 0) {
  const row = document.createElement('div');
  row.className = 'quality-row';
  row.dataset.index = index;

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'quality-label-input';
  labelInput.placeholder = 'Label';
  labelInput.value = label;
  labelInput.setAttribute('aria-label', 'Quality label');

  const urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.className = 'quality-url-input';
  urlInput.placeholder = 'https://mega.nz/file/…';
  urlInput.value = url;
  urlInput.setAttribute('aria-label', 'Mega URL');

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-row-btn';
  removeBtn.title = 'Remove this quality';
  removeBtn.innerHTML = '&times;';
  removeBtn.addEventListener('click', () => {
    row.remove();
    reindexRows();
  });

  row.appendChild(labelInput);
  row.appendChild(urlInput);
  row.appendChild(removeBtn);
  return row;
}

function reindexRows() {
  document.querySelectorAll('.quality-row').forEach((row, i) => {
    row.dataset.index = i;
  });
}

function addRow(label = '', url = '') {
  const rows = document.querySelectorAll('.quality-row');
  qualityRowsEl.appendChild(buildQualityRow(label, url, rows.length));
}

function readRows() {
  return Array.from(document.querySelectorAll('.quality-row')).map(row => ({
    label: row.querySelector('.quality-label-input').value.trim(),
    url:   row.querySelector('.quality-url-input').value.trim(),
  }));
}

/* ── Initialise default rows ─────────────────────────────────── */
DEFAULT_QUALITIES.forEach(q => addRow(q.label, q.url));

/* ── Add quality button ──────────────────────────────────────── */
addQualityBtn.addEventListener('click', () => addRow('Custom', ''));

/* ── Reset ───────────────────────────────────────────────────── */
function resetApp() {
  if (player) { player.dispose(); player = null; }
  qualities = [];
  currentQualityIndex = -1;
  qualityBar.innerHTML = '';
  setStatus('');
  playerSection.hidden = true;
  linkSection.hidden = false;
}

resetBtn.addEventListener('click', resetApp);
backBtn.addEventListener('click', resetApp);

/* ── Load & play ─────────────────────────────────────────────── */
loadBtn.addEventListener('click', async () => {
  const rows = readRows().filter(r => r.url !== '');

  if (rows.length === 0) {
    setStatus('Please enter at least one Mega link.', 'error');
    return;
  }

  // Validate URLs
  let valid = true;
  document.querySelectorAll('.quality-url-input').forEach(input => {
    const val = input.value.trim();
    if (val && !isMegaUrl(val)) {
      input.classList.add('error');
      valid = false;
    } else {
      input.classList.remove('error');
    }
  });

  if (!valid) {
    setStatus('One or more URLs do not look like Mega.nz links. Please check them.', 'error');
    return;
  }

  loadBtn.disabled = true;
  setStatus('<span class="spinner"></span>Loading video info…', 'loading');

  // Fetch file metadata for each non-empty row in parallel
  const results = await Promise.all(
    rows.map(async row => {
      try {
        const resp = await fetch('/api/mega-info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: row.url }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Unknown error');
        return { ...row, name: data.name, size: data.size, error: null };
      } catch (err) {
        return { ...row, name: null, size: null, error: err.message };
      }
    })
  );

  loadBtn.disabled = false;

  const errors = results.filter(r => r.error);
  if (errors.length > 0) {
    setStatus(
      `Failed to load ${errors.length} link(s):<br>${errors.map(e => `• ${e.label}: ${e.error}`).join('<br>')}`,
      'error'
    );
    return;
  }

  qualities = results.map(r => ({
    ...r,
    streamUrl: `/api/stream?url=${encodeURIComponent(r.url)}`,
  }));

  setStatus('');
  showPlayer();
});

/* ── Show player ─────────────────────────────────────────────── */
function showPlayer() {
  linkSection.hidden = true;
  playerSection.hidden = false;

  // Title & meta from the first (highest) quality
  const primary = qualities[0];
  videoTitleEl.textContent = primary.name || 'Video';
  videoMetaEl.textContent  = primary.size ? formatBytes(primary.size) : '';

  // Build quality bar
  qualityBar.innerHTML = '';
  qualities.forEach((q, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quality-btn';
    btn.textContent = q.label || `Source ${i + 1}`;
    btn.addEventListener('click', () => switchQuality(i));
    qualityBar.appendChild(btn);
  });

  // Init Video.js player
  if (player) { player.dispose(); }
  player = videojs('mega-player', {
    controls: true,
    preload: 'metadata',
    fluid: true,
    playbackRates: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2],
    html5: {
      vhs: { overrideNative: true },
      nativeAudioTracks: false,
      nativeVideoTracks: false,
    },
  });

  // Set initial volume from slider
  player.volume(parseFloat(volumeSlider.value));

  // Load the first quality
  switchQuality(0);
}

/* ── Quality switching ───────────────────────────────────────── */
function switchQuality(index) {
  if (!player || index === currentQualityIndex) return;

  const q = qualities[index];
  const currentTime = currentQualityIndex >= 0 ? player.currentTime() : 0;
  const wasPaused   = currentQualityIndex >= 0 ? player.paused() : false;

  currentQualityIndex = index;

  // Update active button
  document.querySelectorAll('.quality-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === index);
  });

  // Update video source
  player.src({ src: q.streamUrl, type: 'video/mp4' });

  // Restore playback position after metadata loads
  player.one('loadedmetadata', () => {
    if (currentTime > 0) player.currentTime(currentTime);
    if (!wasPaused) player.play();
  });

  player.load();
}

/* ── Extra controls ──────────────────────────────────────────── */
speedSelect.addEventListener('change', () => {
  if (player) player.playbackRate(parseFloat(speedSelect.value));
});

volumeSlider.addEventListener('input', () => {
  const vol = parseFloat(volumeSlider.value);
  if (player) player.volume(vol);
  volumeDisplay.textContent = `${Math.round(vol * 100)}%`;
});

pipBtn.addEventListener('click', async () => {
  const videoEl = document.getElementById('mega-player_html5_api')
                  || document.querySelector('#mega-player video');
  if (videoEl && document.pictureInPictureEnabled) {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await videoEl.requestPictureInPicture();
      }
    } catch (e) {
      console.warn('PiP error:', e);
    }
  } else {
    alert('Picture-in-Picture is not supported by your browser.');
  }
});

fullscreenBtn.addEventListener('click', () => {
  if (player) player.requestFullscreen();
});
