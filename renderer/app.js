// Akiri Browser — renderer logic (WebContentsView: вкладки живут в main-процессе,
// рендерер управляет ими через IPC и рисует только интерфейс браузера)
'use strict';

const api = window.browserAPI;
const NTP_URL = api.ntpUrl; // стартовая страница — локальный файл
const SETTINGS_URL = api.settingsUrl; // страница настроек
const PASSWORDS_URL = api.passwordsUrl; // менеджер паролей
const ABOUT_URL = api.aboutUrl; // страница «О браузере»
const HISTORY_URL = api.historyUrl; // страница «История»
const DOWNLOADS_URL = api.downloadsUrl; // страница «Загрузки»
const ENGINES = {
  google: 'https://www.google.com/search?q=',
  yandex: 'https://yandex.ru/search/?text=',
  duckduckgo: 'https://duckduckgo.com/?q=',
};
const DEFAULT_HOME = 'https://www.google.com/';
const INC = new URLSearchParams(location.search).get('mode') === 'incognito';
// свежее окно (Ctrl+N): НЕ восстанавливает сессию, как в Chrome
const FRESH = new URLSearchParams(location.search).get('fresh') === '1';
let settings = {}; // homeUrl, searchEngine, accent, ai — из settings.json
let aiMessages = []; // история чата AI
let aiPageCtx = ''; // текст открытой страницы для вопроса

// ---------- state ----------
let tabs = [];            // { id, url, title, pinned, loading, el, iconEl, titleEl }
let activeTabId = null;
let closedTabs = [];      // stack for Ctrl+Shift+T
let bookmarks = [];
let history = [];
let downloads = [];
let dragId = null;
let findLastText = '';
let appVersion = ''; // версия приложения (из main, чтобы не хардкодить)

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const elTabs = $('tabs');
const elViews = $('views');
const elAddress = $('address');
const elForm = $('address-form');
const elBookmarkBtn = $('btn-bookmark');
const elMenuBtn = $('btn-menu');
const elDropdown = $('dropdown');
const elToast = $('toast');
const elFindBar = $('findbar');
const elFindInput = $('find-input');
const elFindCount = $('find-count');
const elSuggest = $('suggest');
const elDlBar = $('downloadsbar');
const elAiPanel = $('aipanel');
const elAiMessages = $('ai-messages');
const elAiInput = $('ai-input');
const elAiForm = $('ai-form');
const elAiNote = $('ai-note');
let suggestItems = [];
let sugIndex = -1;
let suggestTimer = null;

function isNtpUrl(u) {
  if (!u || u === 'about:blank') return true;
  if (u === NTP_URL) return true;
  try {
    // путь установки может содержать пробелы — Chromium кодирует их как %20
    return decodeURIComponent(u) === NTP_URL;
  } catch (_) {
    return false;
  }
}

// свои страницы браузера (стартовая, настройки, пароли, история, загрузки) — прячем из адресной строки, как chrome://
function isBrowserPage(u) {
  if (isNtpUrl(u)) return true;
  if (!u) return false;
  const d = decodeURIComponentSafe(u);
  return (
    d.includes('settings.html') ||
    d.includes('passwords.html') ||
    d.includes('history.html') ||
    d.includes('downloads.html') ||
    d.includes('about.html')
  );
}
function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

function searchUrl(q) {
  return (ENGINES[settings.searchEngine] || ENGINES.google) + encodeURIComponent(q);
}

function homeUrl() {
  return settings.homeUrl || DEFAULT_HOME;
}

async function loadSettings() {
  settings = (await api.loadSettings()) || {};
  document.documentElement.style.setProperty('--accent', settings.accent || '#5b8cff');
  document.body.classList.toggle('no-sidepanel', settings.sidePanel === false);
  // AI выключен → прячем AI-кнопки (люди без ключа не споткнутся)
  const aiOff = settings.aiEnabled === false;
  document.getElementById('rail-ai').classList.toggle('hidden', aiOff);
  document.getElementById('dd-ai').classList.toggle('hidden', aiOff);
}

