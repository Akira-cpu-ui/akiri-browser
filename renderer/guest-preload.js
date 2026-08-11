// Akiri Browser — guest preload (runs in every tab view, sandboxed, isolated world).
// На наших file:// страницах (стартовая, настройки, пароли) открывает маленький pageAPI.
// На сайтах — только слушает postMessage от нашего скрипта захвата логин-форм.
const { contextBridge, ipcRenderer } = require('electron');

const isOwnPage = typeof location !== 'undefined' && location.protocol === 'file:';

if (isOwnPage) {
  contextBridge.exposeInMainWorld('pageAPI', {
    loadBookmarks: () => ipcRenderer.invoke('load-bookmarks'),
    loadHistory: () => ipcRenderer.invoke('load-history'),
    saveHistory: (list) => ipcRenderer.invoke('save-history', list),
    clearHistory: () => ipcRenderer.invoke('clear-history'),
    loadDownloads: () => ipcRenderer.invoke('load-downloads'),
    clearDownloads: () => ipcRenderer.invoke('clear-downloads'),
    showItemInFolder: (p) => ipcRenderer.invoke('show-item-in-folder', p),
    openFile: (p) => ipcRenderer.invoke('open-file', p),
    loadSettings: () => ipcRenderer.invoke('load-settings'),
    saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
    clearBrowsingData: () => ipcRenderer.invoke('clear-browsing-data'),
    openDownloadsFolder: () => ipcRenderer.invoke('open-downloads-folder'),
    chooseDownloadDir: () => ipcRenderer.invoke('choose-download-dir'),
    openPasswordsPage: () => ipcRenderer.send('open-passwords-page'),
    extensionsList: () => ipcRenderer.invoke('extensions-list'),
    extensionsLoad: (p) => ipcRenderer.invoke('extensions-load', p),
    extensionsRemove: (id) => ipcRenderer.invoke('extensions-remove', id),
    openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
    exportBookmarks: () => ipcRenderer.invoke('export-bookmarks'),
    importBookmarks: () => ipcRenderer.invoke('import-bookmarks'),
    aiChat: (messages) => ipcRenderer.invoke('ai-chat', { messages }),
    passwordsStatus: () => ipcRenderer.invoke('passwords-status'),
    passwordsSetMaster: (oldPw, newPw) => ipcRenderer.invoke('passwords-set-master', { oldPw, newPw }),
    passwordsUnlock: (pw) => ipcRenderer.invoke('passwords-unlock', pw),
    passwordsLock: () => ipcRenderer.invoke('passwords-lock'),
    passwordsList: () => ipcRenderer.invoke('passwords-list'),
    passwordsSave: (entry) => ipcRenderer.invoke('passwords-save', entry),
    passwordsDelete: (id) => ipcRenderer.invoke('passwords-delete', id),
    onPasswordsChanged: (cb) => ipcRenderer.on('passwords-changed', () => cb()),
    onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', () => cb()),
    appInfo: () => ipcRenderer.invoke('app-version'),
    updateInfo: () => ipcRenderer.invoke('update-info'),
    checkUpdates: () => ipcRenderer.invoke('update-check-now'),
    updateDownload: () => ipcRenderer.invoke('update-download'),
    updateInstall: (file) => ipcRenderer.invoke('update-install', file),
    onUpdateInfo: (cb) => ipcRenderer.on('update-info', () => cb()),
    onUpdateProgress: (cb) => ipcRenderer.on('update-download-progress', (_e, p) => cb(p)),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome },
  });
} else {
  // захват логин-форм с сайтов: данные уходят в main, чтобы предложить сохранить пароль
  window.addEventListener('message', (e) => {
    if (e && e.source === window && e.data && e.data.__akiriPasswords) {
      ipcRenderer.send('passwords-captured', e.data.__akiriPasswords);
    }
  });

  // наведение на ссылку → пузырёк «куда ведёт ссылка» внизу страницы (как в Chrome).
  // Рисуем прямо в странице: DOM окна браузера не может перекрыть WebContentsView.
  let akiriStatusEl = null;
  let akiriStatusStyle = null;
  function akiriSetStatus(u) {
    try {
      if (!u) {
        if (akiriStatusEl) {
          akiriStatusEl.remove();
          akiriStatusEl = null;
        }
        return;
      }
      if (!akiriStatusEl) {
        akiriStatusStyle = document.createElement('style');
        akiriStatusStyle.textContent =
          '#akiri-status{position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:60vw;padding:5px 12px;border-radius:999px;background:rgba(30,31,35,.93);color:#e9eaed;font:12px/1.4 system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.35)}';
        document.head.appendChild(akiriStatusStyle);
        akiriStatusEl = document.createElement('div');
        akiriStatusEl.id = 'akiri-status';
        document.body.appendChild(akiriStatusEl);
      }
      akiriStatusEl.textContent = u;
    } catch (_) {
      /* ignore */
    }
  }
  let lastHover = null;
  document.addEventListener('mouseover', (e) => {
    try {
      const el = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      const u = el && el.href ? el.href : null;
      if (u !== lastHover) {
        lastHover = u;
        akiriSetStatus(u);
      }
    } catch (_) {
      /* ignore */
    }
  }, true);
}
