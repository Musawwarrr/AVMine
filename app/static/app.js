'use strict';

/* AVMine — front-end controller */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  settings: null,
  defaults: null,
  health: null,
  dataDir: '',
  mode: 'video',
  cards: new Map(),
  dismissed: new Set(),
  history: [],
  filter: 'all',
  query: '',
  previewData: null,
  analyzedUrl: '',
  analyzeTimer: null,
  analyzeAbort: null,
  analyzeToken: 0,
  pollTimer: null,
  polling: false,
  jobsInitialized: false,
  historyToken: 0,
  menuItems: [],
  confirmResolve: null,
  modals: new Set(),
};

const TOAST_TYPES = {
  success: { icon: 'check', title: 'Done' },
  error: { icon: 'alert', title: 'Something went wrong' },
  warn: { icon: 'alert', title: 'Heads up' },
  info: { icon: 'info', title: 'AVMine' },
};

/* ------------------------------------------------------------------ helpers */

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function parseUrls(text) {
  const source = String(text || '');
  let matches = source.match(/https?:\/\/[^\s<>"']+/gi) || [];
  if (!matches.length) {
    const single = source.trim();
    if (single && !/\s/.test(single) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(single)) {
      matches = [`https://${single}`];
    }
  }
  const seen = new Set();
  const urls = [];
  for (const raw of matches) {
    const url = raw.replace(/[),.;]+$/, '');
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function thumbUrl(url) {
  if (!url) return '';
  if (url.startsWith('data:') || url.startsWith('/')) return url;
  return `/api/thumb?u=${encodeURIComponent(url)}`;
}

async function api(path, options = {}) {
  const config = { headers: { 'Content-Type': 'application/json' }, ...options };
  let response;
  try {
    response = await fetch(path, config);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const offline = new Error('Could not reach AVMine. Is the app still running?');
    offline.hint = 'Check the AVMine console window, then reload this page.';
    throw offline;
  }

  let data = null;
  try { data = await response.json(); } catch { /* empty response */ }

  if (!response.ok) {
    const detail = data && data.detail;
    let message = `Request failed (${response.status})`;
    let hint = '';
    if (typeof detail === 'string') {
      message = detail;
    } else if (detail && typeof detail === 'object') {
      message = detail.message || message;
      hint = detail.hint || '';
    }
    const error = new Error(message);
    error.hint = hint;
    error.status = response.status;
    throw error;
  }
  return data;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let index = -1;
  let size = value;
  do { size /= 1024; index += 1; } while (size >= 1024 && index < units.length - 1);
  return `${size >= 10 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

function formatEta(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total >= 3600) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
  if (total >= 60) {
    const minutes = Math.floor(total / 60);
    return `${minutes}m ${total % 60}s`;
  }
  return `${total}s`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return '';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatCount(value) {
  const number = Number(value) || 0;
  if (!number) return '';
  try {
    return `${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(number)} views`;
  } catch {
    return `${number} views`;
  }
}

function timeAgo(timestamp) {
  const seconds = Math.max(0, Date.now() / 1000 - Number(timestamp || 0));
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(Number(timestamp) * 1000).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function folderLabel(path) {
  const text = String(path || '').trim();
  if (!text) return 'Choose folder';
  const parts = text.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return text;
  return `…\\${parts.slice(-2).join('\\')}`;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'media'; }
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/* ------------------------------------------------------------------- toasts */

function toast(message, type = 'info', hint = '', timeout = 4600) {
  const meta = TOAST_TYPES[type] || TOAST_TYPES.info;
  const stack = $('#toastStack');
  const element = document.createElement('div');
  element.className = `toast toast--${type}`;
  element.innerHTML = `
    <svg class="icon"><use href="#i-${meta.icon}"/></svg>
    <div class="toast-content">
      <span class="toast-title">${esc(meta.title)}</span>
      <span class="toast-msg">${esc(message)}</span>
      ${hint ? `<span class="toast-hint">${esc(hint)}</span>` : ''}
    </div>`;

  stack.appendChild(element);
  while (stack.children.length > 4) stack.firstElementChild.remove();

  const remove = () => {
    if (!element.isConnected) return;
    element.classList.add('is-out');
    setTimeout(() => element.remove(), 200);
  };
  element.addEventListener('click', remove);
  setTimeout(remove, timeout);
}

/* ------------------------------------------------------------------- modals */

function openModal(id) {
  const element = document.getElementById(id);
  if (!element) return;
  element.classList.remove('is-hidden');
  state.modals.add(id);
  document.body.style.overflow = 'hidden';
  const focusable = element.querySelector('input:not([type="checkbox"]), select, button');
  if (focusable) setTimeout(() => focusable.focus(), 40);
}

function closeModal(id) {
  const element = document.getElementById(id);
  if (!element) return;
  element.classList.add('is-hidden');
  state.modals.delete(id);
  if (!state.modals.size) document.body.style.overflow = '';
}

function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    state.confirmResolve = resolve;
    $('#confirmTitle').textContent = title;
    $('#confirmMessage').textContent = message;
    $('#confirmOk').textContent = confirmLabel;
    $('#confirmOk').className = `btn ${danger ? 'danger' : 'primary'}`;
    openModal('confirmModal');
    setTimeout(() => $('#confirmOk').focus(), 50);
  });
}

function finishConfirm(result) {
  closeModal('confirmModal');
  const resolve = state.confirmResolve;
  state.confirmResolve = null;
  if (resolve) resolve(result);
}

/* --------------------------------------------------------------------- menu */

function openMenu(anchor, items) {
  const menu = $('#contextMenu');
  state.menuItems = items;
  menu.innerHTML = items.map((item, index) => {
    if (item.sep) return '<div class="menu-sep"></div>';
    return `<button class="menu-item ${item.danger ? 'danger' : ''}" data-index="${index}">
      ${item.icon ? `<svg class="icon"><use href="#i-${item.icon}"/></svg>` : ''}
      <span>${esc(item.label)}</span>
    </button>`;
  }).join('');
  menu.classList.remove('is-hidden');

  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = rect.right - menuRect.width;
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - 12) top = rect.top - menuRect.height - 6;
  menu.style.left = `${Math.max(12, Math.min(left, window.innerWidth - menuRect.width - 12))}px`;
  menu.style.top = `${Math.max(12, top)}px`;

  requestAnimationFrame(() => document.addEventListener('click', closeMenuOnOutside));
}

function closeMenuOnOutside(event) {
  if (!$('#contextMenu').contains(event.target)) closeMenu();
}

function closeMenu() {
  const menu = $('#contextMenu');
  if (menu.classList.contains('is-hidden')) return;
  menu.classList.add('is-hidden');
  menu.innerHTML = '';
  state.menuItems = [];
  document.removeEventListener('click', closeMenuOnOutside);
}

/* ------------------------------------------------------------------- folders */

async function revealPath(path) {
  try {
    await api('/api/reveal', { method: 'POST', body: JSON.stringify({ path }) });
  } catch (error) {
    toast(error.message, 'error', error.hint);
  }
}

async function openFile(path) {
  try {
    await api('/api/open', { method: 'POST', body: JSON.stringify({ path }) });
  } catch (error) {
    toast(error.message, 'error', error.hint);
  }
}

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('File path copied', 'success');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); toast('File path copied', 'success'); }
    catch { toast('Couldn’t copy the path', 'error'); }
    area.remove();
  }
}

/* ------------------------------------------------------------ loading state */

async function loadHealth() {
  try {
    const health = await api('/api/health');
    state.health = health;
    state.dataDir = health.data_dir || '';

    $('#versionText').textContent = `yt-dlp ${health.ytdlp}`;
    const dot = $('#statusDot');
    if (!health.ffmpeg || !health.ffmpeg.found) {
      dot.classList.add('is-warn');
      $('#versionPill').title = 'ffmpeg was not found. Downloads that need merging or conversion will fail.';
    } else {
      dot.classList.add('is-good');
      $('#versionPill').title = `ffmpeg ready · ${health.ffmpeg.path || 'PATH'}`;
    }
    $('#footerVersion').textContent = `AVMine ${health.version}`;

    $('#ytdlpVersion').textContent = health.ytdlp;
    const ffmpeg = health.ffmpeg || {};
    const match = String(ffmpeg.version || '').match(/ffmpeg version (\S+)/i);
    $('#ffmpegVersion').textContent = ffmpeg.found
      ? (match ? match[1] : ffmpeg.version)
      : 'Not found on PATH';
    const badge = $('#ffmpegBadge');
    badge.textContent = ffmpeg.found ? 'Ready' : 'Missing';
    badge.classList.toggle('is-warn', !ffmpeg.found);
  } catch (error) {
    $('#versionText').textContent = 'offline';
    toast('Could not load system status', 'warn', error.message);
  }
}

async function loadSettings() {
  try {
    const data = await api('/api/settings');
    state.defaults = data.defaults;
    applySettings(data.settings);
    if (!state.health) {
      $('#ytdlpVersion').textContent = data.ytdlp || 'unknown';
      const ffmpeg = data.ffmpeg || {};
      const match = String(ffmpeg.version || '').match(/ffmpeg version (\S+)/i);
      $('#ffmpegVersion').textContent = ffmpeg.found ? (match ? match[1] : ffmpeg.version) : 'Not found on PATH';
      const badge = $('#ffmpegBadge');
      badge.textContent = ffmpeg.found ? 'Ready' : 'Missing';
      badge.classList.toggle('is-warn', !ffmpeg.found);
    }
  } catch (error) {
    toast('Could not load settings', 'error', error.message);
  }
}

function applySettings(settings) {
  state.settings = settings;
  setMode(settings.default_mode === 'audio' ? 'audio' : 'video', false);
  $('#videoQuality').value = settings.video_quality || '1080';
  $('#audioFormat').value = settings.audio_format || 'mp3';
  $('#audioQuality').value = settings.audio_quality || '320';
  setFolder(settings.download_dir);
  fillSettingsForm(settings);
  updateBitrateState();
}

function setFolder(path) {
  const chip = $('#folderName');
  chip.textContent = folderLabel(path);
  chip.title = path || '';
  const field = $('#setFolder');
  if (field && document.activeElement !== field) field.value = path || '';
}

async function savePrefs(patch) {
  try {
    const data = await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
    state.settings = data.settings;
  } catch (error) {
    toast('Could not save preference', 'warn', error.message);
  }
}

/* ------------------------------------------------------------------ composer */

function setMode(mode, persist = true) {
  state.mode = mode;
  $$('#modeToggle .seg').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $('#videoOptions').classList.toggle('is-hidden', mode !== 'video');
  $('#audioOptions').classList.toggle('is-hidden', mode !== 'audio');
  if (persist) savePrefs({ default_mode: mode });
  if (state.previewData) renderPreview(state.previewData);
}

function updateBitrateState() {
  const isWav = $('#audioFormat').value === 'wav';
  $('#audioQuality').disabled = isWav;
  $('#bitrateWrap').classList.toggle('is-disabled', isWav);
}

function autoResize() {
  const input = $('#urlInput');
  input.style.height = 'auto';
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 44), 150)}px`;
}

function updateDownloadLabel() {
  const count = parseUrls($('#urlInput').value).length;
  $('#downloadLabel').textContent = count > 1 ? `Download ${count} links` : 'Download';
}

function onUrlInput() {
  autoResize();
  updateDownloadLabel();
  scheduleAnalyze();
}

function scheduleAnalyze() {
  clearTimeout(state.analyzeTimer);
  const urls = parseUrls($('#urlInput').value);

  if (!urls.length) {
    hidePreview();
    return;
  }

  if (urls[0] === state.analyzedUrl && state.previewData) {
    renderPreview(state.previewData);
    return;
  }

  state.analyzeTimer = setTimeout(() => analyze(urls[0]), 550);
}

async function analyze(url) {
  if (state.analyzeAbort) state.analyzeAbort.abort();
  const controller = new AbortController();
  state.analyzeAbort = controller;
  const token = ++state.analyzeToken;
  const timeout = setTimeout(() => controller.abort(), 30000);

  renderPreviewSkeleton();
  try {
    const data = await api(`/api/info?url=${encodeURIComponent(url)}`, { signal: controller.signal });
    if (token !== state.analyzeToken) return;
    state.previewData = data;
    state.analyzedUrl = url;
    renderPreview(data);
  } catch (error) {
    if (token !== state.analyzeToken || error.name === 'AbortError') return;
    renderPreviewError(error);
  } finally {
    clearTimeout(timeout);
  }
}

function renderPreviewSkeleton() {
  $('#previewSection').classList.remove('is-hidden');
  $('#previewCard').innerHTML = `
    <div class="preview-thumb"><div class="skeleton" style="width:100%;height:100%"></div></div>
    <div class="preview-body">
      <div class="skeleton" style="height:11px;width:32%"></div>
      <div class="skeleton" style="height:16px;width:88%;margin-top:10px"></div>
      <div class="skeleton" style="height:12px;width:52%;margin-top:10px"></div>
    </div>
    <div></div>`;
}

function renderPreview(data) {
  const urls = parseUrls($('#urlInput').value);
  const extra = urls.length - 1;
  const isPlaylist = data.type === 'playlist';
  const metaBits = [];

  if (data.uploader) metaBits.push(`<span>${esc(data.uploader)}</span>`);
  if (data.duration) metaBits.push(`<span>${formatDuration(data.duration)}</span>`);
  if (data.view_count && !isPlaylist) metaBits.push(`<span>${formatCount(data.view_count)}</span>`);
  if (isPlaylist && data.item_count) metaBits.push(`<span>${data.item_count} items in this playlist</span>`);
  if (extra > 0) metaBits.push(`<span class="tag">+${extra} more link${extra > 1 ? 's' : ''}</span>`);

  const meta = metaBits.map((bit, index) => `${index ? '<span class="dotsep"></span>' : ''}${bit}`).join('');
  const thumb = data.thumbnail
    ? `<img src="${esc(thumbUrl(data.thumbnail))}" alt="" loading="lazy">`
    : '<svg class="icon"><use href="#i-video"/></svg>';

  $('#previewSection').classList.remove('is-hidden');
  $('#previewCard').innerHTML = `
    <div class="preview-thumb">${thumb}</div>
    <div class="preview-body">
      <div class="preview-kicker">
        <span class="tag ${isPlaylist ? 'tag--playlist' : (state.mode === 'audio' ? 'tag--audio' : 'tag--video')}">
          ${isPlaylist ? 'Playlist' : (state.mode === 'audio' ? 'Audio' : 'Video')}
        </span>
        <span>${isPlaylist ? 'Playlist detected' : 'Ready to download'}</span>
      </div>
      <div class="preview-title">${esc(data.title || 'Untitled')}</div>
      <div class="preview-meta">${meta}</div>
    </div>
    <button class="icon-btn ghost preview-close" title="Clear link" aria-label="Clear link">
      <svg class="icon"><use href="#i-x"/></svg>
    </button>`;

  $('.preview-close', $('#previewCard')).addEventListener('click', clearComposer);
}

function renderPreviewError(error) {
  const message = String(error.message || 'Unknown error').replace(/^ERROR:\s*/i, '');
  $('#previewSection').classList.remove('is-hidden');
  $('#previewCard').innerHTML = `
    <div class="preview-error">
      <svg class="icon"><use href="#i-alert"/></svg>
      <div>
        <strong>Couldn't read that link</strong>
        <span>${esc(message)}</span>
        ${error.hint ? `<br><span style="color:var(--muted-2)">${esc(error.hint)}</span>` : ''}
      </div>
    </div>`;
}

function hidePreview() {
  if (state.analyzeAbort) state.analyzeAbort.abort();
  state.analyzeToken += 1;
  state.previewData = null;
  state.analyzedUrl = '';
  $('#previewSection').classList.add('is-hidden');
  $('#previewCard').innerHTML = '';
}

function clearComposer() {
  $('#urlInput').value = '';
  autoResize();
  updateDownloadLabel();
  hidePreview();
  $('#urlInput').focus();
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) {
      toast('The clipboard is empty', 'info');
      return;
    }
    $('#urlInput').value = text.trim();
    onUrlInput();
    $('#urlInput').focus();
  } catch {
    toast('Couldn’t read the clipboard', 'warn', 'Press Ctrl+V in the box instead.');
    $('#urlInput').focus();
  }
}

async function pickFolder(quick = false) {
  const button = quick ? $('#folderChip') : $('#browseBtn');
  const original = button.innerHTML;
  button.disabled = true;
  if (quick) {
    button.classList.add('is-busy');
  } else {
    button.innerHTML = '<span class="spinner"></span> <span>Choosing…</span>';
  }
  try {
    const data = await api('/api/pick-folder', { method: 'POST' });
    if (data.path) {
      if (quick) {
        const saved = await api('/api/settings', {
          method: 'POST', body: JSON.stringify({ download_dir: data.path }),
        });
        applySettings(saved.settings);
        toast('Download folder updated', 'success', data.path);
      } else {
        $('#setFolder').value = data.path;
      }
    }
  } catch (error) {
    toast(error.message, 'error', error.hint);
  } finally {
    button.disabled = false;
    button.classList.remove('is-busy');
    if (!quick) button.innerHTML = original;
  }
}

/* ------------------------------------------------------------------ download */

async function startDownload() {
  const urls = parseUrls($('#urlInput').value);
  if (!urls.length) {
    toast('Paste a link first', 'warn', 'Links need to start with http:// or https://');
    $('#urlInput').focus();
    return;
  }

  const button = $('#downloadBtn');
  button.disabled = true;
  $('#downloadLabel').textContent = urls.length > 1 ? `Starting ${urls.length}…` : 'Starting…';

  try {
    const payload = {
      urls,
      mode: state.mode,
      video_quality: $('#videoQuality').value,
      audio_format: $('#audioFormat').value,
      audio_quality: $('#audioQuality').value,
      playlist: state.settings?.playlist ?? true,
      sponsorblock: state.settings?.sponsorblock ?? false,
    };
    const data = await api('/api/download', { method: 'POST', body: JSON.stringify(payload) });
    toast(data.count > 1 ? `${data.count} downloads queued` : 'Added to the queue', 'success');
    clearComposer();
    kickPoll();
  } catch (error) {
    toast(error.message, 'error', error.hint);
  } finally {
    button.disabled = false;
    updateDownloadLabel();
  }
}

/* --------------------------------------------------------------------- queue */

function pollJobs() {
  if (state.polling) return;
  state.polling = true;
  clearTimeout(state.pollTimer);

  api('/api/jobs')
    .then((data) => {
      syncJobs(data.jobs || []);
      const active = Number(data.active) || 0;
      state.pollTimer = setTimeout(pollJobs, active > 0 ? 650 : 2400);
    })
    .catch(() => {
      state.pollTimer = setTimeout(pollJobs, 4000);
    })
    .finally(() => {
      state.polling = false;
    });
}

function kickPoll() {
  clearTimeout(state.pollTimer);
  setTimeout(pollJobs, 60);
}

function createJobCard(job) {
  const element = document.createElement('article');
  element.className = 'job';
  element.dataset.id = job.id;
  element.innerHTML = `
    <div class="job-thumb"></div>
    <div class="job-body">
      <div class="job-top">
        <span class="job-title">${esc(job.title || hostOf(job.url))}</span>
        <span class="job-percent">0%</span>
      </div>
      <div class="job-meta">
        <span class="job-status">Queued</span>
        <span class="job-detail"></span>
      </div>
      <div class="bar"><div class="bar-fill"></div></div>
    </div>
    <button class="icon-btn ghost job-action" type="button" title="Cancel download" aria-label="Cancel download">
      <svg class="icon"><use href="#i-x"/></svg>
    </button>`;

  element.querySelector('.job-action').addEventListener('click', () => onJobAction(job.id));
  return element;
}

function updateJobCard(element, job) {
  const thumb = element.querySelector('.job-thumb');
  if (job.thumbnail) {
    let img = thumb.querySelector('img');
    if (!img) {
      img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      thumb.innerHTML = '';
      thumb.appendChild(img);
    }
    const source = thumbUrl(job.thumbnail);
    if (img.getAttribute('src') !== source) img.src = source;
  }

  element.querySelector('.job-title').textContent = job.title || hostOf(job.url) || 'Preparing…';

  const statusLabels = {
    queued: 'Queued',
    downloading: 'Downloading',
    processing: 'Finishing',
    complete: 'Saved',
    error: 'Failed',
    canceled: 'Canceled',
  };
  const status = job.status || 'queued';
  element.classList.toggle('is-processing', status === 'processing');
  element.classList.toggle('is-complete', status === 'complete');
  element.classList.toggle('is-error', status === 'error');
  element.classList.toggle('is-canceled', status === 'canceled');

  const percent = status === 'complete' || status === 'processing'
    ? 100
    : Math.max(0, Math.min(100, Math.round(Number(job.percent) || 0)));

  const percentLabel = element.querySelector('.job-percent');
  percentLabel.textContent = ['error', 'canceled'].includes(status) ? '' : `${percent}%`;
  element.querySelector('.bar-fill').style.width = `${percent}%`;

  element.querySelector('.job-status').textContent = statusLabels[status] || status;
  element.querySelector('.job-detail').textContent = jobDetail(job, status);

  const action = element.querySelector('.job-action');
  const icon = action.querySelector('use');
  if (status === 'complete') {
    icon.setAttribute('href', '#i-check');
    action.title = 'Saved';
    action.setAttribute('aria-label', 'Saved');
  } else if (status === 'error' || status === 'canceled') {
    icon.setAttribute('href', '#i-x');
    action.title = 'Dismiss';
    action.setAttribute('aria-label', 'Dismiss');
  } else {
    icon.setAttribute('href', '#i-x');
    action.title = 'Cancel download';
    action.setAttribute('aria-label', 'Cancel download');
  }
}

function jobDetail(job, status) {
  if (status === 'queued') return `${job.format_label || ''} · waiting`.replace(/^ · /, '');
  if (status === 'processing') return 'Merging audio and video…';
  if (status === 'complete') {
    const count = (job.files || []).length;
    const size = job.size ? formatBytes(job.size) : '';
    return [size, count > 1 ? `${count} files` : ''].filter(Boolean).join(' · ') || 'Ready';
  }
  if (status === 'canceled') return 'Canceled before finishing';
  if (status === 'error') return job.error || 'Something went wrong';

  const bits = [];
  if (job.item_index && job.item_total) bits.push(`Item ${job.item_index} of ${job.item_total}`);
  if (job.total_bytes) bits.push(`${formatBytes(job.downloaded_bytes)} / ${formatBytes(job.total_bytes)}`);
  else if (job.downloaded_bytes) bits.push(formatBytes(job.downloaded_bytes));
  if (job.speed) bits.push(`${formatBytes(job.speed)}/s`);
  if (job.eta && job.eta > 0) bits.push(`${formatEta(job.eta)} left`);
  if (!bits.length) bits.push(job.format_label || 'Starting…');
  return bits.join(' · ');
}

function syncJobs(jobs) {
  const firstSync = !state.jobsInitialized;
  state.jobsInitialized = true;
  const seen = new Set();

  for (const job of jobs) {
    if (state.dismissed.has(job.id)) continue;
    // Completed jobs from a previous page visit already live in the library;
    // only show jobs that are actually running when the page first loads.
    if (firstSync && !['queued', 'downloading', 'processing'].includes(job.status)) {
      state.dismissed.add(job.id);
      continue;
    }
    seen.add(job.id);

    let card = state.cards.get(job.id);
    if (!card) {
      const element = createJobCard(job);
      $('#queueList').appendChild(element);
      card = { element, notified: false, timer: null };
      state.cards.set(job.id, card);
    }

    card.job = job;
    updateJobCard(card.element, job);

    if (job.status === 'complete' && !card.notified) {
      card.notified = true;
      toast(
        (job.files || []).length > 1 ? `${job.files.length} files saved` : 'Saved to your library',
        'success',
        job.title || '',
        3600,
      );
      loadHistory();
      setTimeout(loadHistory, 900);
      card.timer = setTimeout(() => dismissJob(job.id), 6500);
    } else if (job.status === 'error' && !card.notified) {
      card.notified = true;
      toast(job.error || 'Download failed', 'error', job.error_hint || '', 8000);
    } else if (job.status === 'canceled' && !card.notified) {
      card.notified = true;
      card.timer = setTimeout(() => dismissJob(job.id), 2600);
    }
  }

  for (const [id, card] of Array.from(state.cards.entries())) {
    if (!seen.has(id)) {
      clearTimeout(card.timer);
      card.element.remove();
      state.cards.delete(id);
    }
  }

  updateQueueCount();
}

function updateQueueCount() {
  const count = state.cards.size;
  $('#queueSection').classList.toggle('is-hidden', count === 0);
  $('#queueCount').textContent = String(count);
}

function dismissJob(id) {
  const card = state.cards.get(id);
  if (!card) return;
  clearTimeout(card.timer);
  state.dismissed.add(id);
  card.element.style.transition = 'opacity .18s ease, transform .18s ease';
  card.element.style.opacity = '0';
  card.element.style.transform = 'translateY(-4px)';
  setTimeout(() => {
    card.element.remove();
    state.cards.delete(id);
    updateQueueCount();
  }, 190);
}

async function onJobAction(id) {
  const card = state.cards.get(id);
  if (!card || !card.job) return;
  const status = card.job.status;

  if (['queued', 'downloading', 'processing'].includes(status)) {
    const button = card.element.querySelector('.job-action');
    button.disabled = true;
    try {
      await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
      toast('Canceling download…', 'info');
      kickPoll();
    } catch (error) {
      toast(error.message, 'error', error.hint);
      button.disabled = false;
    }
  } else {
    dismissJob(id);
  }
}

/* ------------------------------------------------------------------- history */

async function loadHistory() {
  const token = ++state.historyToken;
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.filter !== 'all') params.set('mode', state.filter);

  try {
    const data = await api(`/api/history?${params.toString()}`);
    if (token !== state.historyToken) return;
    state.history = data.items || [];
    renderHistory(data);
  } catch (error) {
    if (token === state.historyToken) console.error(error);
  }
}