// ---------- размер области страницы ----------
// Страница (WebContentsView) — отдельный слой ОС поверх DOM, поэтому оверлеи рисуются
// в chrome-зоне, а страница двигается под них: main получает точный прямоугольник #views.
function reportChrome() {
  const r = elViews.getBoundingClientRect();
  api.setViewRect({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg) {
  elToast.textContent = msg;
  elToast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elToast.classList.add('hidden'), 3500);
}

// ---------- address parsing ----------
function parseInput(raw) {
  const s = (raw || '').trim();
  if (!s) return NTP_URL;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;
  if (/^localhost(:\d+)?([\/?#].*)?$/i.test(s)) return 'http://' + s;
  const looksLikeDomain =
    /^[\w-]+(\.[\w-]+)+(\/[^\s]*)?$/.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([\/?#].*)?$/.test(s);
  if (looksLikeDomain) return 'https://' + s;
  return searchUrl(s);
}

function windowTitleBase() {
  return INC ? 'Инкогнито — Akiri Browser' : 'Akiri Browser';
}

// ---------- tabs ----------
async function createTab(url, opts = {}) {
  // Ctrl+T / «+»: стартовая страница или домашняя — как настроено
  const target = url || (settings.newTabPage === 'home' ? homeUrl() : NTP_URL);
  const id = await api.createTab(target, INC);
  const tab = {
    id,
    url: target,
    title: 'Новая вкладка',
    pinned: !!opts.pinned,
    loading: false,
    audible: false,
    muted: false,
    el: null,
    iconEl: null,
    titleEl: null,
  };

  // кнопка вкладки
  const el = document.createElement('div');
  el.className = 'tab' + (tab.pinned ? ' pinned' : '');
  el.dataset.id = id;
  el.draggable = true;
  el.innerHTML =
    '<span class="tab-icon"></span>' +
    '<span class="tab-title">Новая вкладка</span>' +
    '<span class="tab-close" title="Закрыть вкладку">×</span>';
  const closeBtn = el.querySelector('.tab-close');
  closeBtn.draggable = false; // не начинаем drag при клике по «×»
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(id);
  });
  el.addEventListener('click', () => selectTab(id));
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) closeTab(id); // средняя кнопка закрывает
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openTabMenu(id, e.clientX, e.clientY);
  });
  enableDrag(el, id);
  elTabs.appendChild(el);

  tab.el = el;
  tab.iconEl = el.querySelector('.tab-icon');
  tab.titleEl = el.querySelector('.tab-title');
  setLetterIcon(tab);

  tabs.push(tab);
  if (opts.insertAfter) {
    moveTabTo(id, getTab(opts.insertAfter));
  } else if (!opts.restored && activeTabId) {
    // как в Chrome: новая вкладка открывается рядом с текущей
    moveTabTo(id, getTab(activeTabId));
  }
  if (opts.activate !== false) selectTab(id);
  return tab;
}

function setFavicon(tab, src) {
  tab.iconEl.innerHTML = '';
  const img = document.createElement('img');
  img.src = src;
  img.onerror = () => setLetterIcon(tab);
  tab.iconEl.appendChild(img);
}

function setLetterIcon(tab) {
  tab.iconEl.innerHTML = '';
  const t = (tab.title || '?').trim();
  tab.iconEl.textContent = t ? t.charAt(0).toUpperCase() : '?';
}

function selectTab(id) {
  if (activeTabId === id) return;
  activeTabId = id;
  for (const t of tabs) t.el.classList.toggle('active', t.id === id);
  api.activateTab(id); // main: показать вкладку и дать фокус странице
  updateAddress();
  updateNavState();
  updateBookmarkBtn();
  updateTitle();
}

function updateTitle() {
  const tab = getTab(activeTabId);
  // как в Chrome: в заголовке окна только название страницы
  const pageTitle = tab && !isNtpUrl(tab.url) ? tab.title : '';
  document.title = pageTitle || windowTitleBase();
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  if (!tab.pinned) {
    closedTabs.unshift({ url: tab.url, title: tab.title, pinned: tab.pinned });
    if (closedTabs.length > 15) closedTabs.pop();
  }
  tab.el.remove();
  tabs.splice(idx, 1);
  api.closeTab(id);
  if (activeTabId === id) {
    const next = tabs[Math.max(0, idx - 1)] || tabs[0];
    if (next) selectTab(next.id);
  }
  if (tabs.length === 0) createTab();
}

function reopenTab() {
  const t = closedTabs.shift();
  createTab(t ? t.url : null, { pinned: t && t.pinned });
}

function cycleTab(dir) {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  const next = tabs[(idx + dir + tabs.length) % tabs.length];
  selectTab(next.id);
}

function selectTabByIndex(i) {
  const t = i === 8 ? tabs[tabs.length - 1] : tabs[i];
  if (t) selectTab(t.id);
}

function getTab(id) {
  return tabs.find((t) => t.id === id);
}

// ---------- tab ordering: drag & drop, pin, insert-after ----------
function enableDrag(el, id) {
  el.addEventListener('dragstart', (e) => {
    dragId = id;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    dragId = null;
  });
  el.addEventListener('dragover', (e) => e.preventDefault());
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragId) reorderTab(dragId, id);
  });
}

function reorderTab(moveId, targetId) {
  if (moveId === targetId) return;
  let from = tabs.findIndex((t) => t.id === moveId);
  const tab = tabs[from];
  tabs.splice(from, 1);
  let to = tabs.findIndex((t) => t.id === targetId);
  tabs.splice(to, 0, tab);
  keepPinnedFirst(); // внутри — notifyTabOrder()
}

// сообщаем хосту новый порядок вкладок (перетаскивание/вставка/закрепление), чтобы
// сессия при следующем запуске восстанавливала именно его. В Electron-версии метод
// отсутствует — гард не даёт сломать общий код.
function notifyTabOrder() {
  if (api.reorderTabs) api.reorderTabs(tabs.map((t) => t.id));
}

function moveTabTo(id, anchor) {
  if (!anchor) return;
  const from = tabs.findIndex((t) => t.id === id);
  const tab = tabs[from];
  tabs.splice(from, 1);
  const to = tabs.findIndex((t) => t.id === anchor.id);
  tabs.splice(to + 1, 0, tab);
  keepPinnedFirst(); // внутри — notifyTabOrder()
}

function keepPinnedFirst() {
  const pins = tabs.filter((t) => t.pinned);
  const rest = tabs.filter((t) => !t.pinned);
  tabs = pins.concat(rest);
  tabs.forEach((t) => elTabs.appendChild(t.el)); // appendChild перемещает узел
  notifyTabOrder();
}

function setPinned(id, pinned) {
  const t = getTab(id);
  if (!t || t.pinned === pinned) return;
  t.pinned = pinned;
  t.el.classList.toggle('pinned', pinned);
  api.setPinned(id, pinned); // main сохранит сессию с флагом pinned
  keepPinnedFirst();
}

function duplicateTab(id) {
  const t = getTab(id);
  if (!t) return;
  createTab(isNtpUrl(t.url) ? null : t.url, { insertAfter: t });
}

function closeOthers(id) {
  const ids = tabs.filter((t) => t.id !== id && !t.pinned).map((t) => t.id);
  ids.forEach(closeTab);
}

function closeRight(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const ids = tabs.filter((t, i) => i > idx && !t.pinned).map((t) => t.id);
  ids.forEach(closeTab);
}

// ---------- tab context menu (нативное меню — рисуется поверх всего) ----------
function openTabMenu(id, x, y) {
  const t = getTab(id);
  if (!t) return;
  api.showTabMenu(id, x, y, t.pinned, t.muted);
}

function updateTabAudio(tab) {
  tab.el.classList.toggle('audible', tab.audible && !tab.muted);
  tab.el.classList.toggle('muted-tab', tab.audible && tab.muted);
}

