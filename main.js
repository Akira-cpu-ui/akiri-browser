// Akiri Browser — main process
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, clipboard, shell, session, net, desktopCapturer, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const APP_NAME = 'Akiri Browser';

// Как Chrome/Vivaldi: обычный User-Agent Chromium без «Electron» и имени приложения.
// Иначе сайты опознают нестандартный браузер и ломают/блокируют (логины, стримы, банки).
// ВАЖНО: стабильный Chrome в UA пишет версию в форме 130.0.0.0 (мажор.0.0.0), а не полную
// сборку — полная версия уходит только в Sec-CH-UA-Full-Version-List. Это проверено по
// настоящему Chrome на этой машине. UA с полной сборкой выглядит как dev-сборка и
// риск-движок Google относится к нему настороженнее.
const CHROME_MAJOR = String(process.versions.chrome || '130').split('.')[0];
const CHROME_FULL = String(process.versions.chrome || '130');
const UA_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
  CHROME_MAJOR +
  '.0.0.0 Safari/537.36';
app.userAgentFallback = UA_CHROME;
// убираем автоматизацию из рендерера: navigator.webdriver всегда false
// (даже когда окно открыто с отладочным портом) — сайты не видят «управляемый браузер»
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
// TLS-возможности как у настоящего Chrome: Encrypted Client Hello и пост-квантовая
// обмен ключа X25519Kyber768. В Electron они по умолчанию выключены, а Chrome шлёт
// их в ClientHello — риск-движок Google отличает по ним встроенные браузеры.
try {
  app.commandLine.appendSwitch('enable-ech');
  app.commandLine.appendSwitch('enable-features', 'EncryptedClientHello,TLS13Kyber');
} catch (_) {
  /* ignore */
}

// Тёмная тема принудительно — иначе системный заголовок окна остаётся белым
// (Windows в светлой теме), пока браузер тёмный. Выглядит как баг.
nativeTheme.themeSource = 'dark';

const ICON_PATH = path.join(__dirname, 'build', 'icon.png');
const GOOGLE_SEARCH = 'https://www.google.com/search?q=';

// ---------- настройки (home, поиск, тема, AI) ----------
const DEFAULT_AI_BASE = 'https://opencode.ai/zen/v1';
const DEFAULT_AI_MODEL = 'mimo-v2.5-free'; // стабильно отвечает по-русски (deepseek-free глючит)
const FREE_MODELS = [
  'deepseek-v4-flash-free',
  'mimo-v2.5-free',
  'ling-3.0-flash-free',
  'ling-3.0-tiny-free',
  'nemotron-3-ultra-free',
  'north-mini-code-free',
  'laguna-s-2.1-free',
  'longcat-2.0-free',
];
const DEFAULT_SETTINGS = {
  homeUrl: 'https://www.google.com/',
  searchEngine: 'google', // google | yandex | duckduckgo
  accent: '#5b8cff',
  startPage: 'ntp', // ntp | home — что открывать при запуске
  newTabPage: 'ntp', // ntp | home — что открывает Ctrl+T
  wallpaper: 'network', // network | cosmos | aurora | gradient | dark
  suggestions: true, // подсказки поиска в омнибоксе
  saveHistory: true,
  restoreSession: true,
  autoUpdate: true, // авто-скачивание и установка обновлений при закрытии (как в Chrome)
  aiEnabled: true, // главный выключатель AI (для людей без ключа)
  autofillPasswords: true, // автозаполнение логинов сохранёнными паролями
  popupWindows: true, // window.open с параметрами окна → настоящее окно (иначе — вкладка)
  downloadDir: '', // своя папка загрузок (пусто = «Загрузки»)
  zoom: 1, // масштаб по умолчанию
  sidePanel: true, // боковая панель с иконками
  updateUrl: 'https://akira-cpu-ui.github.io/akiri-browser/version.json', // фид версий на GitHub Pages
  chromeDeviceId: '', // стабильный device_id для x-chrome-id-consistency-request (как у Chrome)
  ai: { baseUrl: DEFAULT_AI_BASE, model: DEFAULT_AI_MODEL, apiKey: '' },
};

// ---------- обновления ----------
// Фид версий — простой JSON по URL (можно положить на любой хостинг/GitHub):
//   { "version": "0.12.0", "url": "https://…/Akiri Browser Setup 0.12.0.exe", "notes": "что нового" }
// Если version в фиде новее установленной — браузер показывает уведомление.
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}
function updateInfoFile() {
  return dataFile('update-check.json');
}
function readUpdateInfo() {
  return readJson('update-check.json', null);
}
function writeUpdateInfo(info) {
  writeJson('update-check.json', info);
}
// автообновление (как в Chrome): фоновая загрузка установщика + установка при закрытии
const autoUpdateState = { downloading: false, downloadedPath: null, downloadedVersion: null, installing: false };

function updateInfoWithDownload() {
  const info = readUpdateInfo() || {};
  return {
    ...info,
    downloaded: !!(autoUpdateState.downloadedPath && fs.existsSync(autoUpdateState.downloadedPath)),
    downloadedVersion: autoUpdateState.downloadedVersion || null,
  };
}
function broadcastUpdate() {
  const info = updateInfoWithDownload();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update-info', info);
  }
  for (const t of tabs.values()) {
    if (!t.wc.isDestroyed()) t.wc.send('update-info', info);
  }
}

// скачивание установщика с прогрессом (общая для кнопки и фонового автообновления)
async function downloadInstaller() {
  const info = readUpdateInfo();
  let url = info && info.url;
  if (!url) return { error: 'no-url' };
  // url установщика в version.json может быть относительным — резолвим от адреса фида
  try {
    url = new URL(url, info.feedUrl || undefined).href;
  } catch (_) {
    /* оставляем как есть */
  }
  const latest = String(info.latest || 'new').replace(/[^\w.-]/g, '_');
  const target = path.join(app.getPath('temp'), `akiri-update-${latest}.exe`);
  const broadcast = (p) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('update-download-progress', p);
    }
    for (const t of tabs.values()) {
      if (!t.wc.isDestroyed()) t.wc.send('update-download-progress', p);
    }
  };
  try {
    broadcast({ phase: 'download', received: 0, total: 0 });
    const res = await net.fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
    if (!res.ok) {
      broadcast({ phase: 'error', error: 'HTTP ' + res.status });
      return { error: 'HTTP ' + res.status };
    }
    let buf = null;
    try {
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        broadcast({ phase: 'download', received, total });
      }
      buf = Buffer.concat(chunks);
    } catch (_) {
      buf = Buffer.from(await res.arrayBuffer());
    }
    fs.writeFileSync(target, buf);
    broadcast({ phase: 'done', path: target, size: buf.length });
    return { ok: true, path: target, size: buf.length };
  } catch (err) {
    broadcast({ phase: 'error', error: String((err && err.message) || err) });
    return { error: String((err && err.message) || err) };
  }
}

// запуск установщика с bat-обёрткой (ждёт полного выхода приложения) + закрытие
function launchInstallerAndQuit(exe) {
  try {
    // Установщик NSIS запускает новую версию сам (runAfterFinish), но только если
    // старая копия полностью закрыта — иначе гонка. Поэтому запускаем bat-обёртку:
    // она ждёт полного выхода приложения и только потом запускает установщик.
    const appName = path.basename(process.execPath);
    const bat = path.join(app.getPath('temp'), 'akiri-update-run.bat');
    const script =
      '@echo off\r\n' +
      'REM ждём закрытия старой копии браузера\r\n' +
      ':wait\r\n' +
      `tasklist /FI "IMAGENAME eq ${appName}" 2>nul | find /I "${appName}" >nul\r\n` +
      'if %errorlevel%==0 ( timeout /t 1 /nobreak >nul & goto wait )\r\n' +
      `"${exe}" /S\r\n`;
    fs.writeFileSync(bat, script);
    const child = spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    child.on('error', () => {
      /* bat не запустился — просто закрываемся */
    });
    // закрываем приложение; если обычное завершение зависло — форсируем выход
    setTimeout(() => app.quit(), 1000);
    setTimeout(() => {
      try {
        app.exit(0);
      } catch (_) {
        /* ignore */
      }
    }, 6000);
    return { ok: true };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

// фоновое автообновление: если вышла новая версия — скачиваем установщик сами,
// а установим при закрытии браузера (before-quit). Как в Chrome.
async function maybeAutoDownload(info) {
  try {
    if (!info || !info.available || settingsCache.autoUpdate === false) return;
    const latest = String(info.latest || '');
    if (autoUpdateState.downloading) return;
    if (autoUpdateState.downloadedVersion === latest && autoUpdateState.downloadedPath && fs.existsSync(autoUpdateState.downloadedPath)) return;
    autoUpdateState.downloading = true;
    const r = await downloadInstaller();
    autoUpdateState.downloading = false;
    if (r && r.ok) {
      autoUpdateState.downloadedPath = r.path;
      autoUpdateState.downloadedVersion = latest;
      broadcastUpdate();
    }
  } catch (_) {
    autoUpdateState.downloading = false;
  }
}
async function checkForUpdates() {
  const url = String(settingsCache.updateUrl || '').trim();
  if (!url) {
    writeUpdateInfo({ checkedAt: Date.now(), enabled: false });
    return readUpdateInfo();
  }
  const info = {
    checkedAt: Date.now(),
    enabled: true,
    current: app.getVersion(),
    feedUrl: url, // база для относительного url установщика
  };
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const latest = String((data && data.version) || '');
    info.latest = latest;
    info.url = data && data.url;
    info.notes = data && data.notes;
    info.available = !!(latest && compareVersions(latest, app.getVersion()) > 0);
  } catch (err) {
    info.error = String((err && err.message) || err);
    info.available = false;
  }
  writeUpdateInfo(info);
  return info;
}
let settingsCache = { ...DEFAULT_SETTINGS };

function loadSettingsCache() {
  const s = readJson('settings.json', {}) || {};
  settingsCache = { ...DEFAULT_SETTINGS, ...s, ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai || {}) } };
}
function getDownloadsDir() {
  const d = String(settingsCache.downloadDir || '').trim();
  if (d && fs.existsSync(d)) return d;
  return app.getPath('downloads');
}

