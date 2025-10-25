// Korone Down Meter - static client-side script
// - Saves counter and state in localStorage so it works on GitHub Pages (no server).
// - Uses an optional CORS proxy to fetch remote pages (see README).
// - Increments counter when the page transitions from not-down to down (or first detection).

const TARGET_URL = 'https://pekora.zip';
const DETECTION_PHRASE = 'site is currently down'; // case-insensitive
const DEFAULT_PROXY = 'https://api.allorigins.win/raw?url='; // works for most public pages
const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds

// localStorage keys
const KEY_COUNT = 'korone_down_count';
const KEY_LAST_STATE = 'korone_last_state';
const KEY_PROXY = 'korone_proxy';
const KEY_LAST_CHECKED = 'korone_last_checked';
const KEY_SNIPPET = 'korone_last_snippet';

const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const lastCheckedEl = document.getElementById('lastChecked');
const snippetEl = document.getElementById('snippet');

const checkBtn = document.getElementById('checkBtn');
const resetBtn = document.getElementById('resetBtn');
const forceIncrementBtn = document.getElementById('forceIncrementBtn');
const proxyInput = document.getElementById('proxyInput');
const logoUrlInput = document.getElementById('logoUrlInput');
const setLogoBtn = document.getElementById('setLogoBtn');

function readNumber(key, defaultVal = 0) {
  const v = localStorage.getItem(key);
  if (!v) return defaultVal;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? defaultVal : n;
}

function saveNumber(key, num) {
  localStorage.setItem(key, String(num));
}

function readString(key, defaultVal = '') {
  const v = localStorage.getItem(key);
  return v === null ? defaultVal : v;
}
function saveString(key, s) {
  localStorage.setItem(key, s);
}

function setStatusLabel(state, details = '') {
  // state: 'up'|'down'|'unknown'
  statusEl.className = 'status ' + (state || 'unknown');
  if (state === 'up') {
    statusEl.textContent = 'UP';
  } else if (state === 'down') {
    statusEl.textContent = 'DOWN';
  } else {
    statusEl.textContent = details || 'Unknown';
  }
}

function updateUIFromStorage() {
  const count = readNumber(KEY_COUNT, 0);
  countEl.textContent = count;

  const lastChecked = readString(KEY_LAST_CHECKED, '—');
  lastCheckedEl.textContent = lastChecked;

  const snippet = readString(KEY_SNIPPET, 'No snippet yet.');
  snippetEl.textContent = snippet;
}

function nowISO() {
  return new Date().toISOString();
}

async function fetchTarget() {
  const proxy = (localStorage.getItem(KEY_PROXY) || DEFAULT_PROXY).trim();
  const fetchUrl = (proxy ? (proxy + encodeURIComponent(TARGET_URL)) : TARGET_URL);

  // Basic timeout around fetch
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(fetchUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) {
      // If proxy returns non-OK we still try to read text if available
      const txt = await resp.text().catch(() => '');
      return { ok: false, status: resp.status, text: txt };
    }
    const text = await resp.text().catch(() => '');
    return { ok: true, status: resp.status, text };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, status: 'error', text: String(err) };
  }
}

async function checkNow() {
  setStatusLabel('unknown', 'Checking…');
  const prevState = readString(KEY_LAST_STATE, 'unknown'); // 'down' or 'up' or 'unknown'

  const res = await fetchTarget();
  const snippet = (res.text || '').slice(0, 2000);
  saveString(KEY_SNIPPET, snippet);
  saveString(KEY_LAST_CHECKED, nowISO());

  // store snippet & last checked for UI
  updateUIFromStorage();

  if (!res.ok) {
    // treat failure to fetch as "unknown"
    setStatusLabel('unknown', `Fetch error (${res.status})`);
    return;
  }

  // detect phrase (case-insensitive)
  const found = (res.text || '').toLowerCase().includes(DETECTION_PHRASE.toLowerCase());

  if (found) {
    setStatusLabel('down');
    // increment only when transitioning into down (or if previous wasn't "down")
    if (prevState !== 'down') {
      const curCount = readNumber(KEY_COUNT, 0);
      saveNumber(KEY_COUNT, curCount + 1);
      countEl.textContent = curCount + 1;
    }
    saveString(KEY_LAST_STATE, 'down');
  } else {
    setStatusLabel('up');
    saveString(KEY_LAST_STATE, 'up');
  }

  // write timestamp and snippet for UI
  saveString(KEY_LAST_CHECKED, new Date().toLocaleString());
  saveString(KEY_SNIPPET, snippet || '(empty response)');
  updateUIFromStorage();
}

// Controls
checkBtn.addEventListener('click', () => {
  checkNow();
});

resetBtn.addEventListener('click', () => {
  if (!confirm('Reset the down counter to 0?')) return;
  saveNumber(KEY_COUNT, 0);
  countEl.textContent = '0';
});

forceIncrementBtn.addEventListener('click', () => {
  const cur = readNumber(KEY_COUNT, 0);
  saveNumber(KEY_COUNT, cur + 1);
  countEl.textContent = cur + 1;
});

// Proxy input: persist to localStorage
proxyInput.value = readString(KEY_PROXY, DEFAULT_PROXY);
proxyInput.addEventListener('change', () => {
  saveString(KEY_PROXY, proxyInput.value.trim());
});
proxyInput.addEventListener('blur', () => {
  saveString(KEY_PROXY, proxyInput.value.trim());
});

// logo setter
setLogoBtn.addEventListener('click', () => {
  const url = logoUrlInput.value.trim();
  if (!url) return;
  document.getElementById('logo').src = url;
  document.getElementById('logo').style.display = '';
  // Note: not persisted here; user can commit logo.png in repo for persistent display.
});

// load initial values
(function init() {
  updateUIFromStorage();

  // ensure the default proxy is stored if empty
  if (!localStorage.getItem(KEY_PROXY)) {
    saveString(KEY_PROXY, DEFAULT_PROXY);
    proxyInput.value = DEFAULT_PROXY;
  }

  // run an initial check immediately
  checkNow();

  // poll periodically
  setInterval(checkNow, POLL_INTERVAL_MS);
})();
