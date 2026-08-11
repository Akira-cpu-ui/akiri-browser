// Akiri Browser — проверка установленной/запущенной версии через CDP.
// Использует встроенный WebSocket Node 22+.
// Запуск: node tools/verify.js <port>
'use strict';

const port = Number(process.argv[2] || 9223);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('ws error: ' + (e && e.message)));
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function evalIn(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  return res.result ? res.result.value : undefined;
}

async function poll(cdp, expression, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const v = await evalIn(cdp, expression);
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(300);
  }
}

async function main() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail || '' });
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
  };

  let targets;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await getTargets();
      if (targets && targets.length) break;
    } catch (_) { /* app not up yet */ }
    await sleep(500);
  }
  if (!targets || !targets.length) throw new Error('No CDP targets on port ' + port);

  // главное окно (интерфейс браузера)
  const mainT = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!mainT) throw new Error('Main window target not found');
  const cdp = new Cdp(await connect(mainT.webSocketDebuggerUrl));

  // ждём, пока init() закончит восстановление вкладок
  await poll(cdp, `!!document.querySelector('.tab.active')`, 10000);

  const r = await evalIn(cdp, `(() => {
    const r = document.getElementById('views').getBoundingClientRect();
    return { y: Math.round(r.top), h: Math.round(r.height), innerH: window.innerHeight };
  })()`);
  check('область страницы: y > 60', r.y > 60, `y=${r.y}`);
  check('область страницы: h занимает почти всё окно', r.h > r.innerH * 0.75, `h=${r.h}/${r.innerH}`);

  // адресная строка после запуска
  const addr = await evalIn(cdp, `document.getElementById('address').value`);
  check('адресная строка показывает домен (не file://)', /^[\w.-]+$/.test(addr), `value=${JSON.stringify(addr)}`);

  // подсказки Google (сеть может отвечать медленно — ждём до 8с)
  await evalIn(cdp, `(() => {
    const a = document.getElementById('address');
    a.value = 'погода';
    a.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const sug = await poll(cdp, `(() => {
    const s = document.getElementById('suggest');
    return !s.classList.contains('hidden') && s.querySelectorAll('.sug-item').length > 0
      ? s.querySelectorAll('.sug-item').length : null;
  })()`, 8000);
  check('подсказки Google появляются', !!sug, `count=${sug || 0}`);

  // закрыть подсказки как настоящий пользователь: Esc на адресной строке
  await evalIn(cdp, `(() => {
    document.getElementById('address').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  const restoredH = await poll(cdp, `(() => {
    const hidden = document.getElementById('suggest').classList.contains('hidden');
    const h = Math.round(document.getElementById('views').getBoundingClientRect().height);
    return hidden && h > 600 ? h : null;
  })()`, 4000);
  check('подсказки закрылись, страница вернулась на весь экран', !!restoredH, `h=${restoredH || '?'}`);

  // новая вкладка
  await evalIn(cdp, `document.getElementById('btn-newtab').click();`);
  await sleep(1200);
  const nt = await evalIn(cdp, `(() => ({
    count: document.querySelectorAll('.tab').length,
    activeTitle: (document.querySelector('.tab.active .tab-title') || {}).textContent || '',
    address: document.getElementById('address').value,
    viewsH: Math.round(document.getElementById('views').getBoundingClientRect().height),
  }))()`);
  check('новая вкладка создалась', nt.count >= 2, `tabs=${nt.count}`);
  check('новая вкладка активна (Новая вкладка)', nt.activeTitle.includes('Новая вкладка'), nt.activeTitle);
  check('адресная строка пустая на новой вкладке (нет file://)', nt.address === '', `value=${JSON.stringify(nt.address)}`);
  check('область страницы не схлопнулась', nt.viewsH > 600, `h=${nt.viewsH}`);

  // закрыть новую вкладку
  await evalIn(cdp, `document.querySelector('.tab.active .tab-close').click();`);
  await sleep(800);

  // вкладка-страница: проверим viewport самой страницы через её CDP-таргет
  let vpOk = false;
  let vpStr = '?';
  for (let i = 0; i < 30; i++) {
    targets = await getTargets();
    const pageT = targets.find((t) => t.type === 'page' && t.url.includes('google.com'));
    if (pageT) {
      const pcdp = new Cdp(await connect(pageT.webSocketDebuggerUrl));
      const vp = await evalIn(pcdp, `({ w: window.innerWidth, h: window.innerHeight })`);
      vpStr = `${Math.round(vp.w)}x${Math.round(vp.h)}`;
      vpOk = vp.h > 600;
      break;
    }
    await sleep(400);
  }
  check('страница Google рендерится на весь экран', vpOk, `viewport=${vpStr}`);

  const failed = results.filter((x) => !x.ok);
  console.log('\n' + (failed.length ? `FAILED: ${failed.length}` : 'ALL PASS') + ` (${results.length} checks)`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('VERIFY ERROR:', e.message);
  process.exit(2);
});
