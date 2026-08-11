// Akiri 0.16.0 — проверка: страницы История/Загрузки, PiP-инъекция, IPC загрузок, скорость
'use strict';
const port = Number(process.argv[2] || 9223);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getTargets() { return (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('ws error'));
  });
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.reject(new Error('CDP ' + m.error.message)) : p.resolve(m);
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
  const m = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (!m) return 'NO-RESULT';
  if (m.exceptionDetails) return 'EXC: ' + JSON.stringify(m.exceptionDetails).slice(0, 200);
  const r = m.result && m.result.result;
  return r ? r.value : undefined;
}
async function main() {
  const results = [];
  const check = (n, ok, d) => { results.push({ name: n, ok: !!ok, detail: d || '' }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  (' + d + ')' : '')); };
  const targets0 = await getTargets();
  const shell = targets0.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!shell) { console.log('shell not found'); return; }
  const cdp = new Cdp(await connect(shell.webSocketDebuggerUrl));
  console.log('shell api check:', await evalIn(cdp, `!!window.browserAPI && !!window.browserAPI.historyUrl`));

  // 1. страница «История»
  await evalIn(cdp, `window.browserAPI.createTab(window.browserAPI.historyUrl).then(id=>window.__tid=id)`);
  await sleep(1500);
  let targets = await getTargets();
  const hist = targets.find((t) => t.type === 'page' && t.url.includes('history.html'));
  check('история: вкладка открылась', !!hist, hist ? hist.url.slice(0, 60) : 'нет');
  if (hist) {
    const hc = new Cdp(await connect(hist.webSocketDebuggerUrl));
    const title = await evalIn(hc, 'document.title');
    const hasSearch = await evalIn(hc, `!!document.getElementById('search')`);
    const itemsOrEmpty = await evalIn(hc, `!document.getElementById('empty').classList.contains('hidden') || document.querySelectorAll('.item').length > 0`);
    check('история: заголовок', /История/.test(title || ''), String(title));
    check('история: поиск', !!hasSearch);
    check('история: рендер списка/пусто', !!itemsOrEmpty);
    const cnt = await evalIn(hc, `window.pageAPI.loadHistory().then(l=>l.length)`);
    check('история: loadHistory IPC', typeof cnt === 'number', String(cnt));
  }

  // 2. страница «Загрузки»
  await evalIn(cdp, `window.browserAPI.createTab(window.browserAPI.downloadsUrl).then(id=>window.__tid2=id)`);
  await sleep(1500);
  targets = await getTargets();
  const dls = targets.find((t) => t.type === 'page' && t.url.includes('downloads.html'));
  check('загрузки: вкладка открылась', !!dls, dls ? dls.url.slice(0, 60) : 'нет');
  if (dls) {
    const dc = new Cdp(await connect(dls.webSocketDebuggerUrl));
    const title = await evalIn(dc, 'document.title');
    const hasClear = await evalIn(dc, `!!document.getElementById('clear')`);
    const emptyOk = await evalIn(dc, `!document.getElementById('empty').classList.contains('hidden') || document.querySelectorAll('.dl').length > 0`);
    check('загрузки: заголовок', /Загрузки/.test(title || ''), String(title));
    check('загрузки: кнопка очистки', !!hasClear);
    check('загрузки: рендер списка/пусто', !!emptyOk);
    const cnt = await evalIn(dc, `window.pageAPI.loadDownloads().then(l=>l.length)`);
    check('загрузки: loadDownloads IPC', typeof cnt === 'number', String(cnt));
  }

  // 3. PiP-инъекция на реальном сайте
  await evalIn(cdp, `window.browserAPI.createTab('https://www.google.com/').then(id=>window.__tid3=id)`);
  await sleep(3500);
  targets = await getTargets();
  const g = targets.find((t) => t.type === 'page' && t.url.startsWith('https://www.google.com'));
  if (g) {
    const gc = new Cdp(await connect(g.webSocketDebuggerUrl));
    const pip = await evalIn(gc, `window.__akiriPip === true`);
    check('PiP: скрипт внедрён', !!pip);
  } else check('PiP: гугл открылся', false);

  // 4. загрузка файла 2 МБ (локальный сервер с attachment): регистрация + скорость
  await evalIn(cdp, `window.browserAPI.createTab('http://127.0.0.1:8765/f.bin').then(id=>window.__tid4=id)`);
  await sleep(4500);
  targets = await getTargets();
  const dlPage = targets.find((t) => t.type === 'page' && t.url.includes('downloads.html'));
  let speed = null, dlCount = 0, dlState = '';
  if (dlPage) {
    const dc = new Cdp(await connect(dlPage.webSocketDebuggerUrl));
    const r = await evalIn(dc, `window.pageAPI.loadDownloads().then(l=>({n:l.length, first:l[0]||null}))`);
    if (r && r.n) {
      dlCount = r.n;
      const d = r.first;
      dlState = d ? d.state : '';
      speed = d && d.speed ? d.speed : null;
    }
  }
  check('загрузки: файл зарегистрирован (akiri-speed-test.bin)', dlCount > 0, 'записей: ' + dlCount + ', state=' + dlState);
  check('загрузки: скорость посчитана', typeof speed === 'number', speed ? Math.round(speed / 1024) + ' КБ/с' : 'нет');

  const failed = results.filter((r) => !r.ok);
  console.log('\nИтог: ' + (results.length - failed.length) + '/' + results.length);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(2); });
