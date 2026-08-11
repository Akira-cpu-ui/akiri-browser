// Akiri Browser — страница настроек.
// Работает через pageAPI (гостевой preload) — доступен только нашим file:// страницам.
(function () {
  'use strict';
  const api = window.pageAPI;
  if (!api) return;

  const $ = (id) => document.getElementById(id);
  const fields = {
    home: $('home'),
    engine: $('engine'),
    accent: $('accent'),
    baseUrl: $('baseUrl'),
    model: $('model'),
    key: $('key'),
    startPage: $('startPage'),
    newTabPage: $('newTabPage'),
    restoreSession: $('restoreSession'),
    saveHistory: $('saveHistory'),
    suggestions: $('suggestions'),
    zoom: $('zoom'),
    sidePanel: $('sidePanel'),
    downloadDir: $('downloadDir'),
    autofillPasswords: $('autofillPasswords'),
    popupWindows: $('popupWindows'),
    aiEnabled: $('aiEnabled'),
    autoUpdate: $('autoUpdate'),
  };
  let currentWallpaper = 'network';

  let savedTimer = null;
  function showSaved() {
    const el = $('saved');
    el.classList.remove('hidden');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.add('hidden'), 1500);
  }

  async function collect() {
    return {
      homeUrl: fields.home.value.trim() || 'https://www.google.com/',
      searchEngine: fields.engine.value,
      accent: fields.accent.value,
      startPage: fields.startPage.value,
      newTabPage: fields.newTabPage.value,
      restoreSession: fields.restoreSession.checked,
      saveHistory: fields.saveHistory.checked,
      suggestions: fields.suggestions.checked,
      zoom: Math.min(3, Math.max(0.5, (Number(fields.zoom.value) || 100) / 100)),
      sidePanel: fields.sidePanel.checked,
      wallpaper: currentWallpaper,
      downloadDir: fields.downloadDir.value.trim(),
      autofillPasswords: fields.autofillPasswords.checked,
      popupWindows: fields.popupWindows.checked,
      aiEnabled: fields.aiEnabled.checked,
      autoUpdate: fields.autoUpdate.checked,
      ai: {
        baseUrl: fields.baseUrl.value.trim() || 'https://opencode.ai/zen/v1',
        model: fields.model.value.trim(),
        apiKey: fields.key.value.trim(),
      },
    };
  }

  async function save() {
    await api.saveSettings(await collect());
    showSaved();
  }

  function paintWallpapers() {
    document.querySelectorAll('.wp-opt').forEach((b) => {
      b.classList.toggle('sel', b.dataset.wp === currentWallpaper);
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  (async function init() {
    let settings = {};
    try {
      settings = (await api.loadSettings()) || {};
    } catch (_) {
      /* ignore */
    }
    fields.home.value = settings.homeUrl || 'https://www.google.com/';
    fields.engine.value = settings.searchEngine || 'google';
    fields.accent.value = settings.accent || '#5b8cff';
    fields.baseUrl.value = (settings.ai && settings.ai.baseUrl) || 'https://opencode.ai/zen/v1';
    fields.model.value = (settings.ai && settings.ai.model) || '';
    fields.key.value = (settings.ai && settings.ai.apiKey) || '';
    fields.startPage.value = settings.startPage || 'ntp';
    fields.newTabPage.value = settings.newTabPage || 'ntp';
    fields.restoreSession.checked = settings.restoreSession !== false;
    fields.saveHistory.checked = settings.saveHistory !== false;
    fields.suggestions.checked = settings.suggestions !== false;
    fields.zoom.value = Math.round((Number(settings.zoom) || 1) * 100);
    fields.sidePanel.checked = settings.sidePanel !== false;
    fields.downloadDir.value = settings.downloadDir || '';
    fields.autofillPasswords.checked = settings.autofillPasswords !== false;
    fields.popupWindows.checked = settings.popupWindows !== false;
    fields.aiEnabled.checked = settings.aiEnabled !== false;
    fields.autoUpdate.checked = settings.autoUpdate !== false;
    $('updateUrl').value = settings.updateUrl || '';
    currentWallpaper = settings.wallpaper || 'network';
    paintWallpapers();
    $('ai-fields').classList.toggle('dim', !fields.aiEnabled.checked);

    const dl = $('freeModels');
    (settings.freeModels || []).forEach((m) => {
      const o = document.createElement('option');
      o.value = m;
      dl.appendChild(o);
    });

    // автосохранение с небольшой задержкой
    let timer = null;
    Object.values(fields).forEach((f) => {
      f.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(save, 500);
      });
      if (f.type === 'checkbox') {
        f.addEventListener('change', () => {
          clearTimeout(timer);
          timer = setTimeout(save, 150);
          if (f === fields.aiEnabled) $('ai-fields').classList.toggle('dim', !f.checked);
        });
      }
    });

    // обои: клик по превью
    document.querySelectorAll('.wp-opt').forEach((b) => {
      b.addEventListener('click', () => {
        currentWallpaper = b.dataset.wp;
        paintWallpapers();
        save();
      });
    });

    $('pick-dir').addEventListener('click', async () => {
      const r = await api.chooseDownloadDir();
      if (r && r.ok && r.path) {
        fields.downloadDir.value = r.path;
        save();
      }
    });

    $('open-downloads').addEventListener('click', () => api.openDownloadsFolder());
    $('open-passwords').addEventListener('click', () => api.openPasswordsPage());

    // ---------- расширения ----------
    const extListEl = $('ext-list');
    const extResult = $('ext-result');
    async function renderExtensions() {
      const r = await api.extensionsList();
      if (!r || !r.ok || !r.list || !r.list.length) {
        extListEl.innerHTML = '<div class="ext-empty">Пока не загружено ни одного расширения</div>';
        return;
      }
      extListEl.innerHTML = r.list
        .map((e) =>
          `<div class="ext-item"><span class="ext-name">${esc(e.name)} <i>v${esc(e.version)}</i></span>` +
          `<span class="ext-path">${esc(e.path)}</span>` +
          `<button class="ext-del" data-id="${esc(e.id)}" title="Удалить">✕</button></div>`
        )
        .join('');
      extListEl.querySelectorAll('.ext-del').forEach((b) => {
        b.addEventListener('click', async () => {
          await api.extensionsRemove(b.dataset.id);
          renderExtensions();
        });
      });
    }

    $('ext-load').addEventListener('click', async () => {
      const p = $('extPath').value.trim();
      extResult.className = '';
      if (!p) { extResult.className = 'err'; extResult.textContent = 'Введите путь к папке расширения.'; return; }
      extResult.textContent = 'Загружаем…';
      const r = await api.extensionsLoad(p);
      if (r && r.ok) {
        extResult.className = 'ok';
        extResult.textContent = `Расширение «${r.name}» v${r.version} загружено.`;
        $('extPath').value = '';
        renderExtensions();
      } else {
        extResult.className = 'err';
        extResult.textContent = 'Ошибка: ' + ((r && r.error) || 'неизвестная');
      }
    });
    renderExtensions();

    // ---------- обновления ----------
    $('updateUrl').addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(save, 500);
    });
    const updResult = $('upd-result');
    $('check-upd').addEventListener('click', async () => {
      updResult.className = '';
      updResult.textContent = 'Проверяем…';
      const r = await api.checkUpdates();
      if (!r || r.enabled === false) {
        updResult.className = 'dim';
        updResult.textContent = 'Проверка выключена — укажите URL файла версий выше.';
      } else if (r.available) {
        updResult.className = 'ok';
        updResult.textContent = `Доступна новая версия ${r.latest} (у вас ${r.current}).`;
      } else if (r.error) {
        updResult.className = 'err';
        updResult.textContent = 'Ошибка: ' + r.error;
      } else {
        updResult.className = 'ok';
        updResult.textContent = `✓ Актуальная версия (${r.current}).`;
      }
    });

    // ---------- данные ----------
    $('open-data').addEventListener('click', () => api.openDataFolder());
    $('export-bm').addEventListener('click', async () => {
      const r = await api.exportBookmarks();
      if (r && r.ok) showSaved();
    });
    $('import-bm').addEventListener('click', async () => {
      const r = await api.importBookmarks();
      if (r && r.ok) showSaved();
    });

    $('clear-data').addEventListener('click', async () => {
      if (!confirm('Очистить историю, куки, кеш и данные сайтов? Закладки останутся.')) return;
      await api.clearBrowsingData();
      showSaved();
    });

    $('ai-test').addEventListener('click', async () => {
      const out = $('ai-test-result');
      out.className = '';
      out.textContent = 'Проверяем…';
      const res = await api.aiChat([{ role: 'user', content: 'Ответь одним словом: работаешь?' }]);
      if (res && res.error) {
        out.className = 'err';
        out.textContent =
          res.error === 'no-key' ? 'Сначала вставьте ключ API.' : 'Ошибка: ' + res.error;
      } else if (res && res.text) {
        out.className = 'ok';
        out.textContent = 'Подключение работает. Ответ модели: ' + res.text.slice(0, 120);
      } else {
        out.className = 'err';
        out.textContent = 'Пустой ответ. Проверьте адрес API и модель.';
      }
    });

    const about = $('about');
    about.innerHTML =
      `<b>Akiri Browser</b><br>` +
      `Electron ${api.versions.electron} · Chromium ${api.versions.chrome}<br>` +
      `Настройки хранятся в папке данных приложения (settings.json).`;
    api.appInfo().then((v) => {
      if (v && v.version) {
        about.innerHTML =
          `<b>Akiri Browser v${v.version}</b><br>` +
          `Electron ${api.versions.electron} · Chromium ${api.versions.chrome}<br>` +
          `Настройки хранятся в папке данных приложения (settings.json).`;
      }
    });
  })();
})();