function historyRow(entry) {
  const modeTag = entry.mode === 'audio' ? 'tag--audio' : 'tag--video';
  const bits = [
    `<span class="tag ${modeTag}">${entry.mode === 'audio' ? 'Audio' : 'Video'}</span>`,
    entry.format_label ? `<span>${esc(entry.format_label)}</span>` : '',
    entry.size ? `<span>${formatBytes(entry.size)}</span>` : '',
    `<span>${esc(timeAgo(entry.completed_at))}</span>`,
  ].filter(Boolean).join('<span class="dotsep"></span>');

  const thumb = entry.thumbnail
    ? `<img src="${esc(thumbUrl(entry.thumbnail))}" alt="" loading="lazy">`
    : '<svg class="icon" style="width:18px;height:18px;color:rgba(255,255,255,.25)"><use href="#i-file"/></svg>';

  return `
    <div class="history-item" data-id="${esc(entry.id)}">
      <div class="history-thumb">${thumb}</div>
      <div class="history-info">
        <div class="history-title" title="${esc(entry.title)}">${esc(entry.title || 'Untitled')}</div>
        <div class="history-meta">${bits}</div>
      </div>
      <div class="history-actions">
        <button class="icon-btn ghost" data-action="play" title="Open file" aria-label="Open file">
          <svg class="icon"><use href="#i-play"/></svg>
        </button>
        <button class="icon-btn ghost" data-action="reveal" title="Show in folder" aria-label="Show in folder">
          <svg class="icon"><use href="#i-folder"/></svg>
        </button>
        <button class="icon-btn ghost" data-action="copy" title="Copy file path" aria-label="Copy file path">
          <svg class="icon"><use href="#i-copy"/></svg>
        </button>
        <button class="icon-btn ghost" data-action="redownload" title="Download again" aria-label="Download again">
          <svg class="icon"><use href="#i-refresh"/></svg>
        </button>
        <button class="icon-btn ghost" data-action="delete" title="More" aria-label="More options">
          <svg class="icon"><use href="#i-more"/></svg>
        </button>
      </div>
    </div>`;
}