// ---------- navigation ----------
function navigateActive(raw) {
  const tab = getTab(activeTabId);
  if (!tab) return;
  // AI-запрос прямо из адресной строки: «ai: вопрос» или «@ai вопрос»
  // AI-запрос прямо из адресной строки: «ai: вопрос» или «@ai вопрос»
  // (работает, только если AI включён в настройках — иначе это обычный поиск)
  const aiMatch = settings.aiEnabled !== false && String(raw || '').trim().match(/^(ai[:\s]|@ai\s)(.+)$/i);
  if (aiMatch) {
    openAi();
    aiSend(aiMatch[2]);
    elAddress.blur();
    return;
  }
  const url = parseInput(raw);
  tab.url = url;
  api.navigateTab(tab.id, url);
  elAddress.blur();
  api.activateTab(tab.id); // фокус на страницу
}

function displayUrlFor(tab) {
  if (!tab || isBrowserPage(tab.url)) return '';
  try {
    const u = new URL(tab.url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname; // как в Chrome
  } catch (_) {
    /* not a URL */
  }
  return tab.url;
}

function updateAddress(force) {
  const tab = getTab(activeTabId);
  // пока пользователь печатает — не мешаем; при blur (force) восстанавливаем домен.
  // ВАЖНО: во время blur-события activeElement ещё указывает на омнибокс,
  // поэтому проверка активного элемента здесь не сработала бы без force.
  if (!force && document.activeElement === elAddress) return;
  const val = displayUrlFor(tab);
  elAddress.value = val;
  elAddress.title = val;
}

const RELOAD_ICON =
  '<svg viewBox="0 0 24 24" width="17" height="17"><path fill="currentColor" d="M12 4a8 8 0 1 0 8 8h-2.5A5.5 5.5 0 1 1 12 6.5c1.9 0 3.6.95 4.6 2.4L13 12.5h8v-8l-2.6 2.6A9.97 9.97 0 0 0 12 2 10 10 0 1 0 22 12h-2.5A7.5 7.5 0 1 1 12 4z"/></svg>';
const STOP_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>';

function setReloadIcon(loading) {
  $('btn-reload').innerHTML = loading ? STOP_ICON : RELOAD_ICON;
}

async function updateNavState() {
  const tab = getTab(activeTabId);
  if (!tab) {
    $('btn-back').disabled = true;
    $('btn-fwd').disabled = true;
    setReloadIcon(false);
    return;
  }
  const myId = tab.id;
  const loading = !!tab.loading;
  const st = await api.tabState(myId);
  if (getTab(myId) && myId === activeTabId) {
    $('btn-back').disabled = !(st && st.canGoBack);
    $('btn-fwd').disabled = !(st && st.canGoForward);
    setReloadIcon(loading);
  }
}

// ---------- find in page ----------
function openFind() {
  elFindBar.classList.remove('hidden');
  elFindInput.value = findLastText;
  elFindInput.focus();
  elFindInput.select();
}

function runFind(forward, findNext) {
  const tab = getTab(activeTabId);
  if (!tab) return;
  const text = elFindInput.value;
  findLastText = text;
  if (text) api.findTab(tab.id, text, forward, findNext);
  else {
    api.stopFindTab(tab.id);
    elFindCount.textContent = '0/0';
  }
}

function closeFind() {
  elFindBar.classList.add('hidden');
  const tab = getTab(activeTabId);
  if (tab) api.stopFindTab(tab.id);
}

// ---------- поиск вкладок (Ctrl+Shift+A, как в Chrome) ----------
const elTabSearch = $('tabsearch');
const elTabSearchInput = $('tabsearch-input');
const elTabSearchList = $('tabsearch-list');
let tsIndex = -1;

function openTabSearch() {
  elTabSearch.classList.remove('hidden');
  elTabSearchInput.value = '';
  renderTabSearch('');
  elTabSearchInput.focus();
}
function closeTabSearch() {
  elTabSearch.classList.add('hidden');
}
function toggleTabSearch() {
  if (elTabSearch.classList.contains('hidden')) openTabSearch();
  else closeTabSearch();
}

function renderTabSearch(q) {
  const ql = q.trim().toLowerCase();
  const list = tabs
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !ql || (t.title || '').toLowerCase().includes(ql) || (t.url || '').toLowerCase().includes(ql));
  tsIndex = -1;
  elTabSearchList.innerHTML = '';
  list.forEach(({ t }) => {
    const d = document.createElement('div');
    d.className = 'ts-item' + (t.id === activeTabId ? ' current' : '');
    const ic = document.createElement('span');
    ic.className = 'ts-icon';
    ic.textContent = (t.title || '?').trim().charAt(0).toUpperCase();
    const tx = document.createElement('span');
    tx.className = 'ts-title';
    tx.textContent = t.title || 'Новая вкладка';
    const ux = document.createElement('span');
    ux.className = 'ts-url';
    ux.textContent = displayUrlFor(t) || t.url;
    d.append(ic, tx, ux);
    d.addEventListener('mousedown', (e) => e.preventDefault());
    d.addEventListener('click', () => {
      selectTab(t.id);
      closeTabSearch();
    });
    elTabSearchList.appendChild(d);
  });
  if (!list.length) {
    elTabSearchList.innerHTML = '<div class="ts-empty">Вкладок не найдено</div>';
  }
}

function moveTsIndex(dir) {
  const items = elTabSearchList.querySelectorAll('.ts-item');
  if (!items.length) return;
  items[tsIndex] && items[tsIndex].classList.remove('sel');
  tsIndex = (tsIndex + dir + items.length) % items.length;
  items[tsIndex].classList.add('sel');
  items[tsIndex].scrollIntoView({ block: 'nearest' });
}
function pickTsIndex() {
  const items = elTabSearchList.querySelectorAll('.ts-item');
  const it = items[tsIndex >= 0 ? tsIndex : 0];
  if (it) it.click();
}

