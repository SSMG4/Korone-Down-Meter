// Korone Down Meter - improved client-side script
// - Robust CORS handling: try direct fetch first, then try built-in proxies, then user-specified proxy.
// - Stores counter, last state and time-series history in localStorage (works on GitHub Pages).
// - Adds debugging output and a simple Chart.js graph.
// - Provides Export / Reset / Force increment and Proxy test utilities.

const DEFAULT_PROXY = 'https://api.allorigins.win/raw?url='; // fallback
const BUILTIN_PROXIES = [
  'https://api.allorigins.win/raw?url=',
  'https://cors.bridged.cc/',
  'https://thingproxy.freeboard.io/fetch/',
];

// localStorage keys
const KEY_COUNT = 'korone_down_count';
const KEY_LAST_STATE = 'korone_last_state';
const KEY_PROXY = 'korone_proxy';
const KEY_LAST_CHECKED = 'korone_last_checked';
const KEY_SNIPPET = 'korone_last_snippet';
const KEY_HISTORY = 'korone_history_v1'; // array of {t, state, count, probe}

// UI elements (will be set after DOM ready)
let statusEl, countEl, lastCheckedEl, snippetEl, debugEl;
let checkBtn, resetBtn, forceIncrementBtn, proxyInput, testProxyBtn, exportBtn;
let targetInput, phraseInput;
let chart;

function $(id){ return document.getElementById(id); }

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

function nowISO() { return new Date().toISOString(); }

function pushHistory(entry) {
  try {
    const raw = localStorage.getItem(KEY_HISTORY);
    const arr = raw ? JSON.parse(raw) : [];
    arr.push(entry);
    // cap history to 1000 entries
    if (arr.length > 1000) arr.splice(0, arr.length - 1000);
    localStorage.setItem(KEY_HISTORY, JSON.stringify(arr));
  } catch (e) { console.error('history push error', e); }
}
function readHistory() {
  try {
    const raw = localStorage.getItem(KEY_HISTORY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}
function clearHistory() { localStorage.removeItem(KEY_HISTORY); }

// UI updates
function setStatusLabel(state, details = '') {
  // state: 'up'|'down'|'unknown'
  statusEl.className = 'status ' + (state || 'unknown');
  if (state === 'up') statusEl.textContent = 'UP';
  else if (state === 'down') statusEl.textContent = 'DOWN';
  else statusEl.textContent = details || 'Unknown';
}

function updateUIFromStorage() {
  const count = readNumber(KEY_COUNT, 0);
  countEl.textContent = count;

  const lastChecked = readString(KEY_LAST_CHECKED, '—');
  lastCheckedEl.textContent = lastChecked;

  const snippet = readString(KEY_SNIPPET, 'No snippet yet.');
  debugEl.textContent = snippet;
  updateChart();
}

// Chart
function initChart() {
  const ctx = document.getElementById('historyChart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Down count',
        data: [],
        borderColor: '#ff7ab6',
        backgroundColor: 'rgba(255,122,166,0.08)',
        tension: 0.25,
        pointRadius: 3,
        pointBackgroundColor: '#ff7ab6',
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#9aa0a6' } },
        y: { beginAtZero: true, ticks: { color: '#9aa0a6' } }
      },
      plugins: {
        legend: { labels: { color: '#e8eef7' } },
        tooltip: { enabled: true }
      }
    }
  });
  updateChart();
}

function updateChart() {
  if (!chart) return;
  const hist = readHistory();
  const labels = hist.map(h => new Date(h.t).toLocaleString());
  const data = hist.map(h => h.count);
  chart.data.labels = labels;
  chart.data.datasets[0].data = data;
  chart.update();
}

// Fetching & CORS handling
async function tryFetch(url, opts = {}) {
  // returns {ok:boolean, status, text, error, responseType, headers: {}}
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(url, { signal: controller.signal, ...opts });
    clearTimeout(timeout);
    let text = '';
    try { text = await resp.text(); } catch (e) { text = ''; }
    const headers = {};
    try {
      for (const pair of resp.headers.entries()) headers[pair[0]] = pair[1];
    } catch (e) { /* may be blocked by CORS for some headers */ }
    return { ok: resp.ok, status: resp.status, text, responseType: resp.type, headers };
  } catch (err) {
    return { ok: false, status: 'error', error: String(err) };
  }
}

