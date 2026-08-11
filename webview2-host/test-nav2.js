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
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };
  const state = (id) => evalJs(`window.browserAPI.tabState(${id}).then(s => s.url + ' | back=' + s.canGoBack + ' fwd=' + s.canGoForward)`);

  // точное повторение падающего сценария: создание вкладки + ввод в адресную строку
  const id = await evalJs(`window.browserAPI.createTab('https://example.com/').then(i => i)`);
  console.log('tab', id, 'created');
  await sleep(3500);
  console.log('A:', await state(id));
  await evalJs(`(function () {
    document.getElementById('address').value = 'https://duckduckgo.com/';
    document.getElementById('address-form').requestSubmit();
    return true;
  })()`);
  await sleep(4500);
  console.log('B:', await state(id));
  await evalJs(`window.browserAPI.navTab(${id}, 'back')`);
  await sleep(3500);
  console.log('back:', await state(id));
  for (let i = 0; i < 3; i++) {
    await evalJs(`window.browserAPI.navTab(${id}, 'forward')`);
    await sleep(2000);
    console.log('forward #' + (i + 1) + ':', await state(id));
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