// ---------- history ----------
function pushHistory(url, title) {
  if (INC || isBrowserPage(url) || settings.saveHistory === false) return;
  const last = history[0];
  if (last && last.url === url) {
    last.title = title || last.title;
    last.time = Date.now();
  } else {
    history.unshift({ url, title: title || url, time: Date.now() });
    if (history.length > 300) history.length = 300;
  }
  scheduleHistorySave();
}

function updateHistoryTitle(url, title) {
  const item = history.find((h) => h.url === url);
  if (item) item.title = title;
}

let historySaveTimer = null;
function scheduleHistorySave() {
  clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(() => api.saveHistory(history), 800);
}

// ---------- bookmarks ----------
function toggleBookmark() {
  const tab = getTab(activeTabId);
  if (!tab || isNtpUrl(tab.url)) {
    toast('Открытая страница не является сайтом');
    return;
  }
  const url = tab.url;
  const idx = bookmarks.findIndex((b) => b.url === url);
  if (idx >= 0) {
    bookmarks.splice(idx, 1);
    toast('Закладка удалена');
  } else {
    bookmarks.unshift({ url, title: tab.title && tab.title !== 'Новая вкладка' ? tab.title : url });
    toast('Добавлено в закладки');
  }
  api.saveBookmarks(bookmarks);
  updateBookmarkBtn();
}

function updateBookmarkBtn() {
  const tab = getTab(activeTabId);
  const isBm = tab && !isNtpUrl(tab.url) && bookmarks.some((b) => b.url === tab.url);
  elBookmarkBtn.classList.toggle('on', !!isBm);
}

// ---------- поисковые подсказки (Google Suggest) ----------
function onAddressInput() {
  const q = elAddress.value.trim();
  clearTimeout(suggestTimer);
  if (!q) {
    hideSuggest();
    return;
  }
  if (settings.suggestions === false) {
    hideSuggest();
    return;
  }
  suggestTimer = setTimeout(() => fetchSuggest(q), 150);
}

async function fetchSuggest(q) {
  try {
    const items = (await api.suggest(q)) || [];
    if (elAddress.value.trim() !== q) return; // пользователь уже поменял запрос
    renderSuggest(q, items);
  } catch (_) {
    hideSuggest();
  }
}

// свои совпадения: закладки и история (как в Chrome)
function localMatches(q) {
  const ql = q.toLowerCase();
  const bms = bookmarks
    .filter((b) => (b.title || '').toLowerCase().includes(ql) || b.url.toLowerCase().includes(ql))
    .slice(0, 3)
    .map((b) => ({ text: b.title || b.url, url: b.url, kind: 'bookmark' }));
  const his = history
    .filter((h) => !bms.some((b) => b.url === h.url) && ((h.title || '').toLowerCase().includes(ql) || h.url.toLowerCase().includes(ql)))
    .slice(0, 3)
    .map((h) => ({ text: h.title || h.url, url: h.url, kind: 'history' }));
  return bms.concat(his);
}

function renderSuggest(q, items) {
  const apiItems = (items || []).slice(0, 8).map((s) => ({ text: s, kind: 'sug' }));
  const local = localMatches(q);
  suggestItems = apiItems.concat(local).slice(0, 12);
  sugIndex = -1;
  if (!suggestItems.length) {
    hideSuggest();
    return;
  }
  elSuggest.innerHTML = '';
  suggestItems.forEach((it, i) => {
    const d = document.createElement('div');
    d.className =
      'sug-item' + (it.kind === 'bookmark' ? ' bm' : it.kind === 'history' ? ' hist' : '');
    d.textContent = it.text;
    d.title = it.kind === 'sug' ? 'Поиск' : it.url;
    d.addEventListener('mousedown', (e) => e.preventDefault()); // не убираем фокус с омнибокса
    d.addEventListener('click', () => pickSuggestion(i));
    elSuggest.appendChild(d);
  });
  elSuggest.classList.remove('hidden');
}

function moveSugIndex(dir) {
  const items = elSuggest.querySelectorAll('.sug-item');
  if (!items.length) return;
  items[sugIndex] && items[sugIndex].classList.remove('sel');
  sugIndex = (sugIndex + dir + items.length) % items.length;
  items[sugIndex].classList.add('sel');
  const it = suggestItems[sugIndex];
  elAddress.value = it.kind === 'sug' ? it.text : it.url;
}

function pickSuggestion(i) {
  const it = suggestItems[i];
  if (!it) return;
  hideSuggest();
  navigateActive(it.kind === 'sug' ? searchUrl(it.text) : it.url);
}

function hideSuggest() {
  elSuggest.classList.add('hidden');
  suggestItems = [];
  sugIndex = -1;
}

// ---------- AI-ассистент (боковая панель) ----------
function openAi() {
  elAiPanel.classList.remove('hidden');
  elAiInput.focus();
}
function closeAi() {
  elAiPanel.classList.add('hidden');
}
function toggleAi() {
  if (elAiPanel.classList.contains('hidden')) openAi();
  else closeAi();
}

function aiAddMsg(role, text) {
  aiMessages.push({ role, content: text });
  renderAiMessages();
}

function renderAiMessages() {
  elAiMessages.innerHTML = '';
  for (const m of aiMessages) {
    const d = document.createElement('div');
    d.className = 'ai-msg ' + m.role;
    d.textContent = m.content;
    elAiMessages.appendChild(d);
  }
  elAiMessages.scrollTop = elAiMessages.scrollHeight;
}

function aiNote() {
  const ai = settings.ai || {};
  const hasKey = String(ai.apiKey || '').trim();
  const statusEl = document.getElementById('ai-status');
  if (statusEl) statusEl.classList.toggle('on', !!hasKey);
  elAiNote.textContent = hasKey
    ? 'Модель: ' + ((ai.model || '').trim() || '—') + ' — всё готово, спрашивайте!'
    : 'Ключ API не настроен — откройте ☰ → Настройки и вставьте ключ OpenCode Zen.';
}