let mainWindow = null;

// история загрузок (скорость, прогресс, статус) — хранится в файле, как в настоящих браузерах
let downloadHistory = readJson('downloads.json', []);
let downloadsSaveTimer = null;
function scheduleDownloadsSave() {
  clearTimeout(downloadsSaveTimer);
  downloadsSaveTimer = setTimeout(() => writeJson('downloads.json', downloadHistory), 600);
}

// ---------- tabs (WebContentsView, managed here — webview tag is broken on this system) ----------
const tabs = new Map(); // id -> { id, view, wc, win, url, title, loading }
let nextTabId = 1;
const winRects = new WeakMap(); // окно -> { x, y, w, h } область страницы (сообщает рендерер)

function sendTabEvent(win, id, type, payload = {}) {
  if (win && !win.isDestroyed()) win.webContents.send('tab-event', { id, type, ...payload });
}

function layoutViews(win) {
  if (!win || win.isDestroyed()) return;
  const [cw, ch] = win.getContentSize();
  const r = winRects.get(win) || { x: 0, y: 88, w: cw, h: Math.max(0, ch - 88) };
  const x = Math.max(0, Math.min(r.x || 0, cw - 40));
  const y = Math.max(0, Math.min(r.y, ch - 40));
  const w = Math.max(40, Math.min(r.w || cw, cw - x));
  const h = Math.max(0, Math.min(r.h, ch - y));
  for (const t of tabs.values()) {
    if (t.win === win) {
      try {
        t.view.setBounds({ x, y, width: w, height: h });
      } catch (_) {
        /* view destroyed */
      }
    }
  }
  pushWindowMetrics(win);
}

// ---------- картинка-в-картинке для любых видео (как в Яндекс.Браузере) ----------
// Кнопка над видео при наведении: работает на любом сайте, где видео в теге <video>
// (аниме-сайты, плееры и т.п.), даже если сайт прячет нативную кнопку PiP.
const PIP_BTN_JS = `(function () {
  try {
    if (window.__akiriPip) return;
    window.__akiriPip = true;
    var st = document.createElement('style');
    st.textContent = '#akiri-pip-btn{position:fixed;top:8px;right:8px;z-index:2147483647;width:38px;height:38px;border-radius:10px;border:none;background:rgba(22,24,28,.88);color:#fff;cursor:pointer;display:none;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(0,0,0,.45);padding:0}#akiri-pip-btn:hover{background:rgba(45,48,54,.95)}#akiri-pip-btn svg{width:20px;height:20px;display:block}';
    document.head.appendChild(st);
    var btn = document.createElement('button');
    btn.id = 'akiri-pip-btn';
    btn.title = 'Картинка в картинке';
    btn.setAttribute('aria-label', 'Картинка в картинке');
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 7h-8v6h8V7zm2-4H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H3V5h18v14z"/></svg>';
    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      try {
        var v = (cur && cur.offsetWidth > 0) ? cur : document.querySelector('video');
        if (!v) return;
        if (document.pictureInPictureElement === v) document.exitPictureInPicture().catch(function () {});
        else if (v.requestPictureInPicture) v.requestPictureInPicture().catch(function () {});
      } catch (err) {}
    });
    document.documentElement.appendChild(btn);
    var cur = null;
    function place(v) {
      if (!v) { btn.style.display = 'none'; return; }
      var r = v.getBoundingClientRect();
      btn.style.display = 'flex';
      btn.style.left = Math.max(8, r.right - 46) + 'px';
      btn.style.top = Math.max(8, r.top + 10) + 'px';
    }
    document.addEventListener('mouseover', function (e) {
      try {
        var v = e.target && e.target.closest ? e.target.closest('video') : null;
        if (v === cur) return;
        cur = v;
        if (v && v.offsetWidth > 60 && v.offsetHeight > 40) place(v);
        else btn.style.display = 'none';
      } catch (err) {}
    }, true);
    document.addEventListener('scroll', function () { if (cur) place(cur); }, true);
    window.addEventListener('resize', function () { if (cur) place(cur); });
  } catch (err) {}
})();`;

const PIP_TOGGLE_JS = `(function () {
  try {
    var v = document.querySelector('video');
    if (!v) return 'no-video';
    if (document.pictureInPictureElement === v) { document.exitPictureInPicture(); return 'off'; }
    if (v.requestPictureInPicture) { v.requestPictureInPicture(); return 'on'; }
    return 'unsupported';
  } catch (e) { return 'err'; }
})();`;

function injectPip(wc) {
  wc.executeJavaScript(PIP_BTN_JS, true).catch(() => {});
}

async function togglePip(contents) {
  try {
    await contents.executeJavaScript(PIP_TOGGLE_JS, true);
  } catch (_) {
    /* ignore */
  }
}

// ---------- ярлык на рабочем столе ----------
// Установщик кладёт ярлык на Public Desktop, а реальный рабочий стол пользователя
// может быть другим (OneDrive). Поэтому браузер сам проверяет при запуске,
// есть ли ярлык на РЕАЛЬНОМ рабочем столе, и создаёт его, если нет.
function ensureDesktopShortcut() {
  try {
    if (!app.isPackaged) return;
    const exe = process.execPath;
    const lnk = path.join(app.getPath('desktop'), 'Akiri Browser.lnk');
    if (fs.existsSync(lnk)) return;
    shell.writeShortcutLink(lnk, {
      target: exe,
      icon: exe,
      description: 'Akiri Browser',
      appUserModelId: 'com.akiri.browser',
    });
  } catch (_) {
    /* ignore */
  }
}

// стабильный device_id «как у Chrome»: генерируется один раз и хранится в настройках.
// Google коррелирует по нему устройство между запросами, поэтому он должен быть постоянным.
let chromeDeviceIdCache = null;
function getChromeDeviceId() {
  if (chromeDeviceIdCache) return chromeDeviceIdCache;
  let id = settingsCache.chromeDeviceId;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    id = crypto.randomUUID();
    settingsCache.chromeDeviceId = id;
    try {
      const s = readJson('settings.json', {}) || {};
      s.chromeDeviceId = id;
      writeJson('settings.json', s);
    } catch (_) {
      /* ignore */
    }
  }
  chromeDeviceIdCache = id;
  return id;
}

// Маскируемся под настоящий Chrome на сетевом уровне.
// Проблема: UA-строка уже Chrome-подобная (app.userAgentFallback), но Chromium
// в Electron НЕ шлёт заголовки клиентских хинтов Sec-CH-UA вовсе, а настоящий
// Chrome шлёт их всегда. Риск-движок Google видит «Chrome без хинтов» — это
// один из признаков встроенного браузера/приложения, и вход в аккаунт
// отклоняется («Этот браузер или приложение может быть небезопасным»).
// Решение: подмешиваем хинты настоящего Chrome в исходящие запросы.
function maskClientHints(sess) {
  const cv = String(process.versions.chrome || '130');
  const cvMajor = cv.split('.')[0]; // в низкоэнтропийных хинтах Chrome пишет мажорную версию (130), а не полную сборку
  const lowEntropy = {
    'Sec-CH-UA': '"Not/A)Brand";v="8", "Chromium";v="' + cvMajor + '", "Google Chrome";v="' + cvMajor + '"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
  };
  const fullVer = cv.includes('.') ? cv : cv + '.0.0'; // 130.0.6723.191
  const full = {
    // формат как у настоящего Chrome: грейз-бренд с .0.0.0, реальные бренды — полная версия
    'Sec-CH-UA-Full-Version-List':
      '"Not/A)Brand";v="8.0.0.0", "Chromium";v="' + fullVer + '", "Google Chrome";v="' + fullVer + '"',
    'Sec-CH-UA-Full-Version': '"' + fullVer + '"', // легаси-хинт, настоящий Chrome тоже шлёт
    'Sec-CH-UA-Form-Factors': '"Desktop"',
    'Sec-CH-UA-Arch': '"x86"',
    'Sec-CH-UA-Bitness': '"64"',
    'Sec-CH-UA-Model': '""',
    'Sec-CH-UA-Platform-Version': '"10.0.0"', // Windows 10 — реальная версия этой машины
    'Sec-CH-UA-WoW64': '?0',
    // «бренд-заголовки» настоящего Chrome — их НЕ шлёт ни один встроенный браузер,
    // и риск-движок Google проверяет их наличие. Значения сняты с реального Chrome
    // на этой машине (x-browser-validation одинаков на всех профилях).
    'X-Browser-Channel': 'stable',
    'X-Browser-Copyright': 'Copyright 2026 Google LLC. All Rights Reserved.',
    'X-Browser-Validation': 'BgjQLVAEO0JXYjadQoBzN8EU63w=',
    'X-Browser-Year': '2026',
    'X-Client-Data': 'COLaygE=',
    'X-Chrome-ID-Consistency-Request':
      'version=1,client_id=77185425430.apps.googleusercontent.com,device_id=' +
      getChromeDeviceId() +
      ',signin_mode=all_accounts',
  };
  sess.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      if (process.env.AKIRI_HDR_DUMP && /accounts\.google\.com|google\.com\//.test(details.url)) {
        console.log('[hdr] ' + details.method + ' ' + details.url.slice(0, 100));
        for (const [k, v] of Object.entries(details.requestHeaders)) console.log('  ' + k + ': ' + String(v).slice(0, 200));
      }
      const h = details.requestHeaders;
      // хинты шлются только по HTTPS (как у настоящего Chrome)
      if (details.url.startsWith('https://')) {
        Object.assign(h, lowEntropy);
        // как у настоящего Chrome: полный список языков с q-весами (у Electron тут просто «ru»)
        if (!h['Accept-Language'] || h['Accept-Language'].length < 10) {
          h['Accept-Language'] = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';
        }
        const host = (details.url.match(/^https:\/\/([^\/]+)/) || [])[1] || '';
        // полный набор хинтов — только для Google/YouTube, где они реально
        // ожидаются (Google подтверждает Accept-CH); X-Client-Data не трогаем —
        // невалидное значение хуже, чем его отсутствие
        if (/google\.|youtube\./i.test(host)) Object.assign(h, full);
      }
    } catch (_) {
      /* не мешаем запросу */
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}

