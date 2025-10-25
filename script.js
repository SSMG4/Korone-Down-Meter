// Korone Down Meter - resilient client-side script
// - Monitors a fixed URL (https://pekora.zip) and aggregates down counts per day.
// - Multiple detection heuristics: HTTP status ranges, Cloudflare challenge detection, known "site is down" text.
// - Tries direct fetch then built-in proxies and optional user proxy.
// - Stores daily aggregated history in localStorage and draws a per-day chart using Chart.js.

const TARGET_URL = 'https://pekora.zip'; // fixed per your request
const POLL_INTERVAL_MS = 60 * 1000; // still poll every minute, but history is aggregated per-day
const BUILTIN_PROXIES = [
  'https://api.allorigins.win/raw?url=',
  'https://thingproxy.freeboard.io/fetch/',
  // Note: public proxies can change behavior; keep user proxy input if needed.
];

const KEY_COUNT = 'korone_down_count';
const KEY_LAST_STATE = 'korone_last_state';
const KEY_PROXY = 'korone_proxy';
const KEY_LAST_CHECKED = 'korone_last_checked';
const KEY_DEBUG = 'korone_debug';
const KEY_HISTORY = 'korone_daily_history_v1'; // { 'YYYY-MM-DD': n, ... }

let statusEl, countEl, lastCheckedEl, debugEl;
let checkBtn, resetBtn, forceIncrementBtn, proxyInput, testProxyBtn, exportBtn;
let chart;

// Utility: DOM helper
function $id(id){ return document.getElementById(id); }

function readNumber(key, defaultVal = 0) {
  const v = localStorage.getItem(key);
  if (!v) return defaultVal;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? defaultVal : n;
}
function saveNumber(key, num) { localStorage.setItem(key, String(num)); }
function readString(key, defaultVal = '') {
  const v = localStorage.getItem(key);
  return v === null ? defaultVal : v;
}
function saveString(key, s) { localStorage.setItem(key, s); }

function getTodayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0,10); // YYYY-MM-DD
}
function readHistory() {
  try { return JSON.parse(localStorage.getItem(KEY_HISTORY) || '{}'); } catch(e){ return {}; }
}
function writeHistory(obj) { localStorage.setItem(KEY_HISTORY, JSON.stringify(obj)); }
function incrementToday(count = 1) {
  const hist = readHistory();
  const k = getTodayKey();
  hist[k] = (hist[k] || 0) + count;
  writeHistory(hist);
}
function clearHistory() { localStorage.removeItem(KEY_HISTORY); }

// Chart (per-day)
function initChart() {
  const ctx = $id('historyChart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'bar',
    data: { labels: [], datasets: [{ label: 'Downs per day', data: [], backgroundColor: '#ff7ab6' }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#9aa0a6' } },
        y: { beginAtZero: true, ticks: { color: '#9aa0a6', precision:0 } }
      },
      plugins: { legend: { labels: { color: '#e8eef7' } } }
    }
  });
  updateChart();
}
function updateChart() {
  if (!chart) return;
  const hist = readHistory();
  // show last 30 days
  const days = [];
  const data = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = d.toISOString().slice(0,10);
    days.push(k);
    data.push(hist[k] || 0);
  }
  chart.data.labels = days.map(d => new Date(d).toLocaleDateString());
  chart.data.datasets[0].data = data;
  chart.update();
}

// Fetch helpers
async function tryFetch(url, opts = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(url, { signal: controller.signal, ...opts });
    clearTimeout(timeout);
    let text = '';
    try { text = await resp.text(); } catch(e){ text = ''; }
    const headers = {};
    try { for (const h of resp.headers.entries()) headers[h[0]] = h[1]; } catch(e){}
    return { ok: resp.ok, status: resp.status, text, headers, type: resp.type };
  } catch (err) {
    return { ok: false, status: 'error', error: String(err) };
  }
}

function looksLikeCloudflareChallenge(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return t.includes('just a moment') || t.includes('enable javascript and cookies') || t.includes('__cf_chl_');
}