function renderHistory(data) {
  const items = data.items || [];
  $('#historyCount').textContent = String(data.count ?? items.length);

  const list = $('#historyList');
  list.innerHTML = items.map(historyRow).join('');

  const empty = $('#emptyState');
  if (!items.length) {
    empty.classList.remove('is-hidden');
    const searching = state.query || state.filter !== 'all';
    $('.empty-title', empty).textContent = searching ? 'No matches' : 'Nothing here yet';
    $('.empty-sub', empty).textContent = searching
      ? 'Try a different search or filter.'
      : 'Paste a link above and your downloads will collect here.';
  } else {
    empty.classList.add('is-hidden');
  }
}

async function handleHistoryAction(action, entry) {
  if (!entry) return;

  if (action === 'play') {
    if (entry.filepath) openFile(entry.filepath);
    return;
  }
  if (action === 'reveal') {
    revealPath(entry.filepath || entry.files?.[0] || '');
    return;
  }
  if (action === 'copy') {
    copyText(entry.filepath || entry.files?.[0] || '');
    return;
  }
  if (action === 'redownload') {
    await redownload(entry);
    return;
  }
  if (action === 'delete') {
    const anchor = $(`.history-item[data-id="${entry.id}"] [data-action="delete"]`);
    openMenu(anchor, [
      {
        label: 'Remove from history',
        icon: 'x',
        onClick: async () => {
          try {
            await api(`/api/history/${entry.id}`, { method: 'DELETE' });
            toast('Removed from history', 'success');
            loadHistory();
          } catch (error) {
            toast(error.message, 'error', error.hint);
          }
        },
      },
      { sep: true },
      {
        label: 'Delete file from disk',
        icon: 'trash',
        danger: true,
        onClick: async () => {
          const ok = await confirmDialog({
            title: 'Delete the file?',
            message: `This permanently deletes “${entry.title}” from your disk. This cannot be undone.`,
            confirmLabel: 'Delete file',
          });
          if (!ok) return;
          try {
            const result = await api(`/api/history/${entry.id}?delete_file=true`, { method: 'DELETE' });
            if (result.removed_files > 0) {
              toast('File deleted', 'success');
            } else {
              toast('Removed from history — the file could not be deleted', 'warn',
                    'It may be open in another app or already gone.');
            }
            loadHistory();
          } catch (error) {
            toast(error.message, 'error', error.hint);
          }
        },
      },
    ]);
  }
}