// Маскируемся под настоящий Chrome: navigator.userAgentData выдаёт бренды
// «Google Chrome» вместо «Chromium»/«Electron», window.chrome заполнен как в Chrome,
// window.innerWidth/outerWidth/screenX — реальные размеры окна (в WebContentsView
// Blink отдаёт 0 — это мгновенно выдаёт «не настоящий браузер»).
// Иначе риск-движок Google блокирует вход в аккаунт («This browser or app may not be secure»).
function spoofUserAgentData(win, id, wc) {
  const cv = String(process.versions.chrome || '130');
  const cvMajor = cv.split('.')[0]; // в navigator.userAgentData бренды пишут мажорную версию (130)
  const fullVer = cv.includes('.') ? cv : cv + '.0.0'; // 130.0.6723.191
  const brands = [
    { brand: 'Not/A)Brand', version: '8' },
    { brand: 'Chromium', version: cvMajor },
    { brand: 'Google Chrome', version: cvMajor },
  ];
  const fullBrands = [
    { brand: 'Not/A)Brand', version: '8.0.0.0' },
    { brand: 'Chromium', version: fullVer },
    { brand: 'Google Chrome', version: fullVer },
  ];
  // реальные размеры окна и области страницы (как их видит настоящий Chrome)
  let m = { iw: 0, ih: 0, ow: 0, oh: 0, sx: 0, sy: 0 };
  try {
    const t = tabs.get(id);
    if (t && t.view) {
      const b = t.view.getBounds();
      const wp = win.getPosition();
      m.iw = Math.round(b.width);
      m.ih = Math.round(b.height);
      m.sx = Math.round(wp[0] + b.x);
      m.sy = Math.round(wp[1] + b.y);
    }
    const wb = win.getBounds();
    m.ow = Math.round(wb.width);
    m.oh = Math.round(wb.height);
  } catch (_) {
    /* ignore */
  }
  if (process.env.AKIRI_FP_DEBUG) console.log('[fp] spoof bounds', id, JSON.stringify(m));
  const js =
    '(() => {' +
    '  try {' +
    '    if (window.__akiriUadPatched) return;' +
    '    window.__akiriUadPatched = true;' +
    '    window.__akiriMetrics = ' + JSON.stringify(m) + ';' +
    '    const brands = ' + JSON.stringify(brands) + ';' +
    '    const fullBrands = ' + JSON.stringify(fullBrands) + ';' +
    "    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + cvMajor + ".0.0.0 Safari/537.36';" +
    '    const fake = {' +
    '      brands, mobile: false, platform: "Windows",' +
    '      getHighEntropyValues() {' +
    '        return Promise.resolve({' +
    '          architecture: "x86", bitness: "64", brands: fullBrands,' +
    '          fullVersionList: fullBrands, mobile: false, model: "",' +
    '          platform: "Windows", platformVersion: "10.0.0",' +
    "          ua, uaFullVersion: '" + fullVer + "', wow64: false," +
    '        });' +
    '      },' +
    '      toJSON() { return { brands, mobile: false, platform: "Windows" }; },' +
    '    };' +
    "    Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: function () { return fake; } });" +
    "    Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: function () { return fake; } });" +
    "    Object.defineProperty(navigator, 'webdriver', { configurable: true, get: function () { return false; } });" +
    // window.chrome — в Electron он пустой {}, а в Chrome: loadTimes, csi, app, runtime, webstore
    '    if (!window.chrome || Object.keys(window.chrome).length === 0) {' +
    '      Object.defineProperty(window, "chrome", { configurable: true, value: {' +
    '        app: { isInstalled: false, InstallState: { DISABLED: 0, INSTALLED: 1, NOT_INSTALLED: 2 }, RunningState: { CANNOT_RUN: 0, READY_TO_RUN: 1, RUNNING: 2 } },' +
    '        csi: function () { var t = performance.now(); return { startE: 0, onloadT: t, pageT: t, tran: 0 }; },' +
    '        loadTimes: function () { var n = performance.now(); return { commitLoadTime: 0, connectionInfo: "h2", finishDocumentLoadTime: n, finishLoadTime: n, firstPaintAfterLoadTime: n, firstPaintTime: n, firstByteTime: 0, navigationType: "Other", protocol: "h2", proxyInfo: "", requestTime: 0, startLoadTime: 0, wasAlternateProtocolAvailable: true, wasFetchedViaSpdy: true, wasHttpResponseMerged: false, wasNpnNegotiated: true, wasPrefetched: false, wasRevalidated: false }; },' +
    '        runtime: { id: undefined },' +
    '        webstore: { onInstallStageChanged: {}, onDownloadProgress: {} },' +
    '      } });' +
    '    }' +
    // реальные размеры окна вместо 0 (WebContentsView)
    '    Object.defineProperty(window, "innerWidth",  { configurable: true, get: function () { return window.__akiriMetrics.iw; } });' +
    '    Object.defineProperty(window, "innerHeight", { configurable: true, get: function () { return window.__akiriMetrics.ih; } });' +
    '    Object.defineProperty(window, "outerWidth",  { configurable: true, get: function () { return window.__akiriMetrics.ow; } });' +
    '    Object.defineProperty(window, "outerHeight", { configurable: true, get: function () { return window.__akiriMetrics.oh; } });' +
    '    Object.defineProperty(window, "screenX",     { configurable: true, get: function () { return window.__akiriMetrics.sx; } });' +
    '    Object.defineProperty(window, "screenY",     { configurable: true, get: function () { return window.__akiriMetrics.sy; } });' +
    '    Object.defineProperty(window, "screenLeft",  { configurable: true, get: function () { return window.__akiriMetrics.sx; } });' +
    '    Object.defineProperty(window, "screenTop",   { configurable: true, get: function () { return window.__akiriMetrics.sy; } });' +
    '  } catch (e) {}' +
    '})();';
  wc.executeJavaScript(js, true).catch(() => {});
}

// после перестановки вкладок/изменения окна обновляем window.__akiriMetrics,
// чтобы innerWidth/outerWidth/screenX всегда совпадали с реальным окном
function pushWindowMetrics(win) {
  if (!win || win.isDestroyed()) return;
  let m = null;
  try {
    const wb = win.getBounds();
    const wp = win.getPosition();
    const t0 = [...tabs.values()].find((t) => t.win === win);
    if (t0 && t0.view) {
      const b = t0.view.getBounds();
      m = {
        iw: Math.round(b.width),
        ih: Math.round(b.height),
        ow: Math.round(wb.width),
        oh: Math.round(wb.height),
        sx: Math.round(wp[0] + b.x),
        sy: Math.round(wp[1] + b.y),
      };
    } else if (process.env.AKIRI_FP_DEBUG) {
      console.log('[fp] push: no tab for win', win && win.id);
    }
  } catch (err) {
    if (process.env.AKIRI_FP_DEBUG) console.log('[fp] push EXC:', String(err && err.message));
    return;
  }
  if (!m) return;
  if (process.env.AKIRI_FP_DEBUG) console.log('[fp] push', win.id, JSON.stringify(m));
  const payload = JSON.stringify(m);
  for (const t of tabs.values()) {
    if (t.win === win && t.wc && !t.wc.isDestroyed()) {
      try {
        t.wc
          .executeJavaScript('if (window.__akiriMetrics) { window.__akiriMetrics = ' + payload + '; }', true)
          .catch(() => {});
      } catch (_) {
        /* ignore */
      }
    }
  }
}