async function fetchTargetWithFallback(targetUrl, proxyToUse) {
  // Try direct fetch first. If direct fails due to CORS or network, try the proxies.
  // proxyToUse (string) - if provided we'll try it first.
  const tried = [];
  // attempt direct
  tried.push({ method: 'direct' });
  const direct = await tryFetch(targetUrl);
  if (direct.ok && typeof direct.text === 'string') {
    return { result: direct, probe: 'direct', tried };
  }
  // If direct failed or not OK, try proxies.
  // Build list: custom provided by user, then builtins.
  const userProxy = (readString(KEY_PROXY, '') || '').trim();
  const proxies = [];
  if (proxyToUse) proxies.push(proxyToUse);
  if (userProxy) proxies.push(userProxy);
  for (const p of BUILTIN_PROXIES) if (!proxies.includes(p)) proxies.push(p);
  if (!proxies.length) proxies.push(DEFAULT_PROXY);

  for (const p of proxies) {
    // If the proxy URL doesn't look like it wants the raw URL appended, we just append by default.
    // This is best-effort; different proxies may require different shapes.
    let fetchUrl = p + encodeURIComponent(targetUrl);
    tried.push({ method: 'proxy', proxy: p, fetchUrl });
    const r = await tryFetch(fetchUrl);
    if (r.ok || typeof r.text === 'string') {
      // if we got a response (even not ok) use it - caller decides detection.
      return { result: r, probe: `proxy:${p}`, tried };
    }
    // otherwise keep trying others
  }
  // All attempts failed
  return { result: { ok: false, status: 'all-failed' }, probe: 'none', tried };
}

// Main check
async function checkNow() {
  setStatusLabel('unknown', 'Checking…');
  const prevState = readString(KEY_LAST_STATE, 'unknown');
  const target = targetInput.value.trim();
  const phrase = phraseInput.value.trim() || 'site is currently down';

  if (!/^https?:\/\//i.test(target)) {
    setStatusLabel('unknown', 'Invalid URL');
    debugEl.textContent = 'Target URL must include https:// or http://';
    return;
  }

  const probeStart = nowISO();
  const fallbackRes = await fetchTargetWithFallback(target);
  const res = fallbackRes.result;
  const probe = fallbackRes.probe;
  // Save snippet and last checked
  const snippet = (res && res.text) ? (res.text.slice(0, 4000)) : (res.error || `No response (status=${res.status})`);
  saveString(KEY_SNIPPET, snippet);
  saveString(KEY_LAST_CHECKED, new Date().toLocaleString());

  // Update debug area with structured info
  const debugInfo = {
    time: new Date().toLocaleString(),
    target,
    probe,
    attempts: fallbackRes.tried,
    fetchStatus: res.status,
    ok: !!res.ok,
    responseType: res.responseType || '(unknown)',
    headers: res.headers || {},
    error: res.error || null,
    snippet: snippet.slice(0, 2000)
  };
  debugEl.textContent = JSON.stringify(debugInfo, null, 2);

  if (!res.ok && !res.text) {
    // Fetch error (network or CORS)
    setStatusLabel('unknown', `Fetch error (${res.status})`);
    // record history entry with probe info
    const count = readNumber(KEY_COUNT, 0);
    pushHistory({ t: probeStart, state: 'unknown', count, probe, reason: res.error || res.status });
    updateUIFromStorage();
    return;
  }

  const found = (res.text || '').toLowerCase().includes(phrase.toLowerCase());
  if (found) {
    setStatusLabel('down');
    if (prevState !== 'down') {
      const curCount = readNumber(KEY_COUNT, 0);
      saveNumber(KEY_COUNT, curCount + 1);
    }
    saveString(KEY_LAST_STATE, 'down');
  } else {
    setStatusLabel('up');
    saveString(KEY_LAST_STATE, 'up');
  }

  // persist snippet and add history point
  saveString(KEY_SNIPPET, snippet || '(empty response)');
  saveString(KEY_LAST_CHECKED, new Date().toLocaleString());
  const countNow = readNumber(KEY_COUNT, 0);
  pushHistory({ t: probeStart, state: (found ? 'down' : 'up'), count: countNow, probe });
  updateUIFromStorage();
}