async function aiSend(raw) {
  const q = String(raw || '').trim();
  if (!q) return;
  aiAddMsg('user', q);

  const msgs = [];
  if (aiPageCtx) {
    msgs.push({ role: 'system', content: 'Ты — AI-ассистент браузера Akiri. Отвечай по-русски. Контекст — текст открытой страницы:\n\n' + aiPageCtx });
    aiPageCtx = '';
  }
  msgs.push(...aiMessages.slice(-12));

  const typing = document.createElement('div');
  typing.className = 'ai-msg ai typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  elAiMessages.appendChild(typing);
  elAiMessages.scrollTop = elAiMessages.scrollHeight;

  const res = await api.aiChat(msgs);
  typing.remove();
  if (res && res.error) {
    aiAddMsg('ai', res.error === 'no-key'
      ? 'Ключ API не настроен. Откройте ☰ → Настройки и вставьте ключ OpenCode Zen.'
      : 'Ошибка: ' + res.error);
  } else {
    aiAddMsg('ai', (res && res.text) || 'Нет ответа');
  }
  aiNote();
}

async function aiAboutPage(kind) {
  const tab = getTab(activeTabId);
  if (!tab || isNtpUrl(tab.url)) {
    toast('Сначала откройте страницу');
    return;
  }
  const pageText = await api.getPageText(tab.id);
  if (!pageText || pageText.length < 20) {
    toast('Не удалось прочитать текст страницы');
    return;
  }
  openAi();
  if (kind === 'summary') {
    aiPageCtx = pageText;
    aiSend('Кратко перескажи эту страницу: главная мысль и 3-5 ключевых пунктов.');
  } else if (kind === 'translate') {
    aiPageCtx = pageText;
    aiSend('Переведи текст этой страницы на русский язык.');
  } else {
    aiPageCtx = pageText;
    toast('Задайте вопрос о странице');
    elAiInput.focus();
  }
}

// ---------- предложение сохранить пароль ----------
const elPassBar = $('passbar');
const elPassText = $('passbar-text');

function showPasswordOffer(d) {
  let host = '';
  try {
    host = new URL(d.url).hostname;
  } catch (_) {
    host = d.url;
  }
  elPassText.textContent = `Сохранить пароль для ${host}${d.username ? ' («' + d.username + '»)' : ''}?`;
  elPassBar.classList.remove('hidden');
}

function hidePasswordOffer() {
  elPassBar.classList.add('hidden');
}

async function savePendingPassword() {
  const st = await api.passwordsStatus();
  if (!st.hasMaster) {
    toast('Сначала создайте мастер-пароль в менеджере паролей');
    createTab(PASSWORDS_URL);
    return; // предложение остаётся ждать на панели
  }
  if (!st.unlocked) {
    toast('Менеджер паролей заблокирован — разблокируйте в менеджере паролей');
    createTab(PASSWORDS_URL);
    return;
  }
  const off = await api.passwordsOffer();
  if (off && off.ok) {
    await api.passwordsSave({ url: off.url, username: off.username, password: off.password });
    await api.passwordsOfferClear();
    hidePasswordOffer();
    toast('Пароль сохранён');
  }
}

async function discardPendingPassword() {
  await api.passwordsOfferClear();
  hidePasswordOffer();
}

// ---------- dropdown (закладки / история / загрузки) ----------
function toggleDropdown(force) {
  const show = force !== undefined ? force : elDropdown.classList.contains('hidden');
  elDropdown.classList.toggle('hidden', !show);
  if (show) renderDropdown();
}

function renderDropdown() {
  const ddDownloads = $('dd-downloads');
  const ddBookmarks = $('dd-bookmarks');
  const ddHistory = $('dd-history');

  if (downloads.length) {
    ddDownloads.innerHTML = downloads
      .slice(0, 10)
      .map((d, i) => {
        const status =
          d.state === 'completed'
            ? '✓'
            : d.state === 'interrupted'
              ? '✕'
              : d.total > 0
                ? `${Math.round((d.received / d.total) * 100)}%`
                : '…';
        return `<button class="dd-item" data-dl="${i}" title="${escAttr(d.url)}">${escHtml(d.filename || d.url)} · ${status}</button>`;
      })
      .join('');
    ddDownloads.insertAdjacentHTML(
      'beforeend',
      '<button class="dd-item dd-muted" data-dl-folder="1">Открыть папку загрузок…</button>' +
        '<button class="dd-item dd-muted" data-dl-all="1">Все загрузки…</button>'
    );
    ddDownloads.querySelectorAll('[data-dl]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const d = downloads[+btn.dataset.dl];
        if (d && d.path) api.showItemInFolder(d.path);
        toggleDropdown(false);
      });
    });
    const folderBtn = ddDownloads.querySelector('[data-dl-folder]');
    if (folderBtn) {
      folderBtn.addEventListener('click', () => {
        api.openDownloadsFolder();
        toggleDropdown(false);
      });
    }
    const allBtn = ddDownloads.querySelector('[data-dl-all]');
    if (allBtn) {
      allBtn.addEventListener('click', () => {
        toggleDropdown(false);
        handleMenuAction('open-downloads');
      });
    }
  } else {
    ddDownloads.innerHTML = '<div class="dd-empty">Загрузок пока нет</div>';
  }

  if (bookmarks.length) {
    ddBookmarks.innerHTML = bookmarks
      .slice(0, 30)
      .map((b, i) => `<button class="dd-item" data-bm="${i}" title="${escAttr(b.url)}">★ ${escHtml(b.title || b.url)}</button>`)
      .join('');
    ddBookmarks.querySelectorAll('[data-bm]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const b = bookmarks[+btn.dataset.bm];
        if (b) createTab(b.url);
        toggleDropdown(false);
      });
    });
  } else {
    ddBookmarks.innerHTML = '<div class="dd-empty">Пока пусто — жмите на звёздочку ★</div>';
  }

  if (history.length) {
    ddHistory.innerHTML = history
      .slice(0, 30)
      .map((h, i) => `<button class="dd-item" data-h="${i}" title="${escAttr(h.url)}">${escHtml(h.title || h.url)}</button>`)
      .join('');
    ddHistory.querySelectorAll('[data-h]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const h = history[+btn.dataset.h];
        const tab = getTab(activeTabId);
        if (h && tab) api.navigateTab(tab.id, h.url);
        toggleDropdown(false);
      });
    });
    ddHistory.insertAdjacentHTML(
      'beforeend',
      '<button class="dd-item dd-muted" data-h-all="1">Полная история…</button>'
    );
    const hAll = ddHistory.querySelector('[data-h-all]');
    if (hAll) {
      hAll.addEventListener('click', () => {
        toggleDropdown(false);
        handleMenuAction('open-history');
      });
    }
  } else {
    ddHistory.innerHTML = '<div class="dd-empty">История пуста</div>';
  }

  $('dd-about').innerHTML =
    `<b>Akiri Browser${appVersion ? ' v' + appVersion : ''}</b><br>` +
    `Electron ${api.versions.electron} · Chromium ${api.versions.chrome}` +
    (INC ? '<br><i style="color:var(--accent)">Окно инкогнито — данные не сохраняются</i>' : '');
}

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
const escAttr = escHtml;