// слушаем загрузки на уровне сессии — срабатывает для всех вкладок окна.
// ВАЖНО: вкладки живут в partition-сессиях (persist:main / incognito),
// поэтому слушаем именно их, а не default-сессию окна.
function attachSessionDownloads(partition) {
  const sess = session.fromPartition(partition);
  sess.on('will-download', (_e, item) => {
    const dir = getDownloadsDir();
    const name = String(item.getFilename() || 'download').replace(/[\\/:*?"<>|]/g, '_');
    const fullPath = path.join(dir, name);
    item.setSavePath(fullPath);

    const send = (d) => {
      for (const [id, t] of tabs) sendTabEvent(t.win, id, 'download', d);
    };
    const prog = { lastBytes: 0, lastTime: Date.now(), smooth: 0 };
    const snapshot = (state) => {
      const received = item.getReceivedBytes();
      const total = item.getTotalBytes();
      const now = Date.now();
      let speed = 0;
      if (state === 'progressing') {
        const dt = (now - prog.lastTime) / 1000;
        const inst = dt > 0 ? Math.max(0, (received - prog.lastBytes) / dt) : 0;
        prog.lastBytes = received;
        prog.lastTime = now;
        prog.smooth = prog.smooth ? prog.smooth * 0.7 + inst * 0.3 : inst;
        speed = prog.smooth;
      } else {
        // завершено/прервано: держим последнюю замеренную скорость
        speed = prog.smooth || 0;
      }
      if (process.env.AKIRI_DL_DEBUG) console.log('[dl]', state, received + '/' + total, 'speed=' + Math.round(speed), 'dt=', (now - prog.lastTime));
      const d = {
        dlId: item.id,
        url: item.getURL(),
        filename: name,
        state,
        received,
        total,
        speed,
        path: fullPath,
        time: item.getStartTime ? item.getStartTime() * 1000 : Date.now(),
      };
      const i = downloadHistory.findIndex((x) => x.dlId === d.dlId);
      if (i >= 0) downloadHistory[i] = d;
      else downloadHistory.unshift(d);
      if (downloadHistory.length > 100) downloadHistory.length = 100;
      scheduleDownloadsSave();
      send(d);
    };

    snapshot('progressing');
    item.on('updated', (_e, state) => snapshot(state));
    item.once('done', (_e, state) => snapshot(state));
  });
}

function attachGuestEvents(win, id, wc) {
  wc.on('dom-ready', () => {
    spoofUserAgentData(win, id, wc);
    injectPip(wc);
  });
  wc.setWindowOpenHandler(({ url, disposition }) => {
    const isHttp = /^(https?:|about:)/i.test(url);
    const t = tabs.get(id);
    const partition = t ? t.partition : 'persist:main';
    // попапы (OAuth-логины, видеоплееры, «поделиться») — настоящее окно, как в Chrome/Vivaldi.
    // Без этого w = window.open(...) возвращает null и логин на многих сайтах ломается.
    // Настройка «Всплывающие окна»: выключена → всё открывается вкладкой (жёсткий блокер).
    if (settingsCache.popupWindows && isHttp && (disposition === 'new-window' || disposition === 'new-popup')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 920,
          height: 720,
          autoHideMenuBar: true,
          backgroundColor: '#1b1c1f',
          icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
          webPreferences: {
            preload: path.join(__dirname, 'renderer', 'guest-preload.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            partition,
          },
        },
      };
    }
    // обычные ссылки/вкладки — как раньше: открываем в новой вкладке браузера
    if (isHttp) {
      if (win && !win.isDestroyed()) win.webContents.send('open-new-tab', url);
    } else if (/^(mailto:|tel:)/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  wc.on('context-menu', (_evt, params) => {
    buildContextMenu(wc, params).popup({ window: win });
  });

  wc.on('did-navigate', (_e, url) => {
    const t = tabs.get(id);
    if (t) t.url = url;
    scheduleSessionSave();
    sendTabEvent(win, id, 'navigate', { url });
  });

  wc.on('did-navigate-in-page', (_e, url) => {
    const t = tabs.get(id);
    if (t) t.url = url;
    scheduleSessionSave();
    sendTabEvent(win, id, 'navigate', { url, inPage: true });
  });

  wc.on('page-title-updated', (_e, title) => {
    const t = tabs.get(id);
    if (t) t.title = title;
    sendTabEvent(win, id, 'title', { title });
  });

  wc.on('page-favicon-updated', (_e, favicons) => {
    sendTabEvent(win, id, 'favicon', { favicons });
  });

  wc.on('did-start-loading', () => {
    const t = tabs.get(id);
    if (t) t.loading = true;
    sendTabEvent(win, id, 'loading', { loading: true });
  });

  wc.on('did-stop-loading', () => {
    const t = tabs.get(id);
    if (t) t.loading = false;
    sendTabEvent(win, id, 'loading', { loading: false });
  });

  // менеджер паролей: ловим логин-формы и автозаполняем сохранённые
  wc.on('did-finish-load', () => {
    const u = wc.getURL();
    if (!/^https?:/i.test(u)) return;
    injectPasswordHook(wc);
    if (settingsCache.autofillPasswords !== false && passwordsKey && passwordsCache.length) {
      const host = safeHost(u);
      const matches = passwordsCache.filter((e) => safeHost(e.url) === host && e.password);
      if (matches.length === 1) fillPassword(wc, matches[0]);
    }
  });

  wc.on('did-fail-load', (_e, code, desc) => {
    if (code === -3) return; // ERR_ABORTED
    sendTabEvent(win, id, 'fail', { code, desc });
  });

  wc.on('render-process-gone', () => {
    sendTabEvent(win, id, 'crashed');
  });

  wc.on('found-in-page', (_e, result) => {
    sendTabEvent(win, id, 'found', { result });
  });

  wc.on('audio-state-changed', (_e, audible) => {
    sendTabEvent(win, id, 'audio', { audible });
  });

  wc.on('enter-html-full-screen', () => {
    if (win && !win.isDestroyed()) win.setFullScreen(true);
  });
  wc.on('leave-html-full-screen', () => {
    if (win && !win.isDestroyed()) win.setFullScreen(false);
  });

  wc.on('destroyed', () => {
    tabs.delete(id);
  });
}

function tabState(id) {
  const t = tabs.get(id);
  if (!t) return null;
  const nav = t.wc.navigationHistory;
  return {
    url: t.url,
    title: t.title,
    loading: t.loading,
    canGoBack: nav.canGoBack(),
    canGoForward: nav.canGoForward(),
  };
}

// ---------- менеджер паролей (локальное шифрование AES-256-GCM, мастер-пароль) ----------
let passwordsKey = null;    // ключ AES в памяти после разблокировки (на диск не пишется)
let passwordsCache = [];    // расшифрованные записи
let pendingPassword = null; // предложение «сохранить пароль» от логин-формы

function passwordsFilePath() {
  return dataFile('passwords.json');
}
function passwordsExists() {
  return fs.existsSync(passwordsFilePath());
}
function deriveKey(master, salt) {
  return crypto.pbkdf2Sync(String(master), Buffer.from(salt, 'base64'), 120000, 32, 'sha256');
}
function encryptObj(obj, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: enc.toString('base64') };
}
function decryptObj(blob, key) {
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(Buffer.from(blob.data, 'base64')), d.final()]).toString('utf8'));
}
function loadPasswordsBlob() {
  try {
    return JSON.parse(fs.readFileSync(passwordsFilePath(), 'utf8'));
  } catch (_) {
    return null;
  }
}
function savePasswordsBlob(blob) {
  fs.writeFileSync(passwordsFilePath(), JSON.stringify(blob));
}
function persistPasswords() {
  if (!passwordsKey) return;
  const blob = loadPasswordsBlob();
  if (!blob) return;
  blob.data = encryptObj(passwordsCache, passwordsKey);
  savePasswordsBlob(blob);
}
function tryUnlock(master) {
  try {
    const blob = loadPasswordsBlob();
    if (!blob) return false;
    const key = deriveKey(master, blob.salt);
    const list = decryptObj(blob.data, key);
    passwordsKey = key;
    passwordsCache = Array.isArray(list) ? list : [];
    return true;
  } catch (_) {
    return false;
  }
}
function lockPasswords() {
  passwordsKey = null;
  passwordsCache = [];
}
function notifyPasswordsChanged() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('passwords-changed');
  }
  for (const t of tabs.values()) {
    if (!t.wc.isDestroyed()) t.wc.send('passwords-changed');
  }
}
function safeHost(u) {
  try {
    return new URL(String(u)).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

// скрипт в странице: ловит отправку логин-форм и шлёт данные в наш preload (postMessage)
const PASSWORD_HOOK_JS = `(function () {
  try {
    if (window.__akiriPassHook) return;
    window.__akiriPassHook = true;
    document.addEventListener('submit', function (e) {
      try {
        var f = e.target && e.target.tagName === 'FORM' ? e.target : (e.target ? e.target.closest('form') : null);
        if (!f) return;
        var p = f.querySelector('input[type="password"]');
        if (!p) return;
        var u = f.querySelector('input[type="text"], input[type="email"], input[type="tel"], input[name*="user" i], input[name*="login" i], input[name*="email" i]');
        window.postMessage({ __akiriPasswords: { url: location.href, username: u ? u.value : '', password: p.value } }, '*');
      } catch (err) {}
    }, true);
  } catch (err) {}
})();`;

// скрипт автозаполнения логина/пароля
function fillScript(entry) {
  const data = JSON.stringify({ username: entry.username || '', password: entry.password || '' });
  return `(function () {
    try {
      var data = ${data};
      var p = document.querySelector('input[type="password"]');
      if (!p) return 'no-password-field';
      var u = document.querySelector('input[type="text"], input[type="email"], input[type="tel"]');
      if (u && data.username) { u.value = data.username; u.dispatchEvent(new Event('input', { bubbles: true })); }
      p.value = data.password;
      p.dispatchEvent(new Event('input', { bubbles: true }));
      return 'filled';
    } catch (e) { return 'err'; }
  })();`;
}

function injectPasswordHook(wc) {
  wc.executeJavaScript(PASSWORD_HOOK_JS, true).catch(() => {});
}

function fillPassword(wc, entry) {
  wc.executeJavaScript(fillScript(entry), true).catch(() => {});
}

// ---------- permissions: allow what a normal browser asks about ----------
const ALLOWED_PERMS = new Set([
  'media',
  'clipboard-sanitized-write',
  'clipboard-read',
  'notifications',
  'geolocation',
  'display-capture',
  'keyboard-lock',
]);

function applyPermissionHandlers() {
  const sessions = [
    session.defaultSession,
    session.fromPartition('persist:main'),
    session.fromPartition('incognito'),
  ];
  for (const s of sessions) {
    s.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMS.has(permission)));
    s.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMS.has(permission));
    // шаринг экрана (видеозвонки, Meet/Zoom/Discord) — отдаём первый экран
    s.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen', 'window'] })
        .then((sources) => {
          const screen = sources.find((src) => src.id.startsWith('screen:'));
          callback({ video: screen || sources[0] || null, audio: 'loopback' });
        })
        .catch(() => callback({}));
    });
  }
}

