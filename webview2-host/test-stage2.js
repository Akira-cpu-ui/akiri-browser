// Этап 2 — вкладки/сессия/адресная строка: порядок вкладок после перетаскивания,
// индикатор звука, подсказки адресной строки. Запускать с AKIRI_CDP_PORT=9227.
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
  const ui = list.find((t) => t.url.includes('index.html'));
  const ucdp = await Cdp.connect(ui.webSocketDebuggerUrl);
  const evalJs = async (expr) => {
    const r = await ucdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'EXC: ' + JSON.stringify(r.exceptionDetails.exception);
    return r.result.value;
  };
  const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const aTab = tabs.find((t) => t.type === 'page' && t.url.includes('google.com'));

  // ===== 1. порядок вкладок после перетаскивания =====
  const orderBefore = await evalJs(`Array.from(document.querySelectorAll('#tabs .tab')).map(t => t.dataset.id)`);
  console.log('1. tab order before:', orderBefore.join(','));
  // перетаскиваем первую НЕзакреплённую вкладку через одну (синтетические DragEvent)
  const dragOk = await evalJs(`(function () {
    var els = Array.from(document.querySelectorAll('#tabs .tab'));
    var from = els.find(function (el) { return !el.classList.contains('pinned'); });
    var rest = els.filter(function (el) { return el !== from; });
    var to = rest[2] || rest[1] || rest[0];
    if (!from || !to) return 'need 2+ unpinned tabs';
    var dt = new DataTransfer();
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    return 'dragged ' + from.dataset.id + ' -> ' + to.dataset.id;
  })()`);
  console.log('2. drag:', dragOk);
  await sleep(300);
  const orderAfter = await evalJs(`Array.from(document.querySelectorAll('#tabs .tab')).map(t => t.dataset.id)`);
  console.log('3. tab order after drag:', orderAfter.join(','));
  if (orderAfter.join(',') === orderBefore.join(',')) throw new Error('tab order did not change after drag');
  await sleep(800); // ждём debounce сохранения сессии
  const fs = require('fs');
  const home = require('os').homedir();
  const sessPath = home + '/AppData/Roaming/Akiri Browser/session.json';
  const sess = JSON.parse(fs.readFileSync(sessPath, 'utf8'));
  console.log('4. session.json urls:', sess.map((s) => (typeof s === 'string' ? s.slice(0, 24) : s.url.slice(0, 24))).join(' | '));

  // ===== 2. индикатор звука =====
  const acdp = await Cdp.connect(aTab.webSocketDebuggerUrl);
  await acdp.send('Runtime.evaluate', { expression: `document.body.innerHTML = '<video id="v" autoplay muted loop src="https://www.w3schools.com/html/mov_bbb.mp4" style="width:400px"></video>'` });
  await sleep(2500);
  const playing = await acdp.send('Runtime.evaluate', { expression: `(function () { var v = document.getElementById('v'); return v && !v.paused && !v.ended ? 'playing' : 'not-playing'; })()`, returnByValue: true });
  console.log('5. video:', playing.result.value);
  const audibleTab = await evalJs(`(function () {
    var el = Array.from(document.querySelectorAll('#tabs .tab')).find(t => t.dataset.id === ${orderBefore[0] === undefined ? '' : ''});
    return 'n/a';
  })()`);
  const audibleClass = await evalJs(`Array.from(document.querySelectorAll('#tabs .tab.audible')).map(t => t.dataset.id)`);
  console.log('6. audible tabs in UI:', audibleClass.join(',') || 'none');

  // ===== 3. подсказки адресной строки =====
  await evalJs(`(function () {
    var a = document.getElementById('address');
    a.value = 'кот';
    a.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(1500);
  const suggItems = await evalJs(`document.querySelectorAll('#suggest .sug-item').length`);
  console.log('7. suggestion items visible:', suggItems);
  await evalJs(`document.getElementById('address').value = ''; document.getElementById('address').dispatchEvent(new Event('input', { bubbles: true }));`);

  console.log('\nSTAGE-2 CHECKS DONE');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