async function redownload(entry) {
  const options = entry.options || {};
  const settings = state.settings || {};
  try {
    await api('/api/download', {
      method: 'POST',
      body: JSON.stringify({
        urls: [entry.url],
        mode: entry.mode || 'video',
        video_quality: options.video_quality || settings.video_quality || '1080',
        audio_format: options.audio_format || settings.audio_format || 'mp3',
        audio_quality: options.audio_quality || settings.audio_quality || '320',
        playlist: options.playlist ?? settings.playlist ?? true,
        sponsorblock: options.sponsorblock ?? settings.sponsorblock ?? false,
      }),
    });
    toast('Added back to the queue', 'success', entry.title);
    kickPoll();
  } catch (error) {
    toast(error.message, 'error', error.hint);
  }
}

async function clearHistory(deleteFiles) {
  const message = deleteFiles
    ? 'This removes every history entry and permanently deletes the downloaded files from disk.'
    : 'This clears the list only. Files already downloaded stay on disk.';
  const ok = await confirmDialog({
    title: deleteFiles ? 'Clear history and delete files?' : 'Clear history?',
    message,
    confirmLabel: deleteFiles ? 'Delete everything' : 'Clear history',
    danger: deleteFiles,
  });
  if (!ok) return;

  try {
    const data = await api('/api/history/clear', {
      method: 'POST', body: JSON.stringify({ delete_files: deleteFiles }),
    });
    toast(
      deleteFiles ? `Cleared ${data.cleared} entries · ${data.removed_files} files deleted` : 'History cleared',
      'success',
    );
    loadHistory();
  } catch (error) {
    toast(error.message, 'error', error.hint);
  }
}