// ---------- загрузки ----------
function handleDownload(d) {
  const i = downloads.findIndex((x) => x.dlId === d.dlId);
  if (i >= 0) downloads[i] = d;
  else downloads.unshift(d);
  if (downloads.length > 30) downloads.length = 30;
  if (!elDropdown.classList.contains('hidden')) renderDropdown();
  renderDownloadsBar();
}

function renderDownloadsBar() {
  if (!downloads.length) {
    elDlBar.classList.add('hidden');
    return;
  }
  elDlBar.innerHTML = '';
  downloads.slice(0, 5).forEach((d) => {
    const item = document.createElement('div');
    item.className = 'dl-item' + (d.state === 'completed' ? ' done' : '');
    const pct = d.total > 0 ? Math.round((d.received / d.total) * 100) : null;
    let label =
      d.state === 'completed'
        ? '✓ '
        : d.state === 'interrupted'
          ? '✕ '
          : pct != null
            ? pct + '%'
            : '…';
    if (d.state !== 'completed' && d.state !== 'interrupted' && d.speed) {
      const s = d.speed;
      label += ' · ' + (s >= 1048576 ? (s / 1048576).toFixed(1) + ' МБ/с' : Math.round(s / 1024) + ' КБ/с');
    }
    item.textContent = label + ' ' + (d.filename || d.url);
    item.title = d.url;
    item.addEventListener('click', () => {
      if (d.path) api.showItemInFolder(d.path);
    });
    elDlBar.appendChild(item);
  });
  const close = document.createElement('button');
  close.className = 'dl-close';
  close.textContent = '×';
  close.title = 'Скрыть';
  close.addEventListener('click', () => elDlBar.classList.add('hidden'));
  elDlBar.appendChild(close);
  elDlBar.classList.remove('hidden');
}

// ---------- очистка данных браузера ----------
async function clearBrowsingData() {
  if (!confirm('Очистить историю, куки, кеш и данные сайтов? Закладки останутся.')) return;
  await api.clearBrowsingData();
  history = [];
  await api.saveHistory(history);
  tabs.forEach((t) => {
    if (!isNtpUrl(t.url)) api.navTab(t.id, 'reload');
  });
  toast('Данные браузера очищены');
}