// ---------- page tools (screenshot, reader, dark mode) ----------
async function takeScreenshot(contents) {
  try {
    const img = await contents.capturePage();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const p = path.join(app.getPath('downloads'), `Akiri ${stamp}.png`);
    fs.writeFileSync(p, img.toPNG());
    shell.showItemInFolder(p);
  } catch (_) {
    /* ignore */
  }
}

const READER_JS = `(function () {
  try {
    if (window.__akiriReader && document.getElementById('akiri-reader')) {
      var old = document.getElementById('akiri-reader');
      old.remove();
      var st = document.getElementById('akiri-reader-style');
      if (st) st.remove();
      document.body.innerHTML = window.__akiriReader;
      window.__akiriReader = null;
      return 'off';
    }
    var pick = document.querySelector('article') ||
      (function () {
        var cands = Array.from(document.querySelectorAll('main, [role="main"], .content, #content, .article, .post'));
        var best = null, score = -1;
        cands.forEach(function (el) {
          var n = el.querySelectorAll('p, h1, h2, h3').length;
          if (n > score) { score = n; best = el; }
        });
        return best;
      })();
    if (!pick) return 'none';
    var clone = pick.cloneNode(true);
    clone.querySelectorAll('script, style, nav, aside, iframe, form, button, .ad, [class*="ad-"], [class*="share"], [class*="comment"], [class*="social"]').forEach(function (n) { n.remove(); });
    var text = (clone.innerText || '').trim();
    if (text.length < 300) return 'none';
    var src = document.createElement('style');
    src.id = 'akiri-reader-style';
    src.textContent = '#akiri-reader{position:fixed!important;inset:0;z-index:2147483647;background:#f4f1ea;color:#1f2328;overflow:auto;padding:44px 20px 60px;font:17px/1.75 Georgia,serif}#akiri-reader .akiri-inner{max-width:720px;margin:0 auto}#akiri-reader h1{font-size:30px;line-height:1.25;margin-bottom:14px}#akiri-reader h2,#akiri-reader h3{margin-top:22px}#akiri-reader p{margin:14px 0}#akiri-reader img{max-width:100%;height:auto}#akiri-reader a{color:#1a5fb4}#akiri-reader .akiri-exit{position:fixed;top:14px;right:14px;z-index:2;background:#1f2328;color:#fff;border:none;border-radius:999px;padding:9px 16px;font:13px system-ui;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3)}';
    document.head.appendChild(src);
    window.__akiriReader = document.body.innerHTML;
    var wrap = document.createElement('div');
    wrap.id = 'akiri-reader';
    var exit = document.createElement('button');
    exit.className = 'akiri-exit';
    exit.textContent = '✕ Выйти из режима чтения';
    exit.onclick = function () {
      wrap.remove();
      var st2 = document.getElementById('akiri-reader-style');
      if (st2) st2.remove();
      document.body.innerHTML = window.__akiriReader;
      window.__akiriReader = null;
    };
    var inner = document.createElement('div');
    inner.className = 'akiri-inner';
    inner.appendChild(clone);
    wrap.appendChild(exit);
    wrap.appendChild(inner);
    document.body.appendChild(wrap);
    return 'on';
  } catch (e) { return 'none'; }
})();`;

const DARK_JS = `(function () {
  try {
    if (document.getElementById('akiri-dark')) {
      document.getElementById('akiri-dark').remove();
      return 'off';
    }
    var s = document.createElement('style');
    s.id = 'akiri-dark';
    s.textContent = 'html{filter:invert(0.92) hue-rotate(180deg)!important;background:#0d0e12}html img,html video,html canvas,html iframe,html embed,html [style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}';
    document.head.appendChild(s);
    return 'on';
  } catch (e) { return 'none'; }
})();`;

// ---------- context menu (web pages) ----------
function buildContextMenu(contents, params) {
  const win = BrowserWindow.fromWebContents(contents) || mainWindow;
  const send = (action, payload) => win && win.webContents.send('menu-action', action, payload);
  const template = [];

  if (params.linkURL) {
    template.push({
      label: 'Открыть ссылку в новой вкладке',
      click: () => send('new-tab-url', params.linkURL),
    });
    template.push({
      label: 'Открыть ссылку в новом окне',
      click: () => openInNewWindow(params.linkURL),
    });
    template.push({
      label: 'Копировать адрес ссылки',
      click: () => clipboard.writeText(params.linkURL),
    });
    template.push({ type: 'separator' });
  }
  if (params.mediaType === 'image' && params.srcURL) {
    template.push({
      label: 'Копировать адрес изображения',
      click: () => clipboard.writeText(params.srcURL),
    });
    template.push({
      label: 'Сохранить изображение…',
      click: () => contents.downloadURL(params.srcURL),
    });
    template.push({ type: 'separator' });
  }
  if (params.mediaType === 'video') {
    template.push({
      label: 'Картинка в картинке',
      click: () => togglePip(contents),
    });
    template.push({ type: 'separator' });
  }
  if (params.isEditable) {
    template.push(
      { role: 'undo', label: 'Отменить' },
      { type: 'separator' },
      { role: 'cut', label: 'Вырезать' },
      { role: 'copy', label: 'Копировать' },
      { role: 'paste', label: 'Вставить' },
      { type: 'separator' }
    );
  } else if (params.selectionText) {
    template.push({ role: 'copy', label: 'Копировать' }, { type: 'separator' });
  }
  if (params.selectionText) {
    const q = params.selectionText.replace(/\s+/g, ' ').trim();
    template.push({
      label: `Поиск: «${q.length > 24 ? q.slice(0, 24) + '…' : q}» в Google`,
      click: () => send('new-tab-url', GOOGLE_SEARCH + encodeURIComponent(q)),
    });
    template.push({
      label: 'Пояснить выделенное (AI)',
      click: () => send('ai-explain', { text: q }),
    });
    template.push({
      label: 'Перевести выделенное (AI)',
      click: () => send('ai-translate-sel', { text: q }),
    });
    template.push({
      label: 'Перефразировать (AI)',
      click: () => send('ai-rephrase-sel', { text: q }),
    });
  }
  template.push({ role: 'selectAll', label: 'Выделить всё' });
  template.push({ type: 'separator' });
  template.push({ label: 'Перезагрузить', click: () => contents.reload() });
  template.push({ label: 'Перезагрузить без кеша', click: () => contents.reloadIgnoringCache() });
  template.push({
    label: 'Назад',
    enabled: contents.navigationHistory.canGoBack(),
    click: () => contents.navigationHistory.goBack(),
  });
  template.push({
    label: 'Вперёд',
    enabled: contents.navigationHistory.canGoForward(),
    click: () => contents.navigationHistory.goForward(),
  });
  template.push({ type: 'separator' });
  template.push({ label: 'Инструменты разработчика', click: () => contents.toggleDevTools() });
  template.push({ label: 'Кратко о странице (AI)', click: () => send('ai-page-summary') });
  template.push({ label: 'Скриншот страницы', click: () => takeScreenshot(contents) });
  template.push({
    label: 'Перевести страницу (Google)',
    click: () =>
      send('new-tab-url', 'https://translate.google.com/?sl=auto&tl=ru&u=' + encodeURIComponent(contents.getURL())),
  });
  template.push({ label: 'Режим чтения', click: () => toggleReader(contents) });
  template.push({ label: 'Ночной режим (тёмная страница)', click: () => toggleDark(contents) });
  const t0 = tabs.find((t) => t.wc === contents);
  template.push({
    label: 'Копировать заголовок и адрес',
    click: () => clipboard.writeText(((t0 && t0.title) || contents.getTitle()) + '\n' + contents.getURL()),
  });
  // автозаполнение сохранённым паролем
  if (passwordsKey && passwordsCache.length) {
    const host = safeHost(contents.getURL());
    const pwMatch = passwordsCache.filter((e) => safeHost(e.url) === host && e.password);
    if (pwMatch.length) {
      template.push({ type: 'separator' });
      template.push({
        label: pwMatch.length === 1
          ? `Заполнить пароль${pwMatch[0].username ? ' (' + pwMatch[0].username + ')' : ''}`
          : 'Заполнить сохранённым паролем',
        click: () => fillPassword(contents, pwMatch[0]),
      });
    }
  }
  return Menu.buildFromTemplate(template);
}

