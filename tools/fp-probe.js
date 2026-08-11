// Fingerprint audit — what Google's risk engine can see.
// Usage: node tools/fp-probe.js <port> [url]
const http = require('http');
// Node >= 22: built-in global WebSocket

const port = process.argv[2] || '9223';
const url = process.argv[3] || 'https://accounts.google.com/v3/signin/identifier';

function getTarget() {
  return new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${port}/json/list`, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => {
        const list = JSON.parse(b);
        const t = list.find((x) => x.type === 'page' && !x.url.startsWith('devtools://'));
        res(t);
      });
    }).on('error', rej);
  });
}

function openWs(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => res(ws));
    ws.addEventListener('error', (e) => rej(new Error('ws error')));
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

async function evalIn(tab, expr) {
  const ws = await openWs(tab.webSocketDebuggerUrl);
  const cdp = new Cdp(ws);
  const m = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  ws.close();
  if (m.error) return 'CDPERR: ' + JSON.stringify(m.error);
  if (m.result && m.result.exceptionDetails) return 'EXC: ' + JSON.stringify(m.result.exceptionDetails).slice(0, 400);
  if (m.result && m.result.result) return m.result.result.value;
  return 'RAW: ' + JSON.stringify(m).slice(0, 400);
}

const PROBE = `(async () => {
  const out = {};
  out.ua = navigator.userAgent;
  out.vendor = navigator.vendor;
  out.platform = navigator.platform;
  out.webdriver = navigator.webdriver;
  out.languages = navigator.languages;
  out.hwConcurrency = navigator.hardwareConcurrency;
  out.deviceMemory = navigator.deviceMemory || null;
  out.plugins = Array.from(navigator.plugins || []).map(p => p.name);
  out.mimeTypes = (navigator.mimeTypes || []).length;
  out.uaData = await (async () => {
    try {
      const d = navigator.userAgentData;
      if (!d) return null;
      const h = await d.getHighEntropyValues(['architecture','bitness','fullVersionList','model','platformVersion','uaFullVersion','wow64']);
      return { brands: d.brands, mobile: d.mobile, platform: d.platform, high: h };
    } catch (e) { return 'EXC:' + e.message; }
  })();
  out.chrome = (() => {
    const c = window.chrome || {};
    return {
      keys: Object.keys(c),
      runtime: typeof c.runtime,
      loadTimes: typeof c.loadTimes,
      csi: typeof c.csi,
      app: typeof c.app,
      webstore: typeof c.webstore,
    };
  })();
  out.windowChromeClass = (() => {
    // Chrome 130+: window.chrome is a real JS class named "Chrome"
    try { return window.chrome && window.chrome.constructor ? window.chrome.constructor.name : null; } catch (e) { return 'EXC'; }
  })();
  out.permissions = (() => {
    try { return { query: typeof navigator.permissions.query, midi: !!(navigator.permissions && navigator.permissions.query) }; } catch (e) { return 'EXC'; }
  })();
  out.screen = { w: screen.width, h: screen.height, availW: screen.availWidth, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth };
  out.windowSize = { outerW: window.outerWidth, outerH: window.outerHeight, innerW: window.innerWidth, innerH: window.innerHeight, screenX: window.screenX };
  out.deviceMemory2 = (() => { try { return navigator.deviceMemory; } catch (e) { return 'EXC'; } })();
  out.gpu = (() => {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return null;
      const e = gl.getExtension('WEBGL_debug_renderer_info');
      return { renderer: gl.getParameter(e.UNMASKED_RENDERER_WEBGL), vendor: gl.getParameter(e.UNMASKED_VENDOR_WEBGL) };
    } catch (e) { return 'EXC:' + e.message; }
  })();
  out.media = (() => {
    const m = navigator.mediaDevices || {};
    return { mediaDevices: !!navigator.mediaDevices, enumerate: typeof m.enumerateDevices };
  })();
  out.credentials = (() => { try { return { get: typeof navigator.credentials.get, create: typeof navigator.credentials.create }; } catch (e) { return 'EXC'; } })();
  out.webauthn = (() => { try { return { auth: typeof PublicKeyCredential, isUVPA: typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable }; } catch (e) { return 'EXC'; } })();
  out.storage = (() => { try { return { indexedDB: !!indexedDB, serviceWorker: 'serviceWorker' in navigator }; } catch (e) { return 'EXC'; } })();
  out.iframes = document.querySelectorAll('iframe').length;
  out.pageText = document.body ? document.body.innerText.slice(0, 300) : '';
  out.url = location.href;
  return out;
})()`;

(async () => {
  let tab = await getTarget();
  const ws = await openWs(tab.webSocketDebuggerUrl);
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 6000));
  tab = await getTarget();
  const res = await evalIn(tab, PROBE);
  console.log(JSON.stringify(res, null, 2));
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
