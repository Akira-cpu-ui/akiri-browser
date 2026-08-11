// Capture all request headers to accounts.google.com during a login attempt.
// Usage: node tools/hdr-capture.js <port> [url]
const http = require('http');
const port = process.argv[2] || '9223';
const URL =
  process.argv[3] ||
  'https://accounts.google.com/signin/v2/identifier?continue=https%3A%2F%2Fwww.google.com%2F&flowName=GlifWebSignIn&flowEntry=ServiceLogin';

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
  const t = tabs.find((x) => x.type === 'page');
  const ws = await openWs(t.webSocketDebuggerUrl);
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  const requests = [];
  ws.addEventListener('message', (ev) => {
    const j = JSON.parse(ev.data);
    if (j.method === 'Network.requestWillBeSentExtraInfo') {
      const h = j.params.headers || {};
      if (/accounts\.google\.com/.test(h[':authority'] || '')) {
        requests.push({ m: 'WIRE', url: (h[':method'] || '') + ' ' + (h[':path'] || '').slice(0, 120), headers: h });
      }
    }
    if (j.method === 'Network.requestWillBeSent') {
      const r = j.params.request;
      if (/accounts\.google\.com/.test(r.url)) {
        requests.push({ m: r.method, url: r.url.slice(0, 140), headers: r.headers });
      }
    }
  });

  await cdp.send('Page.navigate', { url: URL });
  await sleep(7000);

  // fill + submit bogus email
  const done = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const inp = document.querySelector('#identifierId');
      if (!inp) return 'NO-INPUT';
      inp.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'akiri.test.00001@gmail.com');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      for (const t of ['keydown','keypress','keyup']) {
        inp.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
      return 'ok';
    })()`,
    returnByValue: true,
  });
  console.log('submit:', done.result && done.result.result && done.result.result.value);
  await sleep(6000);

  console.log('=== REQUESTS (' + requests.length + ') ===');
  for (const r of requests) {
    console.log('\n--- ' + r.m + ' ' + r.url);
    for (const [k, v] of Object.entries(r.headers)) {
      console.log('  ' + k + ': ' + String(v).slice(0, 160));
    }
  }
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
