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
const pages = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page' && !t.url.includes('index.html')).length;
const ctrlT = async (cdp) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 't', code: 'KeyT', windowsVirtualKeyCode: 84 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 't', code: 'KeyT', windowsVirtualKeyCode: 84 });
};
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const ui = list.find((t) => t.url.includes('index.html'));
  const tab = list.find((t) => t.url.includes('google.com'));
  console.log('pages before:', await pages());

  // 1. UI-страница
  const uicdp = await Cdp.connect(ui.webSocketDebuggerUrl);
  await ctrlT(uicdp);
  await sleep(1500);
  console.log('after Ctrl+T on UI:', await pages());

  // 2. вкладка (активная страница)
  const tcdp = await Cdp.connect(tab.webSocketDebuggerUrl);
  await ctrlT(tcdp);
  await sleep(1500);
  console.log('after Ctrl+T on tab:', await pages());
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
