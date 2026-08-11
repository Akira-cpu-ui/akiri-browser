const PORT = '9227';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws fail')); });
    const c = new Cdp(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) {
        const p = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const ui = list.find((t) => t.url.includes('akiri.local/index.html'));
  const ucdp = await Cdp.connect(ui.webSocketDebuggerUrl);
  const evalJs = async (expr) => {
    const r = await ucdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'EXC: ' + JSON.stringify(r.exceptionDetails.exception);
    return r.result.value;
  };
  const activeTabId = () => evalJs(`(function () { var a = document.querySelector('#tabs .tab.active'); return a ? a.dataset.id : null; })()`);

  // 1. кнопка «+» — новая вкладка через app.js
  const before = await evalJs(`document.querySelectorAll('#tabs .tab').length`);
  await evalJs(`document.getElementById('btn-newtab').click()`);
  await sleep(1500);
  const after = await evalJs(`document.querySelectorAll('#tabs .tab').length`);
  const tid = await activeTabId();
  console.log('1. tabs in UI:', before, '->', after, '| active id:', tid);
  if (after !== before + 1) throw new Error('new-tab button did not add a tab');

  // 2. адресная строка
  await evalJs(`(function () {
    var a = document.getElementById('address');
    a.value = 'https://example.org/';
    a.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('address-form').requestSubmit();
    return true;
  })()`);
  await sleep(4000);
  const url = await evalJs(`window.browserAPI.tabState(${tid}).then(s => s.url)`);
  console.log('2. active tab URL after address submit:', url);
  if (!url.includes('example.org')) throw new Error('address bar navigation failed: ' + url);

  // 3. назад через кнопку UI
  await evalJs(`document.getElementById('btn-back').click()`);
  await sleep(3500);
  const backUrl = await evalJs(`window.browserAPI.tabState(${tid}).then(s => s.url)`);
  console.log('3. after UI back:', backUrl);

  // 4. вперёд через кнопку UI
  await evalJs(`document.getElementById('btn-fwd').click()`);
  await sleep(3500);
  const fwdUrl = await evalJs(`window.browserAPI.tabState(${tid}).then(s => s.url)`);
  console.log('4. after UI forward:', fwdUrl);

  // 5. вкладка с NTP: создаём через «+», смотрим URL
  await evalJs(`document.getElementById('btn-newtab').click()`);
  await sleep(1500);
  const tid2 = await activeTabId();
  const ntpUrl = await evalJs(`window.browserAPI.tabState(${tid2}).then(s => s.url)`);
  console.log('5. new NTP tab url:', ntpUrl);

  console.log('\nREAL USER FLOW OK ✅');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