async function toggleReader(contents) {
  try {
    await contents.executeJavaScript(READER_JS, true);
  } catch (_) {
    /* ignore */
  }
}

async function toggleDark(contents) {
  try {
    await contents.executeJavaScript(DARK_JS, true);
  } catch (_) {
    /* ignore */
  }
}

// ---------- app menu (Russian labels + shortcuts) ----------
function buildMenu() {
  const send = (action, payload) => () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (win) win.webContents.send('menu-action', action, payload);
  };
  const template = [
    {
      label: 'Файл',
      submenu: [
        { label: 'Новая вкладка', accelerator: 'CmdOrCtrl+T', click: send('new-tab') },
        { label: 'Закрыть вкладку', accelerator: 'CmdOrCtrl+W', click: send('close-tab') },
        { label: 'Вернуть закрытую вкладку', accelerator: 'CmdOrCtrl+Shift+T', click: send('reopen-tab') },
        { type: 'separator' },
        { label: 'Новое окно', accelerator: 'CmdOrCtrl+N', click: () => createWindow({ fresh: true }) },
        { label: 'Новое окно в режиме инкогнито', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow({ incognito: true, fresh: true }) },
        { type: 'separator' },
        { label: 'Печать…', accelerator: 'CmdOrCtrl+P', click: send('print') },
        { label: 'Очистить данные браузера…', accelerator: 'CmdOrCtrl+Shift+Delete', click: send('clear-data') },
        { type: 'separator' },
        { label: 'Настройки…', accelerator: 'CmdOrCtrl+,', click: send('open-settings') },
        { type: 'separator' },
        ...(process.platform === 'win32'
          ? [{ role: 'quit', label: 'Выход' }]
          : [{ role: 'close', label: 'Закрыть окно' }]),
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить всё' },
        { type: 'separator' },
        { label: 'Найти на странице…', accelerator: 'CmdOrCtrl+F', click: send('find') },
        { label: 'Найти далее', accelerator: 'F3', click: send('find-next') },
        { label: 'Найти ранее', accelerator: 'Shift+F3', click: send('find-prev') },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Перезагрузить', accelerator: 'CmdOrCtrl+R', click: send('reload') },
        { label: 'Перезагрузить без кеша', accelerator: 'CmdOrCtrl+Shift+R', click: send('reload-no-cache') },
        { label: 'Перезагрузить (F5)', accelerator: 'F5', click: send('reload') },
        { label: 'Назад', accelerator: 'Alt+Left', click: send('back') },
        { label: 'Вперёд', accelerator: 'Alt+Right', click: send('forward') },
        { label: 'Домой', accelerator: 'Alt+Home', click: send('home') },
        { type: 'separator' },
        { label: 'Режим чтения', click: send('reader') },
        { label: 'Ночной режим (тёмная страница)', click: send('dark') },
        { label: 'Скриншот страницы', click: send('screenshot') },
        { type: 'separator' },
        { label: 'Увеличить', accelerator: 'CmdOrCtrl+Plus', click: send('zoom-in') },
        { label: 'Уменьшить', accelerator: 'CmdOrCtrl+-', click: send('zoom-out') },
        { label: 'Обычный масштаб', accelerator: 'CmdOrCtrl+0', click: send('zoom-reset') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полный экран', accelerator: 'F11' },
        { type: 'separator' },
        { label: 'Инструменты разработчика', accelerator: 'CmdOrCtrl+Shift+I', click: send('devtools') },
      ],
    },
    {
      label: 'Вкладки',
      submenu: [
        { label: 'Следующая вкладка', accelerator: 'Ctrl+Tab', click: send('next-tab') },
        { label: 'Предыдущая вкладка', accelerator: 'Ctrl+Shift+Tab', click: send('prev-tab') },
        { label: 'Поиск вкладок', accelerator: 'CmdOrCtrl+Shift+A', click: send('tab-search') },
        { type: 'separator' },
        { label: 'Вкладка 1', accelerator: 'CmdOrCtrl+1', click: send('select-tab', 0) },
        { label: 'Вкладка 2', accelerator: 'CmdOrCtrl+2', click: send('select-tab', 1) },
        { label: 'Вкладка 3', accelerator: 'CmdOrCtrl+3', click: send('select-tab', 2) },
        { label: 'Вкладка 4', accelerator: 'CmdOrCtrl+4', click: send('select-tab', 3) },
        { label: 'Вкладка 5', accelerator: 'CmdOrCtrl+5', click: send('select-tab', 4) },
        { label: 'Вкладка 6', accelerator: 'CmdOrCtrl+6', click: send('select-tab', 5) },
        { label: 'Вкладка 7', accelerator: 'CmdOrCtrl+7', click: send('select-tab', 6) },
        { label: 'Вкладка 8', accelerator: 'CmdOrCtrl+8', click: send('select-tab', 7) },
        { label: 'Последняя вкладка', accelerator: 'CmdOrCtrl+9', click: send('select-tab', 8) },
        { type: 'separator' },
        { label: 'Адресная строка', accelerator: 'CmdOrCtrl+L', click: send('focus-address') },
        { label: 'В закладки', accelerator: 'CmdOrCtrl+D', click: send('bookmark') },
        { label: 'История', accelerator: 'CmdOrCtrl+H', click: send('open-history') },
        { label: 'Загрузки', accelerator: 'CmdOrCtrl+J', click: send('open-downloads') },
        { label: 'Закладки', accelerator: 'CmdOrCtrl+Shift+O', click: send('show-menu') },
        { type: 'separator' },
        { label: 'AI-ассистент', click: send('ai-open') },
      ],
    },
    {
      label: 'Помощь',
      submenu: [
        { label: 'О браузере', click: send('open-about') },
        { label: 'Проверить обновления', click: send('check-updates') },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// ---------- window ----------
function createWindow(opts = {}) {
  const incognito = !!opts.incognito;
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 520,
    minHeight: 380,
    title: incognito ? 'Инкогнито — ' + APP_NAME : APP_NAME,
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    backgroundColor: '#1b1c1f',
    autoHideMenuBar: true, // как в Chrome: меню появляется по Alt
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload использует path
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: incognito
      ? { mode: 'incognito', fresh: '1' }
      : opts.fresh
        ? { fresh: '1' }
        : {},
  });


  const onResize = () => layoutViews(win);
  win.on('resize', onResize);
  win.on('move', onResize);
  win.on('maximize', onResize);
  win.on('unmaximize', onResize);
  win.on('enter-full-screen', onResize);
  win.on('leave-full-screen', onResize);

  win.on('close', () => persistSessionNow());

  win.on('closed', () => {
    for (const [id, t] of tabs) {
      if (t.win === win) {
        try {
          win.contentView.removeChildView(t.view);
          t.wc.close();
        } catch (_) {
          /* ignore */
        }
        tabs.delete(id);
      }
    }
    if (mainWindow === win) mainWindow = null;
  });

  mainWindow = win;
  return win;
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('load-bookmarks', () => readJson('bookmarks.json', []));
  ipcMain.handle('save-bookmarks', (_e, list) => writeJson('bookmarks.json', list));
  ipcMain.handle('load-history', () => readJson('history.json', []));
  ipcMain.handle('save-history', (_e, list) => writeJson('history.json', list));
  ipcMain.handle('clear-history', () => {
    writeJson('history.json', []);
    return true;
  });
  ipcMain.handle('show-item-in-folder', (_e, p) => (p ? shell.showItemInFolder(String(p)) : true));
  ipcMain.handle('open-file', (_e, p) => (p ? shell.openPath(String(p)) : ''));
  ipcMain.handle('load-session', () => readJson('session.json', null));
  ipcMain.handle('save-session', (_e, urls) => writeJson('session.json', urls));
  ipcMain.handle('open-downloads-folder', () => shell.openPath(getDownloadsDir()));
  ipcMain.handle('load-downloads', () => downloadHistory.slice(0, 100));
  ipcMain.handle('clear-downloads', () => {
    downloadHistory = [];
    writeJson('downloads.json', []);
    return true;
  });
  ipcMain.handle('open-data-folder', () => shell.openPath(app.getPath('userData')));

  // экспорт/импорт закладок (файл JSON)
  ipcMain.handle('export-bookmarks', async () => {
    const { dialog } = require('electron');
    const r = await dialog.showSaveDialog({ title: 'Экспорт закладок', defaultPath: path.join(app.getPath('downloads'), 'akiri-bookmarks.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    const bm = readJson('bookmarks.json', []);
    fs.writeFileSync(r.filePath, JSON.stringify({ app: 'Akiri Browser', version: 1, bookmarks: bm }, null, 2));
    return { ok: true };
  });

  ipcMain.handle('import-bookmarks', async () => {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog({ title: 'Импорт закладок', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false };
    try {
      const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      const list = Array.isArray(data) ? data : (data.bookmarks || []);
      const cur = readJson('bookmarks.json', []);
      const merged = cur.concat(list).filter((b, i, a) => a.findIndex((x) => x.url === b.url) === i);
      writeJson('bookmarks.json', merged);
      return { ok: true, count: list.length };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('load-settings', () => {
    loadSettingsCache();
    return { ...settingsCache, freeModels: FREE_MODELS };
  });
  ipcMain.handle('save-settings', (_e, s) => {
    // сливаем с ТЕКУЩИМИ настройками, а не с дефолтами — частичные сохранения
    // (например, тумблер AI) не должны затирать ключ API или другие поля
    const urlChanged = !!(s && typeof s.updateUrl === 'string' && s.updateUrl !== settingsCache.updateUrl);
    const merged = { ...settingsCache, ...(s || {}), ai: { ...settingsCache.ai, ...((s && s.ai) || {}) } };
    writeJson('settings.json', merged);
    loadSettingsCache();
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('settings-changed');
    }
    for (const t of tabs.values()) {
      if (!t.wc.isDestroyed()) t.wc.send('settings-changed');
    }
    // сменили адрес фида обновлений — проверяем сразу
    if (urlChanged) {
      checkForUpdates().then((info) => {
        if (info && info.available) broadcastUpdate();
      });
    }
    return true;
  });

  // ---------- обновления ----------
  ipcMain.handle('update-info', () => updateInfoWithDownload());
  ipcMain.handle('update-check-now', async () => {
    const info = await checkForUpdates();
    broadcastUpdate();
    maybeAutoDownload(info);
    return info;
  });

  // скачивание установщика новой версии (с прогрессом) — для кнопки «Обновить».
  // Если обновление уже скачано в фоне (автообновление) — отдаём готовый файл.
  ipcMain.handle('update-download', async () => {
    if (autoUpdateState.downloadedPath && fs.existsSync(autoUpdateState.downloadedPath)) {
      return { ok: true, path: autoUpdateState.downloadedPath, size: fs.statSync(autoUpdateState.downloadedPath).size };
    }
    return downloadInstaller();
  });

  // установка: запускаем NSIS-установщик тихо (/S) и закрываем приложение.
  // Установщик обновит файлы и сам запустит новую версию (runAfterFinish).
  ipcMain.handle('update-install', (_e, file) => {
    const exe = String(file || '');
    if (!exe || !fs.existsSync(exe)) return { error: 'missing' };
    autoUpdateState.installing = true; // не даём before-quit запустить второй раз
    return launchInstallerAndQuit(exe);
  });
  ipcMain.handle('app-version', () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome }));

  // выбор папки загрузок через системный диалог
  ipcMain.handle('choose-download-dir', async () => {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Папка для загрузок' });
    if (!r.canceled && r.filePaths && r.filePaths[0]) {
      settingsCache.downloadDir = r.filePaths[0];
      return { ok: true, path: r.filePaths[0] };
    }
    return { ok: false };
  });

  // ---------- расширения (распакованные; CRX из Chrome Web Store в Electron не ставится) ----------
  ipcMain.handle('extensions-list', () => {
    try {
      const exts = session.fromPartition('persist:main').getAllExtensions();
      return { ok: true, list: exts.map((e) => ({ id: e.id, name: e.name, version: e.version, path: e.path })) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('extensions-load', async (_e, p) => {
    try {
      const s = session.fromPartition('persist:main');
      const ext = await s.loadExtension(String(p || ''));
      return { ok: true, id: ext.id, name: ext.name, version: ext.version };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('extensions-remove', (_e, id) => {
    try {
      session.fromPartition('persist:main').removeExtension(String(id || ''));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // подсказки поиска (Google Suggest), проксируем через main, чтобы не трогать CSP интерфейса
  ipcMain.handle('suggest', async (_e, q) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const url =
        'https://suggestqueries.google.com/complete/search?client=chrome&hl=ru&q=' +
        encodeURIComponent(String(q || '').trim());
      const res = await net.fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      clearTimeout(timer);
      const json = await res.json();
      return Array.isArray(json) && json[1] ? json[1].slice(0, 8) : [];
    } catch (_err) {
      return [];
    }
  });

  // очистка данных браузера (Ctrl+Shift+Delete) — куки, кеш, история; закладки остаются
  ipcMain.handle('clear-browsing-data', async () => {
    const s = session.fromPartition('persist:main');
    await s.clearStorageData();
    await s.clearCache();
    writeJson('history.json', []);
    writeJson('session.json', []);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('browsing-data-cleared');
    }
    return true;
  });

  // ---------- менеджер паролей ----------
  ipcMain.handle('passwords-status', () => ({ hasMaster: passwordsExists(), unlocked: !!passwordsKey }));

  ipcMain.handle('passwords-set-master', (_e, { oldPw, newPw }) => {
    const pw = String(newPw || '');
    if (pw.length < 4) return { error: 'short' };
    if (passwordsExists() && !tryUnlock(String(oldPw || ''))) return { error: 'wrong-old' };
    const salt = crypto.randomBytes(16).toString('base64');
    const key = deriveKey(pw, salt);
    savePasswordsBlob({ v: 1, salt, data: encryptObj(passwordsCache, key) });
    passwordsKey = key;
    return { ok: true };
  });

  ipcMain.handle('passwords-unlock', (_e, pw) => {
    const ok = tryUnlock(String(pw || ''));
    if (ok) notifyPasswordsChanged();
    return { ok };
  });
  ipcMain.handle('passwords-lock', () => {
    lockPasswords();
    notifyPasswordsChanged();
    return true;
  });

  ipcMain.handle('passwords-list', () => {
    if (!passwordsKey) return { error: 'locked' };
    return { ok: true, list: passwordsCache.map((e, i) => ({ ...e, id: i })) };
  });

  ipcMain.handle('passwords-save', (_e, entry) => {
    if (!passwordsKey) return { error: 'locked' };
    const url = String(entry.url || '').trim();
    const username = String(entry.username || '').trim();
    const password = String(entry.password || '');
    if (!url || !password) return { error: 'bad' };
    const existing = passwordsCache.find((e) => e.url === url && e.username === username);
    if (existing) Object.assign(existing, { url, username, password, updated: Date.now() });
    else passwordsCache.push({ url, username, password, created: Date.now(), updated: Date.now() });
    persistPasswords();
    return { ok: true };
  });

  ipcMain.handle('passwords-delete', (_e, id) => {
    if (!passwordsKey) return { error: 'locked' };
    if (Number.isInteger(id) && passwordsCache[id]) passwordsCache.splice(id, 1);
    persistPasswords();
    return { ok: true };
  });

  // форма на сайте отправила логин — предлагаем сохранить (не в инкогнито)
  ipcMain.on('passwords-captured', (e, data) => {
    const t = [...tabs.values()].find((x) => x.wc === e.sender);
    if (!t || t.partition === 'incognito') return;
    if (!data || !data.url || !data.password) return;
    pendingPassword = {
      url: String(data.url).slice(0, 500),
      username: String(data.username || ''),
      password: String(data.password),
    };
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('password-offer', { url: pendingPassword.url, username: pendingPassword.username });
    }
  });

  ipcMain.handle('passwords-offer', () => (pendingPassword ? { ok: true, ...pendingPassword } : { ok: false }));
  ipcMain.handle('passwords-offer-clear', () => {
    pendingPassword = null;
    return true;
  });

  // ---------- AI (OpenCode Zen, OpenAI-совместимый API) ----------
  ipcMain.handle('ai-chat', async (_e, { messages }) => {
    const s = readJson('settings.json', null) || {};
    const ai = s.ai || {};
    const key = String(ai.apiKey || '').trim();
    if (!key) return { error: 'no-key' };
    const base = String(ai.baseUrl || DEFAULT_AI_BASE).replace(/\/+$/, '');
    const configured = String(ai.model || DEFAULT_AI_MODEL).trim();
    // бесплатные модели иногда глючат/зависают/отвечают пусто — пробуем по очереди,
    // но недолго: 20 секунд на модель, максимум 3 попытки
    const candidates = [configured, ...FREE_MODELS.filter((m) => m !== configured)].slice(0, 3);
    let lastErr = '';
    for (const model of candidates) {
      try {
        const res = await net.fetch(base + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify({
            model,
            messages: Array.isArray(messages) ? messages.slice(-12) : [],
            stream: false,
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) {
          let detail = '';
          try {
            detail = String(await res.text()).slice(0, 160);
          } catch (_) {
            /* ignore */
          }
          lastErr = 'HTTP ' + res.status + (detail ? ' — ' + detail : '');
          continue;
        }
        const j = await res.json();
        const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (text && String(text).trim()) return { text: String(text) };
        lastErr = 'empty response';
      } catch (err) {
        lastErr = String((err && err.message) || err);
      }
    }
    if (/^HTTP 503/.test(lastErr)) {
      return { error: 'Сервис OpenCode Zen временно недоступен (503). Попробуйте ещё раз через пару минут.' };
    }
    return { error: (lastErr || 'unknown') + ' — бесплатные модели иногда перегружены, попробуйте ещё раз' };
  });

  ipcMain.handle('get-page-text', async (_e, id) => {
    const t = tabs.get(id);
    if (!t) return '';
    try {
      const r = await t.wc.executeJavaScript(
        `(function(){try{var b=document.body;if(!b)return '';return (b.innerText||'').slice(0,14000);}catch(e){return '';}})()`,
        true
      );
      return String(r || '');
    } catch (_) {
      return '';
    }
  });

  // ---------- tabs ----------
  ipcMain.handle('tab-create', (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return null;
    const incognito = !!payload.incognito;
    const id = nextTabId++;
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'renderer', 'guest-preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        partition: incognito ? 'incognito' : 'persist:main',
      },
    });
    const wc = view.webContents;
    tabs.set(id, { id, view, wc, win, url: payload.url || '', title: '', loading: false, pinned: false, partition: incognito ? 'incognito' : 'persist:main' });
    scheduleSessionSave();
    win.contentView.addChildView(view);
    view.setVisible(false);
    attachGuestEvents(win, id, wc);
    layoutViews(win);
    const z = Number(settingsCache.zoom || 1);
    if (z > 0.1 && z <= 3 && z !== 1) wc.setZoomFactor(z);
    if (payload.url) wc.loadURL(payload.url);
    return id;
  });

  ipcMain.handle('tab-close', (e, id) => {
    const t = tabs.get(id);
    if (!t) return;
    const win = t.win;
    try {
      win.contentView.removeChildView(t.view);
      t.wc.close();
    } catch (_) {
      /* ignore */
    }
    tabs.delete(id);
    scheduleSessionSave();
    layoutViews(win);
  });

  ipcMain.handle('tab-set-pinned', (_e, { id, pinned }) => {
    const t = tabs.get(id);
    if (!t) return;
    t.pinned = !!pinned;
    scheduleSessionSave();
  });

  ipcMain.handle('tab-activate', (e, id) => {
    const t = tabs.get(id);
    if (!t || t.win.isDestroyed()) return;
    for (const [tid, other] of tabs) {
      if (other.win === t.win) {
        try {
          other.view.setVisible(tid === id);
        } catch (_) {
          /* ignore */
        }
      }
    }
    // повторное добавление поднимает вкладку наверх
    try {
      t.win.contentView.addChildView(t.view);
    } catch (_) {
      /* ignore */
    }
    try {
      t.wc.focus(); // фокус на страницу, как в Chrome
    } catch (_) {
      /* ignore */
    }
  });

  ipcMain.handle('tab-navigate', (_e, { id, url }) => {
    const t = tabs.get(id);
    if (t) t.wc.loadURL(String(url));
  });

  ipcMain.handle('tab-nav', (_e, { id, action }) => {
    const t = tabs.get(id);
    if (!t) return;
    const wc = t.wc;
    switch (action) {
      case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
      case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
      case 'reload': wc.reload(); break;
      case 'reload-no-cache': wc.reloadIgnoringCache(); break;
      case 'stop': wc.stop(); break;
    }
  });

  ipcMain.handle('tab-state', (_e, id) => tabState(id));

  ipcMain.handle('tab-find', (_e, { id, text, forward, findNext }) => {
    const t = tabs.get(id);
    if (!t) return;
    if (text) t.wc.findInPage(text, { forward, findNext });
    else t.wc.stopFindInPage('clearSelection');
  });

  ipcMain.handle('tab-find-stop', (_e, id) => {
    const t = tabs.get(id);
    if (t) t.wc.stopFindInPage('clearSelection');
  });

  ipcMain.handle('tab-zoom', async (_e, { id, dir }) => {
    const t = tabs.get(id);
    if (!t) return;
    const f = dir === 0 ? 1 : Math.min(3, Math.max(0.25, (await t.wc.getZoomFactor()) + dir * 0.25));
    t.wc.setZoomFactor(f);
  });

  ipcMain.handle('tab-print', (_e, id) => {
    const t = tabs.get(id);
    if (t) t.wc.print({});
  });

  ipcMain.handle('tab-mute', (_e, { id, muted }) => {
    const t = tabs.get(id);
    if (t) {
      t.wc.setAudioMuted(!!muted);
      return !!muted;
    }
    return false;
  });

  ipcMain.handle('tab-screenshot', async (_e, id) => {
    const t = tabs.get(id);
    if (!t) return;
    await takeScreenshot(t.wc);
  });

  ipcMain.handle('tab-reader', async (_e, id) => {
    const t = tabs.get(id);
    if (!t) return 'none';
    await toggleReader(t.wc);
    return 'done';
  });

  ipcMain.handle('tab-dark', async (_e, id) => {
    const t = tabs.get(id);
    if (!t) return 'none';
    await toggleDark(t.wc);
    return 'done';
  });

  ipcMain.on('set-view-rect', (e, r) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && r && Number.isFinite(r.y) && Number.isFinite(r.h)) {
      winRects.set(win, {
        x: Math.max(0, Math.round(r.x || 0)),
        y: Math.max(0, Math.round(r.y)),
        w: Math.max(40, Math.round(r.w || 0)),
        h: Math.max(0, Math.round(r.h)),
      });
      layoutViews(win);
    }
  });

  // контекстное меню вкладки — нативное (рендерер не может рисовать поверх страницы)
  ipcMain.handle('tab-menu', (e, { id, x, y, pinned, muted }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const t = tabs.get(id);
    if (!t) return;
    const send = (action) => () => {
      if (!win.isDestroyed()) win.webContents.send('menu-action', 'tab-menu-action', { id, action });
    };
    const menu = Menu.buildFromTemplate([
      { label: 'Новая вкладка', click: () => { if (!win.isDestroyed()) win.webContents.send('menu-action', 'new-tab'); } },
      { label: 'Дублировать вкладку', click: send('duplicate') },
      { label: pinned ? 'Открепить вкладку' : 'Закрепить вкладку', click: send('pin') },
      { label: 'Перезагрузить вкладку', click: send('reload') },
      { label: 'Копировать адрес', click: send('copy') },
      { type: 'separator' },
      { label: muted ? 'Включить звук' : 'Отключить звук', click: send('mute') },
      { type: 'separator' },
      { label: 'Закрыть вкладку', click: send('close') },
      { label: 'Закрыть другие вкладки', click: send('close-others') },
      { label: 'Закрыть вкладки справа', click: send('close-right') },
    ]);
    menu.popup({ window: win, x: Math.max(0, Math.round(x || 0)), y: Math.max(0, Math.round(y || 0)) });
  });

  // страница настроек (гость) просит открыть менеджер паролей в интерфейсе
  ipcMain.on('open-passwords-page', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && !win.isDestroyed()) win.webContents.send('menu-action', 'open-passwords');
  });  ipcMain.on('copy-text', (_e, text) => clipboard.writeText(String(text || '')));
  ipcMain.on('show-item-in-folder', (_e, p) => shell.showItemInFolder(String(p || '')));

  ipcMain.on('tab-devtools', (_e, id) => {
    const t = tabs.get(id);
    if (t && t.wc && !t.wc.isDestroyed()) t.wc.toggleDevTools();
  });

  ipcMain.on('toggle-fullscreen', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
  });
}

// ---------- storage helpers ----------
function dataFile(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(name, fallback) {
  try {
    const p = dataFile(name);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  try {
    fs.writeFileSync(dataFile(name), JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('writeJson failed:', err);
  }
}

// ---------- session (восстановление вкладок) ----------
// Сессию сохраняет main-процесс, а не рендерер: async-вызов из beforeunload
// не успевает долететь до main при закрытии окна, и вкладки терялись.
// main знает URL каждой вкладки (did-navigate) и сохраняет сессию с задержкой
// после любого изменения + принудительно при закрытии окна/приложения.
// ВАЖНО: нельзя собирать сессию в момент закрытия окна — webContents вкладок уже
// уничтожены к этому моменту, и список был бы пустым (сессия затиралась).
// Поэтому всегда держим свежий снапшот в памяти и пишем его на диск с задержкой.
let sessionTimer = null;
let sessionSnapshot = [];
function collectSession() {
  const urls = [];
  for (const t of tabs.values()) {
    if (t.partition === 'incognito') continue;
    const u = t.url;
    if (u && !/^(ntp:|file:)/.test(u)) urls.push(t.pinned ? { url: u, pinned: true } : u);
  }
  return urls;
}
function persistSessionNow() {
  if (settingsCache.restoreSession === false) return;
  writeJson('session.json', sessionSnapshot);
}
function scheduleSessionSave() {
  sessionSnapshot = collectSession();
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => writeJson('session.json', sessionSnapshot), 600);
}

// ссылка в новом окне (контекстное меню страницы)
function openInNewWindow(url) {
  const win = createWindow({ fresh: true });
  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) win.webContents.send('open-new-tab', String(url || ''));
  });
}

// ---------- app lifecycle ----------
app.whenReady().then(() => {
  loadSettingsCache();
  registerIpc();
  applyPermissionHandlers();
  Menu.setApplicationMenu(buildMenu());
  ensureDesktopShortcut(); // ярлык на реальном рабочем столе (учитывает OneDrive)
  attachSessionDownloads('persist:main');
  attachSessionDownloads('incognito');
  maskClientHints(session.fromPartition('persist:main'));
  maskClientHints(session.fromPartition('incognito'));
  createWindow();

  // проверка обновлений: при старте (через 8с) и потом каждые 6 часов.
  // Если вышла новая версия — сразу запускаем фоновое скачивание (автообновление).
  const autoCheck = () => {
    checkForUpdates().then((info) => {
      if (info && info.available) {
        broadcastUpdate();
        maybeAutoDownload(info);
      }
    });
  };
  setTimeout(autoCheck, 8000);
  setInterval(autoCheck, 6 * 60 * 60 * 1000);

  // установка автообновления при закрытии браузера
  app.on('before-quit', (e) => {
    if (
      autoUpdateState.downloadedPath &&
      fs.existsSync(autoUpdateState.downloadedPath) &&
      !autoUpdateState.installing
    ) {
      e.preventDefault();
      autoUpdateState.installing = true;
      launchInstallerAndQuit(autoUpdateState.downloadedPath);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // финальное сохранение сессии при выходе из приложения
  app.on('before-quit', () => persistSessionNow());
