// Akiri Browser — мост для WebView2-версии (настоящий Chromium).
// В Electron этот файл неактивен: preload уже определил window.browserAPI.
// В WebView2 — создаёт window.browserAPI поверх window.chrome.webview.postMessage,
// так что renderer (index.html/app.js) работает без изменений.
(function () {
  'use strict';
  if (window.browserAPI) return; // Electron preload
  var wv = window.chrome && window.chrome.webview;
  if (!wv) return; // не WebView2

  var seq = 0;
  var pending = {};
  var handlers = {};

  function on(name, cb) {
    (handlers[name] = handlers[name] || []).push(cb);
  }
  function emit(name, args) {
    var list = handlers[name];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try {
        list[i].apply(null, args || []);
      } catch (e) {
        /* игнорируем ошибку слушателя */
      }
    }
  }

  wv.addEventListener('message', function (e) {
    var m = e.data;
    if (!m) return;
    if (m.type === 'event') {
      emit(m.name, m.args || []);
    } else if (m.id != null) {
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result);
    }
  });

  function send(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      wv.postMessage({ id: id, method: method, args: args || [] });
    });
  }

  // URL собственных страниц — относительно этой страницы (виртуальный хост akiri.local)
  function page(name) {
    try {
      return new URL(name, location.href).href;
    } catch (e) {
      return name;
    }
  }

  var ua = navigator.userAgent || '';
  var m = ua.match(/Chrome\/([\d.]+)/);
  var chromeVer = m ? m[1] : '151.0.0.0';

  window.browserAPI = {
    ntpUrl: page('ntp.html'),
    settingsUrl: page('settings.html'),
    passwordsUrl: page('passwords.html'),
    aboutUrl: page('about.html'),
    historyUrl: page('history.html'),
    downloadsUrl: page('downloads.html'),

    // вкладки (управляются в хосте через отдельные WebView2)
    createTab: function (url, incognito) { return send('create-tab', [url || null, !!incognito]); },
    closeTab: function (id) { return send('close-tab', [id]); },
    setPinned: function (id, pinned) { return send('set-pinned', [id, !!pinned]); },
    activateTab: function (id) { return send('activate-tab', [id]); },
    navigateTab: function (id, url) { return send('navigate-tab', [id, url]); },
    navTab: function (id, action) { return send('nav-tab', [id, action]); },
    reorderTabs: function (ids) { return send('reorder-tabs', [ids]); },
    tabState: function (id) { return send('tab-state', [id]); },
    findTab: function (id, text, forward, findNext) { return send('find-tab', [id, text, !!forward, !!findNext]); },
    stopFindTab: function (id) { return send('stop-find-tab', [id]); },
    zoomTab: function (id, dir) { return send('zoom-tab', [id, dir]); },
    printTab: function (id) { return send('print-tab', [id]); },
    muteTab: function (id, muted) { return send('mute-tab', [id, !!muted]); },
    screenshotTab: function (id) { return send('screenshot-tab', [id]); },
    readerTab: function (id) { return send('reader-tab', [id]); },
    darkTab: function (id) { return send('dark-tab', [id]); },
    showTabMenu: function (id, x, y, pinned, muted) { return send('show-tab-menu', [id, x, y, !!pinned, !!muted]); },

    // размер области страницы: хост двигает WebView2 вкладки под этот прямоугольник
    setViewRect: function (r) { return send('set-view-rect', [r]); },
    toggleFullscreen: function () { return send('toggle-fullscreen', []); },
    devtoolsTab: function (id) { return send('devtools-tab', [id]); },

    // данные (те же JSON-файлы, что у Electron-версии — совместимы)
    loadBookmarks: function () { return send('load-bookmarks', []); },
    saveBookmarks: function (list) { return send('save-bookmarks', [list]); },
    loadHistory: function () { return send('load-history', []); },
    saveHistory: function (list) { return send('save-history', [list]); },
    loadDownloads: function () { return send('load-downloads', []); },
    loadSession: function () { return send('load-session', []); },
    saveSession: function (urls) { return send('save-session', [urls]); },
    openDownloadsFolder: function () { return send('open-downloads-folder', []); },
    suggest: function (q) { return send('suggest', [q]); },
    clearBrowsingData: function () { return send('clear-browsing-data', []); },

    // настройки + AI (AI — в следующих этапах)
    loadSettings: function () { return send('load-settings', []); },
    saveSettings: function (s) { return send('save-settings', [s]); },
    aiChat: function (messages) { return send('ai-chat', [messages]); },
    getPageText: function (id) { return send('get-page-text', [id]); },

    // менеджер паролей (следующие этапы)
    passwordsStatus: function () { return send('passwords-status', []); },
    passwordsSetMaster: function (oldPw, newPw) { return send('passwords-set-master', [oldPw, newPw]); },
    passwordsUnlock: function (pw) { return send('passwords-unlock', [pw]); },
    passwordsLock: function () { return send('passwords-lock', []); },
    passwordsList: function () { return send('passwords-list', []); },
    passwordsSave: function (entry) { return send('passwords-save', [entry]); },
    passwordsDelete: function (id) { return send('passwords-delete', [id]); },
    passwordsOffer: function () { return send('passwords-offer', []); },
    passwordsOfferClear: function () { return send('passwords-offer-clear', []); },

    // события (от хоста)
    onMenuAction: function (cb) { on('menu-action', cb); },
    onOpenNewTab: function (cb) { on('open-new-tab', cb); },
    onTabEvent: function (cb) { on('tab-event', cb); },
    onSettingsChanged: function (cb) { on('settings-changed', cb); },
    onDataCleared: function (cb) { on('browsing-data-cleared', cb); },
    onPasswordOffer: function (cb) { on('password-offer', cb); },
    onUpdateInfo: function (cb) { on('update-info', cb); },
    appInfo: function () { return send('app-version', []); },
    checkUpdates: function () { return send('update-check-now', []); },
    updateInfo: function () { return send('update-info', []); },

    copyText: function (text) { return send('copy-text', [String(text || '')]); },
    showItemInFolder: function (p) { return send('show-item-in-folder', [String(p || '')]); },

    platform: /^Win/i.test(navigator.platform || '') ? 'win32' : 'unknown',
    versions: {
      electron: 'WebView2',
      chrome: chromeVer,
      node: '-',
    },
  };

  // Хоткеи браузера, когда фокус в UI (адресная строка и т.п.) — напрямую в app.js
  // через те же события menu-action, что шлёт хост (в Electron их ловит меню приложения).
  document.addEventListener('keydown', function (e) {
    var k = e.key;
    var ctrl = e.ctrlKey || e.metaKey;
    var alt = e.altKey;
    var shift = e.shiftKey;
    var action = null;
    var payload = null;
    if (ctrl && !alt) {
      if (k === 't') action = shift ? 'reopen-tab' : 'new-tab';
      else if (k === 'w') action = 'close-tab';
      else if (k === 'Tab') action = shift ? 'prev-tab' : 'next-tab';
      else if (k === 'l' || k === 'L') action = 'focus-address';
      else if (k === 'd' || k === 'D') action = 'bookmark';
      else if (k === 'j' || k === 'J') action = 'open-downloads';
      else if (k === 'h' || k === 'H') action = 'open-history';
      else if (k === 'r' || k === 'R') action = 'reload';
      else if (k === 'f' || k === 'F') action = 'find';
      else if (k === ',') action = 'open-settings';
      else if (k === 'A') action = 'tab-search';
      else if (k === 'Delete') action = 'clear-data';
      else if (k === '=' || k === '+') action = 'zoom-in';
      else if (k === '-') action = 'zoom-out';
      else if (k === '0') action = 'zoom-reset';
      else if (k >= '1' && k <= '8') { action = 'select-tab'; payload = parseInt(k, 10) - 1; }
      else if (k === '9') { action = 'select-tab'; payload = 8; }
    }
    if (alt && !ctrl && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      action = k === 'ArrowLeft' ? 'back' : 'forward';
    }
    if (k === 'F5') action = 'reload';
    if (k === 'F11') action = 'fullscreen';
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    emit('menu-action', [action, payload]);
  }, true);
})();
