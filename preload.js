// Akiri Browser — preload (contextIsolation bridge)
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

// стартовая страница и страницы настроек/паролей — обычные файлы (file:// работает в WebContentsView).
// Кодируем пробелы и спецсимволы пути (установка может быть в «Program Files» и т.п.)
const enc = (p) => 'file:///' + encodeURI(p.replace(/\\/g, '/'));
const ntpUrl = enc(path.join(__dirname, 'renderer', 'ntp.html'));
const settingsUrl = enc(path.join(__dirname, 'renderer', 'settings.html'));
const passwordsUrl = enc(path.join(__dirname, 'renderer', 'passwords.html'));
const aboutUrl = enc(path.join(__dirname, 'renderer', 'about.html'));
const historyUrl = enc(path.join(__dirname, 'renderer', 'history.html'));
const downloadsUrl = enc(path.join(__dirname, 'renderer', 'downloads.html'));

contextBridge.exposeInMainWorld('browserAPI', {
  ntpUrl,
  settingsUrl,
  passwordsUrl,
  aboutUrl,
  historyUrl,
  downloadsUrl,

  // вкладки (управляются в main через WebContentsView)
  createTab: (url, incognito) => ipcRenderer.invoke('tab-create', { url: url || null, incognito: !!incognito }),
  closeTab: (id) => ipcRenderer.invoke('tab-close', id),
  setPinned: (id, pinned) => ipcRenderer.invoke('tab-set-pinned', { id, pinned }),
  activateTab: (id) => ipcRenderer.invoke('tab-activate', id),
  navigateTab: (id, url) => ipcRenderer.invoke('tab-navigate', { id, url }),
  navTab: (id, action) => ipcRenderer.invoke('tab-nav', { id, action }),
  tabState: (id) => ipcRenderer.invoke('tab-state', id),
  findTab: (id, text, forward, findNext) => ipcRenderer.invoke('tab-find', { id, text, forward, findNext }),
  stopFindTab: (id) => ipcRenderer.invoke('tab-find-stop', id),
  zoomTab: (id, dir) => ipcRenderer.invoke('tab-zoom', { id, dir }),
  printTab: (id) => ipcRenderer.invoke('tab-print', id),
  muteTab: (id, muted) => ipcRenderer.invoke('tab-mute', { id, muted }),
  screenshotTab: (id) => ipcRenderer.invoke('tab-screenshot', id),
  readerTab: (id) => ipcRenderer.invoke('tab-reader', id),
  darkTab: (id) => ipcRenderer.invoke('tab-dark', id),
  showTabMenu: (id, x, y, pinned, muted) => ipcRenderer.invoke('tab-menu', { id, x, y, pinned: !!pinned, muted: !!muted }),

  // размер области страницы: main двигает WebContentsView под этот прямоугольник
  setViewRect: (r) => ipcRenderer.send('set-view-rect', r),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  devtoolsTab: (id) => ipcRenderer.send('tab-devtools', id),

  // данные
  loadBookmarks: () => ipcRenderer.invoke('load-bookmarks'),
  saveBookmarks: (list) => ipcRenderer.invoke('save-bookmarks', list),
  loadHistory: () => ipcRenderer.invoke('load-history'),
  saveHistory: (list) => ipcRenderer.invoke('save-history', list),
  loadDownloads: () => ipcRenderer.invoke('load-downloads'),
  loadSession: () => ipcRenderer.invoke('load-session'),
  saveSession: (urls) => ipcRenderer.invoke('save-session', urls),
  openDownloadsFolder: () => ipcRenderer.invoke('open-downloads-folder'),
  suggest: (q) => ipcRenderer.invoke('suggest', q),
  clearBrowsingData: () => ipcRenderer.invoke('clear-browsing-data'),

  // настройки + AI
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  aiChat: (messages) => ipcRenderer.invoke('ai-chat', { messages }),
  getPageText: (id) => ipcRenderer.invoke('get-page-text', id),

  // менеджер паролей
  passwordsStatus: () => ipcRenderer.invoke('passwords-status'),
  passwordsSetMaster: (oldPw, newPw) => ipcRenderer.invoke('passwords-set-master', { oldPw, newPw }),
  passwordsUnlock: (pw) => ipcRenderer.invoke('passwords-unlock', pw),
  passwordsLock: () => ipcRenderer.invoke('passwords-lock'),
  passwordsList: () => ipcRenderer.invoke('passwords-list'),
  passwordsSave: (entry) => ipcRenderer.invoke('passwords-save', entry),
  passwordsDelete: (id) => ipcRenderer.invoke('passwords-delete', id),
  passwordsOffer: () => ipcRenderer.invoke('passwords-offer'),
  passwordsOfferClear: () => ipcRenderer.invoke('passwords-offer-clear'),

  // события
  onMenuAction: (cb) => ipcRenderer.on('menu-action', (_e, action, payload) => cb(action, payload)),
  onOpenNewTab: (cb) => ipcRenderer.on('open-new-tab', (_e, url) => cb(url)),
  onTabEvent: (cb) => ipcRenderer.on('tab-event', (_e, evt) => cb(evt)),
  onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', () => cb()),
  onDataCleared: (cb) => ipcRenderer.on('browsing-data-cleared', () => cb()),
  onPasswordOffer: (cb) => ipcRenderer.on('password-offer', (_e, d) => cb(d)),
  onUpdateInfo: (cb) => ipcRenderer.on('update-info', (_e, info) => cb(info)),
  appInfo: () => ipcRenderer.invoke('app-version'),
  checkUpdates: () => ipcRenderer.invoke('update-check-now'),
  updateInfo: () => ipcRenderer.invoke('update-info'),

  copyText: (text) => ipcRenderer.send('copy-text', String(text || '')),
  showItemInFolder: (p) => ipcRenderer.send('show-item-in-folder', String(p || '')),

  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
