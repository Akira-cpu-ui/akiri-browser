// Login step-1 risk-check test: submit a bogus email on the real Google login form.
// PASS = Google says "account not found" (browser passed the risk check).
// FAIL = Google says "this browser or app may not be secure".
const http = require('http');
const port = process.argv[2] || '9223';

function getTabs() {
  return new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${port}/json/list`, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => res(JSON.parse(b)));
    }).on('error', rej);
  });
}
function openWs(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => res(ws));
    ws.addEventListener('error', () => rej(new Error('ws')));
  });
}
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const j = JSON.parse(ev.data);
      if (j.id && this.pending.has(j.id)) {
        this.pending.get(j.id)(j);
        this.pending.delete(j.id);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tabs = await getTabs();
  const t = tabs.find((x) => x.type === 'page' && x.url.includes('google.com')) || tabs.find((x) => x.type === 'page');
  const ws = await openWs(t.webSocketDebuggerUrl);
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const url =
    'https://accounts.google.com/signin/v2/identifier?continue=https%3A%2F%2Fwww.google.com%2F&flowName=GlifWebSignIn&flowEntry=ServiceLogin';
  await cdp.send('Page.navigate', { url });
  await sleep(8000);

  const evalJs = async (expr) => {
    const m = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return m.result && m.result.result ? m.result.result.value : 'EXC:' + JSON.stringify(m.result.exceptionDetails || {}).slice(0, 120);
  };

  const state1 = await evalJs(
    'JSON.stringify({title:document.title, text:(document.body?document.body.innerText.slice(0,200):""), inputs:[...document.querySelectorAll("input")].map(i=>({type:i.type,name:i.name,id:i.id}))})'
  );
  console.log('STEP1 page:', state1);

  // type the bogus email
  const typed = await evalJs(`(() => {
    const inp = document.querySelector('input[type="email"], input[name="identifier"], #identifierId');
    if (!inp) return 'NO-INPUT';
    inp.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, 'akiri.test.00001@gmail.com');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 'TYPED:' + inp.value;
  })()`);
  console.log('TYPED:', typed);
  await sleep(600);

  // submit — press Enter (React listens to keydown) then click Next as fallback
  const clicked = await evalJs(`(() => {
    const inp = document.querySelector('#identifierId');
    const btn = document.querySelector('button[type="submit"], #identifierNext, [jsname="LgbsSe"]');
    let r = [];
    if (inp) {
      inp.focus();
      for (const t of ['keydown','keypress','keyup']) {
        inp.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
      r.push('enter');
    }
    if (btn) { btn.click(); r.push('click'); }
    return r.join('+') || 'NO-INPUT';  
  })()`);
  console.log('SUBMIT:', clicked);

  await sleep(8000);
  const state2 = await evalJs(
    'JSON.stringify({url:location.href, title:document.title, text:(document.body?document.body.innerText.slice(0,350):"")})'
  );
  console.log('STEP2 page:', state2);
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