/* ------------------------------------------------------------------ settings */

function fillSettingsForm(settings) {
  $('#setFolder').value = settings.download_dir || '';
  $('#setTemplate').value = settings.filename_template || '';
  $('#setEmbedThumb').checked = Boolean(settings.embed_thumbnail);
  $('#setEmbedMeta').checked = Boolean(settings.embed_metadata);
  $('#setPlaylist').checked = Boolean(settings.playlist);
  $('#setSponsor').checked = Boolean(settings.sponsorblock);
  $('#setCookies').value = settings.cookies_browser || '';
  $('#setFfmpeg').value = settings.ffmpeg_path || '';
}

function openSettings() {
  if (state.settings) fillSettingsForm(state.settings);
  openModal('settingsModal');
}

async function saveSettings() {
  const button = $('#saveSettingsBtn');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Saving…';

  const patch = {
    download_dir: $('#setFolder').value.trim(),
    filename_template: $('#setTemplate').value.trim(),
    embed_thumbnail: $('#setEmbedThumb').checked,
    embed_metadata: $('#setEmbedMeta').checked,
    playlist: $('#setPlaylist').checked,
    sponsorblock: $('#setSponsor').checked,
    cookies_browser: $('#setCookies').value,
    ffmpeg_path: $('#setFfmpeg').value.trim(),
  };

  try {
    const data = await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
    applySettings(data.settings);
    closeModal('settingsModal');
    toast('Settings saved', 'success');
  } catch (error) {
    toast(error.message, 'error', error.hint);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function updateYtdlp() {
  const button = $('#updateBtn');
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> Updating…';

  try {
    const data = await api('/api/update-ytdlp', { method: 'POST' });
    if (data.restart_required) {
      toast(`yt-dlp ${data.installed} installed`, 'warn', 'Close and reopen AV Mine to use the new version.', 9000);
      $('#ytdlpVersion').textContent = `${data.running} (restart to load ${data.installed})`;
    } else {
      toast('yt-dlp is up to date', 'success', `Running ${data.running}`);
    }
  } catch (error) {
    toast(error.message, 'error', error.hint);
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

/* -------------------------------------------------------------------- events */

function bindEvents() {
  const input = $('#urlInput');

  input.addEventListener('input', onUrlInput);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      startDownload();
    }
  });

  $('#pasteBtn').addEventListener('click', pasteFromClipboard);
  $('#downloadBtn').addEventListener('click', startDownload);

  $$('#modeToggle .seg').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });

  $('#videoQuality').addEventListener('change', (event) => savePrefs({ video_quality: event.target.value }));
  $('#audioFormat').addEventListener('change', (event) => {
    updateBitrateState();
    savePrefs({ audio_format: event.target.value });
  });
  $('#audioQuality').addEventListener('change', (event) => savePrefs({ audio_quality: event.target.value }));

  $('#folderChip').addEventListener('click', () => pickFolder(true));

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#browseBtn').addEventListener('click', () => pickFolder(false));
  $('#saveSettingsBtn').addEventListener('click', saveSettings);
  $('#updateBtn').addEventListener('click', updateYtdlp);
  $('#dataFolderBtn').addEventListener('click', () => {
    if (state.dataDir) revealPath(state.dataDir);
    else toast('Data folder is not available yet', 'warn');
  });
  $('#resetTemplateBtn').addEventListener('click', () => {
    const template = state.defaults?.filename_template || '%(title)s.%(ext)s';
    $('#setTemplate').value = template;
  });

  $$('[data-close]').forEach((button) => {
    button.addEventListener('click', () => closeModal(button.dataset.close));
  });

  $$('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (event) => {
      if (event.target !== backdrop) return;
      if (backdrop.id === 'confirmModal') finishConfirm(false);
      else closeModal(backdrop.id);
    });
  });

  $('#confirmOk').addEventListener('click', () => finishConfirm(true));
  $('#confirmCancel').addEventListener('click', () => finishConfirm(false));

  $('#searchInput').addEventListener('input', debounce((event) => {
    state.query = event.target.value.trim();
    loadHistory();
  }, 280));

  $$('#filterChips .filter').forEach((button) => {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      $$('#filterChips .filter').forEach((chip) => chip.classList.toggle('is-active', chip === button));
      loadHistory();
    });
  });

  $('#openFolderBtn').addEventListener('click', () => {
    const folder = state.settings?.download_dir || state.health?.download_dir;
    if (folder) revealPath(folder);
  });

  $('#historyMenuBtn').addEventListener('click', (event) => {
    openMenu(event.currentTarget, [
      {
        label: 'Open download folder',
        icon: 'folder-open',
        onClick: () => revealPath(state.settings?.download_dir || ''),
      },
      { sep: true },
      {
        label: 'Clear history',
        icon: 'x',
        onClick: () => clearHistory(false),
      },
      {
        label: 'Clear history and delete files',
        icon: 'trash',
        danger: true,
        onClick: () => clearHistory(true),
      },
    ]);
  });

  $('#historyList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const row = button.closest('.history-item');
    const entry = state.history.find((item) => item.id === row.dataset.id);
    handleHistoryAction(button.dataset.action, entry);
  });

  $('#contextMenu').addEventListener('click', (event) => {
    const button = event.target.closest('[data-index]');
    if (!button) return;
    const item = state.menuItems[Number(button.dataset.index)];
    closeMenu();
    if (item && typeof item.onClick === 'function') item.onClick();
  });

  document.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();

    if (event.key === 'Escape') {
      if (!$('#contextMenu').classList.contains('is-hidden')) {
        closeMenu();
        return;
      }
      if (state.modals.has('confirmModal')) {
        finishConfirm(false);
        return;
      }
      const top = Array.from(state.modals).pop();
      if (top) closeModal(top);
      return;
    }

    if ((event.ctrlKey || event.metaKey) && key === 'k') {
      event.preventDefault();
      clearTimeout(state.analyzeTimer);
      $('#urlInput').focus();
      $('#urlInput').select();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key === ',') {
      event.preventDefault();
      openSettings();
    }
  });

  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, true);

  document.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target.tagName === 'IMG') {
      const holder = target.closest('.preview-thumb, .job-thumb, .history-thumb');
      if (holder) holder.classList.add('thumb-broken');
      target.style.display = 'none';
    }
  }, true);
}

/* --------------------------------------------------------------------- init */

function init() {
  bindEvents();
  autoResize();
  updateDownloadLabel();

  loadHealth();
  loadSettings();
  loadHistory();
  pollJobs();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