// ---------- menu actions (из меню приложения / контекстных меню) ----------
function handleMenuAction(action, payload) {
  const active = () => getTab(activeTabId);
  switch (action) {
    case 'new-tab': createTab(); break;
    case 'new-tab-url': createTab(payload); break;
    case 'close-tab': closeTab(activeTabId); break;
    case 'reopen-tab': reopenTab(); break;
    case 'next-tab': cycleTab(1); break;
    case 'prev-tab': cycleTab(-1); break;
    case 'select-tab': selectTabByIndex(payload); break;
    case 'tab-search': openTabSearch(); break;
    case 'focus-address': elAddress.focus(); elAddress.select(); break;
    case 'bookmark': toggleBookmark(); break;
    case 'show-menu': toggleDropdown(); break;
    case 'back': {
      const t = active();
      if (t) {
        api.navTab(t.id, 'back');
        setTimeout(updateNavState, 300);
      }
      break;
    }
    case 'forward': {
      const t = active();
      if (t) {
        api.navTab(t.id, 'forward');
        setTimeout(updateNavState, 300);
      }
      break;
    }
    case 'reload': {
      const t = active();
      if (t) api.navTab(t.id, t.loading ? 'stop' : 'reload');
      break;
    }
    case 'reload-no-cache': {
      const t = active();
      if (t) api.navTab(t.id, 'reload-no-cache');
      break;
    }
    case 'home': navigateActive(homeUrl()); break;
    case 'reader': {
      const t = active();
      if (!t) break;
      if (isBrowserPage(t.url)) toast('Режим чтения работает на сайтах');
      else {
        api.readerTab(t.id);
        toast('Режим чтения — кнопка «Выйти» вверху страницы');
      }
      break;
    }
    case 'dark': {
      const t = active();
      if (!t) break;
      if (isBrowserPage(t.url)) toast('Ночной режим работает на сайтах');
      else {
        api.darkTab(t.id);
        toast('Ночной режим переключён');
      }
      break;
    }
    case 'screenshot': {
      const t = active();
      if (!t) break;
      if (isBrowserPage(t.url)) toast('Скриншот работает на сайтах');
      else {
        api.screenshotTab(t.id);
        toast('Скриншот сохранён в «Загрузки»');
      }
      break;
    }
    case 'ai-open':
      if (settings.aiEnabled === false) {
        toast('AI выключен в настройках — включите ☰ → Настройки');
        break;
      }
      toggleAi();
      break;
    case 'open-settings': createTab(SETTINGS_URL); break;
    case 'open-passwords': createTab(PASSWORDS_URL); break;
    case 'open-history': createTab(HISTORY_URL); break;
    case 'open-downloads': createTab(DOWNLOADS_URL); break;
    case 'ai-explain': {
      if (settings.aiEnabled === false) { toast('AI выключен в настройках'); break; }
      if (payload && payload.text) {
        openAi();
        aiSend('Объясни простыми словами, что значит этот текст: «' + payload.text + '»');
      }
      break;
    }
    case 'ai-translate-sel': {
      if (settings.aiEnabled === false) { toast('AI выключен в настройках'); break; }
      if (payload && payload.text) {
        openAi();
        aiSend('Переведи на русский язык этот текст: «' + payload.text + '»');
      }
      break;
    }
    case 'ai-rephrase-sel': {
      if (settings.aiEnabled === false) { toast('AI выключен в настройках'); break; }
      if (payload && payload.text) {
        openAi();
        aiSend('Перефразируй этот текст красивее и понятнее: «' + payload.text + '»');
      }
      break;
    }
    case 'ai-page-summary':
      if (settings.aiEnabled === false) { toast('AI выключен в настройках'); break; }
      aiAboutPage('summary');
      break;
    case 'print': {
      const t = active();
      if (!t) break;
      if (isNtpUrl(t.url)) toast('Сначала откройте страницу для печати');
      else api.printTab(t.id);
      break;
    }
    case 'find': openFind(); break;
    case 'find-next': {
      if (elFindBar.classList.contains('hidden')) openFind();
      else runFind(true, true);
      break;
    }
    case 'find-prev': runFind(false, true); break;
    case 'zoom-in': { const t = active(); if (t) api.zoomTab(t.id, 1); break; }
    case 'zoom-out': { const t = active(); if (t) api.zoomTab(t.id, -1); break; }
    case 'zoom-reset': { const t = active(); if (t) api.zoomTab(t.id, 0); break; }
    case 'devtools': {
      const t = active();
      if (t) api.devtoolsTab(t.id);
      break;
    }
    case 'fullscreen': api.toggleFullscreen(); break;
    case 'clear-data': clearBrowsingData(); break;
    case 'open-downloads-folder': api.openDownloadsFolder(); break;
    case 'about':
    case 'open-about':
      createTab(ABOUT_URL);
      break;
    case 'check-updates': {
      const t0 = Date.now();
      api.checkUpdates().then((info) => {
        const secs = ' (' + ((Date.now() - t0) / 1000).toFixed(1) + ' с)';
        if (!info || info.enabled === false) toast('Проверка обновлений выключена — укажите URL в настройках');
        else if (info.available) {
          toast('Доступна новая версия ' + info.latest + secs);
          showUpdateChip(info);
        } else if (info.error) toast('Ошибка проверки: ' + info.error);
        else toast('✓ Актуальная версия' + secs);
      });
      break;
    }
    case 'tab-menu-action': {
      if (!payload || !payload.id) break;
      const { id, action: act } = payload;
      switch (act) {
        case 'duplicate': duplicateTab(id); break;
        case 'pin': setPinned(id, !getTab(id).pinned); break;
        case 'reload': { const t = getTab(id); if (t) api.navTab(t.id, 'reload'); break; }
        case 'copy': { const t = getTab(id); if (t) api.copyText(t.url || ''); break; }
        case 'mute': { const t = getTab(id); if (t) { t.muted = !t.muted; api.muteTab(t.id, t.muted); updateTabAudio(t); } break; }
        case 'close': closeTab(id); break;
        case 'close-others': closeOthers(id); break;
        case 'close-right': closeRight(id); break;
      }
      break;
    }
  }
}

// ---------- события от main (вкладки, страницы, загрузки) ----------
function onTabEvent(evt) {
  const { id, type } = evt;
  const tab = getTab(id);
  switch (type) {
    case 'navigate': {
      if (tab) {
        tab.url = evt.url;
        if (!isNtpUrl(evt.url)) pushHistory(evt.url, tab.title);
      }
      if (id === activeTabId) {
        updateAddress();
        updateNavState();
        updateTitle();
      }
      break;
    }
    case 'title': {
      if (tab) {
        tab.title = evt.title && evt.title.trim() ? evt.title.trim() : tab.title;
        tab.titleEl.textContent = isNtpUrl(tab.url) ? 'Новая вкладка' : tab.title;
        if (id === activeTabId) {
          updateTitle();
          updateHistoryTitle(tab.url, tab.title);
        }
      }
      break;
    }
    case 'favicon': {
      if (tab && evt.favicons && evt.favicons.length) setFavicon(tab, evt.favicons[0]);
      break;
    }
    case 'audio': {
      if (tab) {
        tab.audible = !!evt.audible;
        updateTabAudio(tab);
      }
      break;
    }
    case 'loading': {
      if (tab) {
        tab.loading = !!evt.loading;
        tab.el.classList.toggle('loading', tab.loading);
        if (id === activeTabId) updateNavState();
      }
      break;
    }
    case 'fail': {
      if (tab && id === activeTabId) toast(`Не удалось загрузить страницу (${evt.desc || evt.code})`);
      break;
    }
    case 'crashed': {
      if (tab) {
        toast('Вкладка упала. Перезагружаем…');
        api.navTab(id, 'reload');
      }
      break;
    }
    case 'found': {
      const r = evt.result;
      elFindCount.textContent = r && r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : '0/0';
      break;
    }
    case 'download': {
      handleDownload(evt);
      break;
    }
  }
}

