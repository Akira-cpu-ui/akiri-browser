// Этап 1 — смоук-тест WebView2 хоста через CDP (порт из AKIRI_CDP_PORT=9227).
// node test-stage1.js [port]
const PORT = process.argv[2] || '9227';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws fail ' + url)); });
    const c = new Cdp(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) {
        const p = c.pending.get(m.id);
        c.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
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

async function targets() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return list.filter((t) => t.type === 'page');
}

async function main() {
  const list = await targets();
  const ui = list.find((t) => t.url.includes('akiri.local/index.html'));
  const tab0 = list.find((t) => t.url.includes('akiri.local/ntp.html')) || list.find((t) => t.url.includes('google.com'));
  if (!ui) throw new Error('UI target not found');
  console.log('UI target OK:', ui.url);

  const cdp = await Cdp.connect(ui.webSocketDebuggerUrl);
  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };

  // 1. мост
  const bridge = await evalJs(`typeof window.browserAPI`);
  console.log('1. browserAPI present:', bridge);
  const ntp = await evalJs(`window.browserAPI.ntpUrl`);
  console.log('2. ntpUrl:', ntp);
  if (bridge !== 'object') throw new Error('bridge missing');

  // 2. настройки совместимы
  const settings = await evalJs(`window.browserAPI.loadSettings().then(s => ({ homeUrl: s.homeUrl, accent: s.accent, restoreSession: s.restoreSession }))`);
  console.log('3. settings:', JSON.stringify(settings));
  if (settings.homeUrl !== 'https://www.google.com/') throw new Error('settings mismatch');

  // 3. версия приложения
  const appInfo = await evalJs(`window.browserAPI.appInfo().then(v => v.version + ' / ' + v.name)`);
  console.log('4. appInfo:', appInfo);

  // 4. вкладки сессии на месте
  const pagesBefore = (await targets()).filter((t) => !t.url.includes('akiri.local/index.html')).length;
  console.log('5. restored pages:', pagesBefore);
  if (pagesBefore < 1) throw new Error('no restored tabs');

  // 5-12. реальный пользовательский сценарий: кнопка «+» → адресная строка → назад/вперёд
  const before = await evalJs(`document.querySelectorAll('#tabs .tab').length`);
  await evalJs(`document.getElementById('btn-newtab').click()`);
  await sleep(1500);
  const after = await evalJs(`document.querySelectorAll('#tabs .tab').length`);
  console.log('6. new-tab button:', before, '->', after);
  if (after !== before + 1) throw new Error('new-tab button did not add a tab');
  const newId = await evalJs(`(function () { var a = document.querySelector('#tabs .tab.active'); return a ? a.dataset.id : null; })()`);
  console.log('7. active tab id:', newId);

  const navOk = await evalJs(`(async () => {
    document.getElementById('address').value = 'https://example.org/';
    document.getElementById('address-form').requestSubmit();
    return true;
  })()`);
  console.log('8. address submit:', navOk);
  await sleep(4000);
  const url = await evalJs(`window.browserAPI.tabState(${newId}).then(s => s.url)`);
  console.log('9. active tab url:', url);
  if (!url.includes('example.org')) throw new Error('address bar navigation failed: ' + url);

  await evalJs(`document.getElementById('btn-back').click()`);
  await sleep(3500);
  const afterBack = await evalJs(`window.browserAPI.tabState(${newId}).then(s => s.url)`);
  console.log('10. after UI back:', afterBack);
  await evalJs(`document.getElementById('btn-fwd').click()`);
  await sleep(3500);
  const afterFwd = await evalJs(`window.browserAPI.tabState(${newId}).then(s => s.url)`);
  console.log('11. after UI forward:', afterFwd);
  if (!afterFwd.includes('example.org')) throw new Error('back/forward failed: ' + afterFwd);

  // 8. скриншот UI для визуальной проверки
  await cdp.send('Page.enable');
  await sleep(400);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const fs = require('fs');
  fs.writeFileSync('stage1-ui.png', Buffer.from(shot.data, 'base64'));
  console.log('13. UI screenshot saved: stage1-ui.png (' + Math.round(shot.data.length / 1024) + ' KB)');

  // 9. подсказки поиска
  const sugg = await evalJs(`window.browserAPI.suggest('кот').then(a => a.length)`);
  console.log('14. suggest count:', sugg);

  console.log('\nALL STAGE-1 CHECKS PASSED ✅');
}

main().catch((e) => {
  console.error('TEST FAILED:', e.message);
  process.exit(1);
});
