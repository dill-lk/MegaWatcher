'use strict';

/* ── Quality levels (auto-generated from one URL) ────────────── */
const QUALITY_LEVELS = [
  { label: 'Original', transcode: null,    title: 'Stream at source quality (full seeking)' },
  { label: '480p',     transcode: '480p',  title: 'Standard quality — saves some data' },
  { label: '360p',     transcode: '360p',  title: 'Lower quality — saves more data' },
  { label: '240p',     transcode: '240p',  title: 'Low quality — saves a lot of data' },
  { label: '144p',     transcode: '144p',  title: 'Minimum quality — saves maximum data' },
];

/* ── State ───────────────────────────────────────────────────── */
let player             = null;   // Video.js instance
let currentQualityIdx  = -1;
let megaUrl            = '';
let subtitleBlobUrls   = [];     // revoke on reset to avoid memory leaks
let subtitleTracks     = [];     // { label, src, srclang } — shared across quality switches

/* ── DOM refs ────────────────────────────────────────────────── */
const megaUrlInput    = document.getElementById('mega-url');
const loadBtn         = document.getElementById('load-btn');
const resetBtn        = document.getElementById('reset-btn');
const statusMsg       = document.getElementById('status-msg');
const linkSection     = document.getElementById('link-section');
const playerSection   = document.getElementById('player-section');
const videoTitleEl    = document.getElementById('video-title');
const videoMetaEl     = document.getElementById('video-meta');
const qualityBar      = document.getElementById('quality-bar');
const transcodeNotice = document.getElementById('transcode-notice');
const speedSelect     = document.getElementById('playback-speed');
const volumeSlider    = document.getElementById('volume-slider');
const volumeDisplay   = document.getElementById('volume-display');
const pipBtn          = document.getElementById('pip-btn');
const fullscreenBtn   = document.getElementById('fullscreen-btn');
const backBtn         = document.getElementById('back-btn');
const subtitleRowsEl  = document.getElementById('subtitle-rows');
const addSubtitleBtn  = document.getElementById('add-subtitle-btn');
const subCount        = document.getElementById('sub-count');

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

/* ── Subtitle rows ───────────────────────────────────────────── */
function updateSubCount() {
  const n = subtitleRowsEl.querySelectorAll('.subtitle-row').length;
  subCount.textContent = n > 0 ? `(${n})` : '';
}

function addSubtitleRow() {
  const row = document.createElement('div');
  row.className = 'subtitle-row';

  const langInput = document.createElement('input');
  langInput.type = 'text';
  langInput.className = 'sub-lang-input';
  langInput.placeholder = 'Language (e.g. English)';
  langInput.setAttribute('aria-label', 'Subtitle language');
  langInput.setAttribute('list', 'lang-list');

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.className = 'sub-file-input';
  fileInput.accept = '.srt,.vtt';
  fileInput.setAttribute('aria-label', 'Subtitle file (.srt or .vtt)');

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-row-btn';
  removeBtn.title = 'Remove';
  removeBtn.innerHTML = '&times;';
  removeBtn.addEventListener('click', () => { row.remove(); updateSubCount(); });

  row.appendChild(langInput);
  row.appendChild(fileInput);
  row.appendChild(removeBtn);
  subtitleRowsEl.appendChild(row);
  updateSubCount();
}

addSubtitleBtn.addEventListener('click', addSubtitleRow);

function readSubtitleRows() {
  return Array.from(subtitleRowsEl.querySelectorAll('.subtitle-row'))
    .map(row => ({
      label: row.querySelector('.sub-lang-input').value.trim() || 'Unknown',
      file:  row.querySelector('.sub-file-input').files[0] || null,
    }))
    .filter(r => r.file !== null);
}

/* ── Attach subtitle text tracks to the player ───────────────── */
function attachSubtitleTracks() {
  if (!player) return;

  // Remove any existing remote text tracks
  Array.from(player.remoteTextTracks()).forEach(t => player.removeRemoteTextTrack(t));

  subtitleTracks.forEach((t, i) => {
    player.addRemoteTextTrack({
      kind:    'subtitles',
      src:     t.src,
      label:   t.label,
      srclang: t.srclang,
      default: i === 0,
    }, false);
  });
}