function analyzeResponse(result) {
  // result: {ok, status, text}
  // Heuristics:
  // - HTTP 500-599 => DOWN
  // - HTTP 200 but text includes Cloudflare challenge => DOWN (or challenge)
  // - HTTP 200 but body contains "site is currently down" => DOWN
  // - HTTP 403 maybe blocked => UNKNOWN (we treat as unknown)
  // - HTTP 404 typically not "down" but we can treat as unknown
  // - If fetch error (network/CORS), status 'error' => UNKNOWN
  if (!result) return { state: 'unknown', reason: 'no-result' };
  const s = result.status;
  if (typeof s === 'number') {
    if (s >= 500 && s <= 599) return { state: 'down', reason: `http${s}` };
    if (s === 200) {
      if (looksLikeCloudflareChallenge(result.text)) return { state: 'down', reason: 'cloudflare_challenge' };
      if ((result.text || '').toLowerCase().includes('site is currently down')) return { state: 'down', reason: 'phrase' };
      // any other 200 -> up
      return { state: 'up', reason: '200_ok' };
    }
    if (s === 403) return { state: 'unknown', reason: 'forbidden' };
    if (s === 404) return { state: 'unknown', reason: 'not_found' };
    // other statuses: mark unknown
    return { state: 'unknown', reason: `http${s}` };
  } else {
    // network error / CORS etc.
    return { state: 'unknown', reason: result.error || String(s) };
  }
}

async function fetchWithFallback() {
  // Try direct first
  const attempts = [];
  const direct = await tryFetch(TARGET_URL);
  attempts.push({ mode: 'direct', res: direct });
  // If direct is ok and response text exists, use it
  if ((direct.ok && typeof direct.text === 'string') || (direct.status && typeof direct.status === 'number')) {
    return { final: direct, attempts };
  }
  // otherwise try proxies
  const userProxy = readString(KEY_PROXY, '').trim();
  const proxies = [];
  if (userProxy) proxies.push(userProxy);
  for (const p of BUILTIN_PROXIES) if (!proxies.includes(p)) proxies.push(p);
  for (const p of proxies) {
    const fetchUrl = p + encodeURIComponent(TARGET_URL);
    const res = await tryFetch(fetchUrl);
    attempts.push({ mode: 'proxy', proxy: p, fetchUrl, res });
    // a proxy might return a body even if not ok; accept it so heuristics can inspect content
    if (res && (res.ok || typeof res.text === 'string' || res.status)) {
      return { final: res, attempts };
    }
  }
  // final failure
  return { final: { ok: false, status: 'all_failed' }, attempts };
}

// UI / Main check
function setStatusLabel(state, details = '') {
  statusEl.className = 'status ' + (state || 'unknown');
  if (state === 'up') statusEl.textContent = 'UP';
  else if (state === 'down') statusEl.textContent = 'DOWN';
  else statusEl.textContent = details || 'Unknown';
}

function updateUIFromStorage() {
  countEl.textContent = readNumber(KEY_COUNT, 0);
  lastCheckedEl.textContent = readString(KEY_LAST_CHECKED, '—');
  debugEl.textContent = readString(KEY_DEBUG, 'No debug info yet.');
  updateChart();
}

async function performCheck() {
  setStatusLabel('unknown', 'Checking…');
  const start = new Date().toLocaleString();
  const attemptResult = await fetchWithFallback();
  const res = attemptResult.final;
  // Build debug blob
  const debugObj = {
    time: start,
    target: TARGET_URL,
    attempts: attemptResult.attempts.map(a => {
      const copy = { mode: a.mode };
      if (a.proxy) copy.proxy = a.proxy;
      if (a.fetchUrl) copy.fetchUrl = a.fetchUrl;
      if (a.res) copy.status = a.res.status;
      if (a.res && a.res.error) copy.error = a.res.error;
      return copy;
    }),
    finalStatus: res.status,
    finalOk: !!res.ok,
    snippet: (res.text || '').slice(0, 2000)
  };
  saveString(KEY_DEBUG, JSON.stringify(debugObj, null, 2));
  saveString(KEY_LAST_CHECKED, start);
  debugEl.textContent = JSON.stringify(debugObj, null, 2);

  const analysis = analyzeResponse(res);
  if (analysis.state === 'down') {
    setStatusLabel('down');
    // increment once for transition to down OR always increment? We'll increment if previous state wasn't down
    const prev = readString(KEY_LAST_STATE, 'unknown');
    if (prev !== 'down') {
      const cur = readNumber(KEY_COUNT, 0);
      saveNumber(KEY_COUNT, cur + 1);
      incrementToday(1); // also add to today's aggregate
    } else {
      // still down but don't increment again to avoid multi-counting same down period
    }
    saveString(KEY_LAST_STATE, 'down');
  } else if (analysis.state === 'up') {
    setStatusLabel('up');
    saveString(KEY_LAST_STATE, 'up');
  } else {
    setStatusLabel('unknown', analysis.reason || 'Unknown');
    saveString(KEY_LAST_STATE, 'unknown');
  }

  // persist snippet and last checked
  saveString(KEY_LAST_CHECKED, start);
  updateUIFromStorage();
}