// Controls
function attachHandlers() {
  checkBtn.addEventListener('click', () => checkNow());

  resetBtn.addEventListener('click', () => {
    if (!confirm('Reset the down counter and history?')) return;
    saveNumber(KEY_COUNT, 0);
    saveString(KEY_LAST_STATE, 'unknown');
    saveString(KEY_LAST_CHECKED, '—');
    saveString(KEY_SNIPPET, 'No snippet yet.');
    clearHistory();
    updateUIFromStorage();
  });

  forceIncrementBtn.addEventListener('click', () => {
    const cur = readNumber(KEY_COUNT, 0);
    saveNumber(KEY_COUNT, cur + 1);
    // add history entry to reflect manual increment
    pushHistory({ t: nowISO(), state: 'manual', count: cur + 1, probe: 'manual' });
    updateUIFromStorage();
  });

  proxyInput.value = readString(KEY_PROXY, '');
  proxyInput.addEventListener('change', () => {
    saveString(KEY_PROXY, proxyInput.value.trim());
  });
  proxyInput.addEventListener('blur', () => {
    saveString(KEY_PROXY, proxyInput.value.trim());
  });

  testProxyBtn.addEventListener('click', async () => {
    const proxy = proxyInput.value.trim();
    if (!proxy) {
      alert('Please enter a proxy URL prefix to test (e.g. https://api.allorigins.win/raw?url=)');
      return;
    }
    setStatusLabel('unknown', 'Testing proxy…');
    const testTarget = 'https://example.com/';
    const fetchUrl = proxy + encodeURIComponent(testTarget);
    const res = await tryFetch(fetchUrl);
    const ok = res.ok || (typeof res.text === 'string' && res.text.includes('Example Domain'));
    alert(`Proxy test result: ok=${ok}, status=${res.status}, error=${res.error || '(none)'}`);
    updateUIFromStorage();
  });

  exportBtn.addEventListener('click', () => {
    const data = {
      count: readNumber(KEY_COUNT, 0),
      last_state: readString(KEY_LAST_STATE, 'unknown'),
      last_checked: readString(KEY_LAST_CHECKED, ''),
      history: readHistory()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'korone_down_export.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  // get elements now
  statusEl = $('status');
  countEl = $('count');
  lastCheckedEl = $('lastChecked');
  debugEl = $('debug');

  checkBtn = $('checkBtn');
  resetBtn = $('resetBtn');
  forceIncrementBtn = $('forceIncrementBtn');
  proxyInput = $('proxyInput');
  testProxyBtn = $('testProxyBtn');
  exportBtn = $('exportBtn');
  targetInput = $('targetInput');
  phraseInput = $('phraseInput');

  // create inputs if missing (safety)
  if (!targetInput) {
    console.warn('targetInput not found, creating a fallback.');
    const inp = document.createElement('input');
    inp.id = 'targetInput';
    document.body.appendChild(inp);
    targetInput = inp;
  }
  if (!phraseInput) {
    const inp = document.createElement('input');
    inp.id = 'phraseInput';
    document.body.appendChild(inp);
    phraseInput = inp;
  }

  attachHandlers();
  initChart();

  // Ensure proxy default persists if empty (keeps behavior similar to previous)
  if (!localStorage.getItem(KEY_PROXY)) {
    saveString(KEY_PROXY, '');
    proxyInput.value = '';
  }

  // Load UI values
  const initialCount = readNumber(KEY_COUNT, 0);
  countEl.textContent = initialCount;
  lastCheckedEl.textContent = readString(KEY_LAST_CHECKED, '—');
  debugEl.textContent = readString(KEY_SNIPPET, 'No snippet yet.');

  // Run an initial check but don't spam proxies on page load if user didn't set a target
  const initialTarget = targetInput.value.trim();
  if (initialTarget) {
    checkNow().catch(e => {
      console.error('initial check failed', e);
      debugEl.textContent = String(e);
    });
  } else {
    setStatusLabel('unknown', 'No target set');
  }

  // Poll periodically (every 60s)
  setInterval(() => {
    if (targetInput.value.trim()) checkNow();
  }, 60 * 1000);
});