// ---------- events ----------
function bindChrome() {
  $('btn-back').addEventListener('click', () => handleMenuAction('back'));
  $('btn-fwd').addEventListener('click', () => handleMenuAction('forward'));
  $('btn-reload').addEventListener('click', () => handleMenuAction('reload'));
  $('btn-home').addEventListener('click', () => handleMenuAction('home'));
  $('btn-newtab').addEventListener('click', () => createTab());

  elForm.addEventListener('submit', (e) => {
    e.preventDefault();
    navigateActive(elAddress.value);
  });

  elAddress.addEventListener('focus', () => {
    // как в Chrome: при фокусе показываем полный URL, при потере фокуса — домен
    const tab = getTab(activeTabId);
    if (tab && !isBrowserPage(tab.url) && tab.url) elAddress.value = tab.url;
    elAddress.select();
  });
  elAddress.addEventListener('blur', () => {
    hideSuggest();
    updateAddress(true); // вернуть домен, как в Chrome
  });
  elAddress.addEventListener('input', onAddressInput);
  elAddress.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideSuggest();
      elAddress.blur();
    } else if (e.ctrlKey && e.key === 'Enter') {
      // Ctrl+Enter: оборачиваем в www..com, как в Chrome
      e.preventDefault();
      const v = elAddress.value.trim();
      if (v && !/[\s./]/.test(v)) navigateActive('https://www.' + v + '.com');
      else elForm.requestSubmit();
    } else if (!elSuggest.classList.contains('hidden') && suggestItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSugIndex(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSugIndex(-1);
      } else if (e.key === 'Enter' && sugIndex >= 0) {
        e.preventDefault();
        pickSuggestion(sugIndex);
      }
    }
  });

  // предложение сохранить пароль
  $('passbar-save').addEventListener('click', savePendingPassword);
  $('passbar-no').addEventListener('click', discardPendingPassword);
  api.onPasswordOffer((d) => showPasswordOffer(d));

  // поиск вкладок (Ctrl+Shift+A)
  elTabSearchInput.addEventListener('input', () => renderTabSearch(elTabSearchInput.value));
  elTabSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeTabSearch();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveTsIndex(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveTsIndex(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickTsIndex();
    }
  });

  // AI-панель
  elAiForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = elAiInput.value;
    elAiInput.value = '';
    aiSend(v);
  });
  $('ai-close').addEventListener('click', closeAi);
  document.querySelectorAll('#ai-actions button').forEach((b) => {
    b.addEventListener('click', () => aiAboutPage(b.dataset.ai));
  });

  elBookmarkBtn.addEventListener('click', toggleBookmark);
  elMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown();
  });

  // боковая панель с иконками
  document.querySelectorAll('#siderail .rail-btn').forEach((btn) => {
    btn.addEventListener('click', () => handleMenuAction(btn.dataset.action));
  });

  // чип «доступно обновление»
  $('btn-update').addEventListener('click', () => handleMenuAction('open-about'));

  $('dropdown').querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      toggleDropdown(false);
      handleMenuAction(btn.dataset.action);
    });
  });

  // find bar
  elFindInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runFind(!e.shiftKey, true);
    } else if (e.key === 'Escape') {
      closeFind();
    }
  });
  $('find-next').addEventListener('click', () => runFind(true, true));
  $('find-prev').addEventListener('click', () => runFind(false, true));
  $('find-close').addEventListener('click', closeFind);

  // закрытие оверлеев по клику мимо / Escape
  document.addEventListener('click', (e) => {
    if (!elDropdown.classList.contains('hidden') && !elDropdown.contains(e.target) && e.target !== elMenuBtn) {
      toggleDropdown(false);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleDropdown(false);
  });

  api.onMenuAction(handleMenuAction);
  api.onOpenNewTab((url) => createTab(url));
  api.onTabEvent(onTabEvent);
  api.onSettingsChanged(() => loadSettings());
  api.onUpdateInfo((info) => {
    if (!info || !info.available) return;
    showUpdateChip(info);
    const ver = String(info.latest || '');
    if (window.__updNotified === ver) return;
    window.__updNotified = ver;
    if (info.downloaded && info.downloadedVersion) {
      toast('Обновление v' + info.downloadedVersion + ' скачано — установится при закрытии браузера');
    } else {
      toast('Доступна новая версия Akiri Browser ' + ver + ' — скачивается автоматически');
    }
  });
  api.onDataCleared(() => {
    history = [];
    toast('Данные браузера очищены');
  });

  window.addEventListener('beforeunload', () => {
    // сессию сохраняет main-процесс (надёжно при закрытии); здесь только история
    if (!INC) api.saveHistory(history);
  });
}

// ---------- обновления: чип в панели навигации ----------
function showUpdateChip(info) {
  const chip = $('btn-update');
  if (!chip || !info || !info.latest) return;
  $('update-version').textContent = info.latest;
  chip.classList.remove('hidden');
  chip.classList.add('pulse');
}

// ---------- init ----------
async function init() {
  await loadSettings();
  bookmarks = (await api.loadBookmarks()) || [];
  history = (await api.loadHistory()) || [];
  bindChrome();
  aiNote();
  api.appInfo().then((v) => {
    if (v && v.version) appVersion = v.version;
  });

  // страница — отдельный слой ОС; следим за её областью и сообщаем main
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(reportChrome).observe(elViews);
  window.addEventListener('resize', reportChrome);
  reportChrome();

  // история загрузок (со скоростью и статусом) — восстанавливаем из файла
  try {
    downloads = (await api.loadDownloads()) || [];
    renderDownloadsBar();
  } catch (_) {
    /* ignore */
  }

  const session =
    INC || FRESH || settings.restoreSession === false ? null : await api.loadSession();
  if (session && Array.isArray(session) && session.length) {
    for (const entry of session) {
      const url = typeof entry === 'string' ? entry : entry.url;
      const pinned = typeof entry === 'object' && !!entry.pinned;
      // чужие file:// и старый ntp:// из старых сессий не восстанавливаем
      if (typeof url === 'string' && url.startsWith('file:') && !isNtpUrl(url)) continue;
      if (typeof url === 'string' && url.startsWith('ntp:')) continue;
      await createTab(url, { restored: true, pinned, activate: false });
    }
    if (!tabs.length) await createTab(homeUrl());
    selectTab(tabs[tabs.length - 1].id);
  } else {
    // первый запуск: стартовая страница или домашняя — как настроено
    await createTab(settings.startPage === 'home' ? homeUrl() : NTP_URL);
  }
  keepPinnedFirst();
}

init();
