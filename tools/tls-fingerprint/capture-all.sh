#!/bin/bash
# Захват TLS ClientHello трёх браузеров на этой машине.
#   WebView2 (Edge 151) — через CDP хоста (9227)
#   Electron 33 (Chromium 130) — через CDP (9231)
#   Chrome 151 — запуск с URL
# Результат: out/webview2.bin, out/electron.bin, out/chrome.bin
set -e
cd "$(dirname "$0")"
rm -f out/*.bin capture.log

# --- 1. один сервер захвата ---
OLD=$(netstat -ano 2>/dev/null | grep ":9443" | grep -i listen | awk '{print $NF}' | sort -u)
if [ -n "$OLD" ]; then taskkill //F //PID $OLD > /dev/null 2>&1 || true; sleep 1; fi
(nohup python capture-server.py 9443 > capture.log 2>&1 &)
sleep 1

# --- 2. WebView2-хост (уже запущен, CDP 9227) ---
cat > /tmp/cap-wv2.js << 'EOF'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws fail')); });
    const c = new Cdp(ws);
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && c.pending.has(m.id)) { const p = c.pending.get(m.id); c.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
    return c;
  }
  send(method, params = {}) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
}
(async () => {
  const list = await (await fetch('http://127.0.0.1:9227/json/list')).json();
  const tab = list.find((t) => t.type === 'page' && !t.url.includes('akiri.local')) || list.find((t) => t.type === 'page');
  if (!tab) { console.log('no tab'); process.exit(1); }
  const original = tab.url;
  const c = await Cdp.connect(tab.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Page.navigate', { url: 'https://127.0.0.1:9443/cap/webview2' });
  await sleep(5000);
  await c.send('Page.navigate', { url: original });   // вернуть вкладку на место
  await sleep(3000);
  console.log('webview2 captured (restored to', original.slice(0, 40) + ')');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
EOF
node /tmp/cap-wv2.js
mv -f out/last.bin out/webview2.bin

# --- 3. Electron 33 (запущен ранее, CDP 9231) ---
cat > /tmp/cap-elec.js << 'EOF'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws fail')); });
    const c = new Cdp(ws);
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && c.pending.has(m.id)) { const p = c.pending.get(m.id); c.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
    return c;
  }
  send(method, params = {}) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
}
(async () => {
  const list = await (await fetch('http://127.0.0.1:9231/json/list')).json();
  const tab = list.find((t) => t.type === 'page') || null;
  if (!tab) { console.log('no tab'); process.exit(1); }
  const c = await Cdp.connect(tab.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Page.navigate', { url: 'https://127.0.0.1:9443/cap/electron' });
  await sleep(5000);
  console.log('electron captured');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
EOF
node /tmp/cap-elec.js
mv -f out/last.bin out/electron.bin

# --- 4. Реальный Chrome 151 ---
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
"$CHROME" --user-data-dir="$TEMP/akiri-chrome-fp" --no-first-run --no-default-browser-check \
  https://127.0.0.1:9443/cap/chrome > /dev/null 2>&1 &
sleep 7
mv -f out/last.bin out/chrome.bin
taskkill //F //IM chrome.exe > /dev/null 2>&1 || true

echo "=== done ==="
ls -la out/