// Controls and handlers
function attachHandlers() {
  checkBtn.addEventListener('click', () => { performCheck().catch(e => { console.error(e); saveString(KEY_DEBUG, String(e)); debugEl.textContent = String(e); }); });

  resetBtn.addEventListener('click', () => {
    if (!confirm('Reset counter and history?')) return;
    saveNumber(KEY_COUNT, 0);
    saveString(KEY_LAST_STATE, 'unknown');
    saveString(KEY_LAST_CHECKED, '—');
    saveString(KEY_DEBUG, 'Reset by user.');
    clearHistory();
    updateUIFromStorage();
  });

  forceIncrementBtn.addEventListener('click', () => {
    const cur = readNumber(KEY_COUNT, 0);
    saveNumber(KEY_COUNT, cur + 1);
    incrementToday(1);
    updateUIFromStorage();
  });

  proxyInput.value = readString(KEY_PROXY, '');
  proxyInput.addEventListener('change', () => { saveString(KEY_PROXY, proxyInput.value.trim()); });
  proxyInput.addEventListener('blur', () => { saveString(KEY_PROXY, proxyInput.value.trim()); });

  testProxyBtn.addEventListener('click', async () => {
    const p = proxyInput.value.trim();
    if (!p) { alert('Enter a proxy prefix to test (eg. https://api.allorigins.win/raw?url=)'); return; }
    const testUrl = p + encodeURIComponent('https://example.com/');
    setStatusLabel('unknown', 'Testing proxy…');
    const r = await tryFetch(testUrl);
    alert(`Proxy test: ok=${r.ok}, status=${r.status}, error=${r.error || '(none)'}`);
    updateUIFromStorage();
  });

  exportBtn.addEventListener('click', () => {
    const data = {
      total_count: readNumber(KEY_COUNT, 0),
      last_state: readString(KEY_LAST_STATE, 'unknown'),
      last_checked: readString(KEY_LAST_CHECKED, ''),
      history: readHistory(),
      debug: readString(KEY_DEBUG, '')
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'korone_export.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  statusEl = $id('status');
  countEl = $id('count');
  lastCheckedEl = $id('lastChecked');
  debugEl = $id('debug');

  checkBtn = $id('checkBtn');
  resetBtn = $id('resetBtn');
  forceIncrementBtn = $id('forceIncrementBtn');
  proxyInput = $id('proxyInput');
  testProxyBtn = $id('testProxyBtn');
  exportBtn = $id('exportBtn');

  attachHandlers();
  initChart();

  // ensure defaults exist
  if (!localStorage.getItem(KEY_PROXY)) saveString(KEY_PROXY, '');

  // load initial UI
  countEl.textContent = readNumber(KEY_COUNT, 0);
  lastCheckedEl.textContent = readString(KEY_LAST_CHECKED, '—');
  debugEl.textContent = readString(KEY_DEBUG, 'No debug information yet.');

  // initial check (only if serving page over https; still we'll try)
  performCheck().catch(e => {
    console.warn('initial check failed', e);
    saveString(KEY_DEBUG, String(e));
    debugEl.textContent = String(e);
  });

  // periodic poll
  setInterval(() => { performCheck().catch(e => console.warn('poll failed', e)); }, POLL_INTERVAL_MS);
});