/* ── Reset ───────────────────────────────────────────────────── */
function resetApp() {
  if (player) { player.dispose(); player = null; }

  // Revoke blob URLs to free memory
  subtitleBlobUrls.forEach(u => URL.revokeObjectURL(u));
  subtitleBlobUrls = [];
  subtitleTracks   = [];

  currentQualityIdx = -1;
  megaUrl = '';
  qualityBar.innerHTML = '';
  transcodeNotice.hidden = true;
  setStatus('');
  playerSection.hidden = true;
  linkSection.hidden = false;
}

resetBtn.addEventListener('click', resetApp);
backBtn.addEventListener('click', resetApp);

/* ── Load & play ─────────────────────────────────────────────── */
loadBtn.addEventListener('click', async () => {
  const url = megaUrlInput.value.trim();

  if (!url) {
    setStatus('Please enter a Mega.nz link.', 'error');
    return;
  }

  if (!isMegaUrl(url)) {
    megaUrlInput.classList.add('error');
    setStatus('This does not look like a Mega.nz link. Please check it.', 'error');
    return;
  }

  megaUrlInput.classList.remove('error');
  loadBtn.disabled = true;
  setStatus('<span class="spinner"></span>Loading video info…', 'loading');

  try {
    const resp = await fetch('/api/mega-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Unknown error');

    megaUrl = url;
    setStatus('');
    showPlayer(data);
  } catch (err) {
    setStatus(`Failed to load: ${err.message}`, 'error');
  } finally {
    loadBtn.disabled = false;
  }
});

/* ── Show player ─────────────────────────────────────────────── */
function showPlayer(info) {
  linkSection.hidden = true;
  playerSection.hidden = false;

  videoTitleEl.textContent = info.name || 'Video';
  videoMetaEl.textContent  = info.size ? formatBytes(info.size) : '';

  // Build quality buttons
  qualityBar.innerHTML = '';
  QUALITY_LEVELS.forEach((q, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quality-btn';
    btn.textContent = q.label;
    btn.title = q.title;
    btn.addEventListener('click', () => switchQuality(i));
    qualityBar.appendChild(btn);
  });

  // Build subtitle blob URLs from uploaded files
  subtitleBlobUrls.forEach(u => URL.revokeObjectURL(u));
  subtitleBlobUrls = [];

  subtitleTracks = readSubtitleRows().map(r => {
    const blobUrl = URL.createObjectURL(r.file);
    subtitleBlobUrls.push(blobUrl);
    const srclang = LANG_CODES[r.label.toLowerCase()] || 'und';
    return { label: r.label, src: blobUrl, srclang };
  });

  // Init (or re-init) Video.js
  if (player) player.dispose();
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

  player.volume(parseFloat(volumeSlider.value));

  // Start at Original quality
  switchQuality(0);
}

/* ── Quality switching ───────────────────────────────────────── */
function switchQuality(index) {
  if (!player || index === currentQualityIdx) return;

  const q = QUALITY_LEVELS[index];
  const currentTime = currentQualityIdx >= 0 ? player.currentTime() : 0;
  const wasPaused   = currentQualityIdx >= 0 ? player.paused() : false;

  currentQualityIdx = index;

  // Highlight active button
  document.querySelectorAll('.quality-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === index);
  });

  // Show transcoding notice for non-original qualities
  transcodeNotice.hidden = !q.transcode;

  // Build stream URL
  let streamUrl = `/api/stream?url=${encodeURIComponent(megaUrl)}`;
  if (q.transcode) streamUrl += `&transcode=${q.transcode}`;

  player.src({ src: streamUrl, type: 'video/mp4' });

  player.one('loadedmetadata', () => {
    if (currentTime > 0) player.currentTime(currentTime);
    if (!wasPaused) player.play();
    attachSubtitleTracks();
  });

  player.load();
}

/* ── Language code map (label → BCP-47 tag) ─────────────────── */
const LANG_CODES = {
  english:    'en', arabic:     'ar', french:     'fr', spanish:    'es',
  german:     'de', chinese:    'zh', japanese:   'ja', korean:     'ko',
  portuguese: 'pt', russian:    'ru', italian:    'it', turkish:    'tr',
  hindi:      'hi', dutch:      'nl', polish:     'pl', swedish:    'sv',
  indonesian: 'id', vietnamese: 'vi',
};

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
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await videoEl.requestPictureInPicture();
    } catch (e) { console.warn('PiP error:', e); }
  } else {
    alert('Picture-in-Picture is not supported by your browser.');
  }
});

fullscreenBtn.addEventListener('click', () => {
  if (player) player.requestFullscreen();
});
