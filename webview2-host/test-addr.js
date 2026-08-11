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

  console.log('form exists:', await evalJs(`!!document.getElementById('address-form')`));
  console.log('input exists:', await evalJs(`!!document.getElementById('address')`));

  // 1. прямой вызов bridge navigateTab (хост-путь)
  const id = await evalJs(`window.browserAPI.createTab('https://example.com/').then(i => i)`);
  console.log('tab', id, 'created');
  await sleep(3500);
  const directNav = await evalJs(`window.browserAPI.navigateTab(${id}, 'https://example.org/').then(() => 'ok')`);
  console.log('direct navigateTab:', directNav);
  await sleep(3500);
  console.log('state after direct nav:', await evalJs(`window.browserAPI.tabState(${id}).then(s => s.url)`));

  // 2. форма: слушаем submit, потом шлём
  await evalJs(`(function () {
    window.__submitLog = [];
    document.getElementById('address-form').addEventListener('submit', function () { window.__submitLog.push('submit-fired'); }, true);
    document.getElementById('address').value = 'https://example.org/';
    document.getElementById('address-form').requestSubmit();
    return window.__submitLog;
  })()`);
  await sleep(300);
  console.log('submit events:', JSON.stringify(await evalJs(`window.__submitLog`)));
  console.log('address value now:', JSON.stringify(await evalJs(`document.getElementById('address').value`)));

  // 3. что говорит app.js — вкладки в DOM
  console.log('tab count in UI:', await evalJs(`document.querySelectorAll('#tabs .tab').length`));
  console.log('active tab in UI:', await evalJs(`(function () { var a = document.querySelector('#tabs .tab.active'); return a ? a.dataset.id : 'NONE'; })()`));

  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
