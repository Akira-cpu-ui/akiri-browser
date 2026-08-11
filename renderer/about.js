// Akiri Browser — страница «О браузере»: версии и проверка обновлений.
// Работает через pageAPI (гостевой preload) — доступен только нашим file:// страницам.
(function () {
  'use strict';
  const api = window.pageAPI;
  if (!api) return;

  const $ = (id) => document.getElementById(id);

  function fmtDate(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return String(ts);
    }
  }

  function render(info, appVer) {
    const box = $('update-status');
    const notes = $('update-notes');
    const actions = $('update-actions');
    box.classList.remove('loading');
    if (!info || info.enabled === false) {
      box.className = 'update-box off';
      box.textContent = 'Проверка обновлений выключена. Укажите URL файла версий в Настройки → Обновления.';
      notes.classList.add('hidden');
      if (actions) actions.classList.add('hidden');
      return;
    }
    if (info.available) {
      box.className = 'update-box new';
      const btn = $('update-install-btn');
      if (info.downloaded && info.downloadedVersion) {
        box.innerHTML = `Обновление <b>${info.latest}</b> скачано — установится при закрытии браузера (у вас ${appVer})`;
        if (btn) btn.textContent = 'Перезапустить и обновить';
      } else {
        box.innerHTML = `Доступна новая версия <b>${info.latest}</b> (у вас ${appVer})`;
        if (btn) btn.textContent = 'Скачать и установить';
      }
      if (actions) {
        actions.classList.remove('hidden');
        $('update-install-btn').dataset.latest = info.latest || '';
      }
      if (info.notes) {
        notes.classList.remove('hidden');
        notes.innerHTML = `<b>Что нового в ${info.latest}:</b>\n${String(info.notes).replace(/</g, '&lt;')}`;
      }
    } else if (info.error) {
      box.className = 'update-box err';
      box.textContent = 'Не удалось проверить обновления: ' + info.error + ' (проверено ' + fmtDate(info.checkedAt) + ')';
      notes.classList.add('hidden');
    } else {
      box.className = 'update-box ok';
      box.textContent = '✓ У вас актуальная версия ' + appVer + ' (проверено ' + fmtDate(info.checkedAt) + ')';
      notes.classList.add('hidden');
    }
  }

  (async function init() {
    let appVer = '?';
    try {
      const a = await api.appInfo();
      appVer = (a && a.version) || '?';
      $('app-version').textContent = appVer;
      $('chrome-version').textContent = (a && a.chrome) || '—';
      $('electron-version').textContent = (a && a.electron) || '—';
      $('node-version').textContent = (a && a.node) || '—';
    } catch (_) {
      /* ignore */
    }
    document.title = 'О браузере — Akiri Browser ' + appVer;

    const info = await api.updateInfo();
    render(info, appVer);

    $('check-now').addEventListener('click', async () => {
      const box = $('update-status');
      box.className = 'update-box loading';
      box.innerHTML = '<span class="spinner"></span> Проверяем…';
      const r = await api.checkUpdates();
      render(r, appVer);
    });

    // одно-кнопочное обновление: скачать установщик → закрыть → обновиться → открыться
    const btn = $('update-install-btn');
    const prog = $('update-progress');
    const fill = $('up-bar-fill');
    const ptext = $('up-bar-text');
    let downloading = false;
    const fmt = (n) => {
      if (!n) return '0 МБ';
      return (n / 1048576).toFixed(1).replace('.', ',') + ' МБ';
    };
    btn.addEventListener('click', async () => {
      if (downloading) return;
      downloading = true;
      btn.disabled = true;
      prog.classList.remove('hidden');
      ptext.textContent = 'Скачиваем установщик…';
      const r = await api.updateDownload();
      if (!r || !r.ok) {
        downloading = false;
        btn.disabled = false;
        prog.classList.add('hidden');
        ptext.textContent = '';
        alert('Не удалось скачать обновление: ' + ((r && r.error) || 'ошибка'));
        return;
      }
      const size = r.size || 0;
      fill.style.width = '100%';
      ptext.textContent = 'Готово: ' + fmt(size);
      if (
        confirm(
          `Установщик v${btn.dataset.latest || ''} скачан (${fmt(size)}).\n` +
            'Браузер закроется, обновится и откроется сам. Продолжить?'
        )
      ) {
        ptext.textContent = 'Обновляем… браузер сейчас закроется';
        await api.updateInstall(r.path);
      } else {
        downloading = false;
        btn.disabled = false;
        prog.classList.add('hidden');
      }
    });

    if (api.onUpdateProgress) {
      api.onUpdateProgress((p) => {
        if (!p) return;
        if (p.phase === 'download') {
          prog.classList.remove('hidden');
          const pct = p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0;
          fill.style.width = pct + '%';
          ptext.textContent = p.total
            ? `Скачиваем… ${pct}% (${fmt(p.received)} из ${fmt(p.total)})`
            : `Скачиваем… ${fmt(p.received)}`;
        } else if (p.phase === 'error') {
          downloading = false;
          btn.disabled = false;
          ptext.textContent = 'Ошибка: ' + (p.error || '?');
        }
      });
    }

    if (api.onUpdateInfo) api.onUpdateInfo(() => api.updateInfo().then((i) => render(i, appVer)));

    $('about-foot').textContent = `Akiri Browser ${appVer} — данные хранятся локально, в файлах приложения.`;
  })();
})();
