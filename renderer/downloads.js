// Akiri Browser — страница «Загрузки»: скорость, прогресс, история.
// Работает через pageAPI (гостевой preload) — доступен только нашим file:// страницам.
(function () {
  'use strict';

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const list = document.getElementById('list');
  const empty = document.getElementById('empty');
  let cache = [];

  function fmtBytes(n) {
    if (!n || n < 0) return '0 Б';
    if (n < 1024) return n + ' Б';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' КБ';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' МБ';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' ГБ';
  }

  function fmtSpeed(bps) {
    if (!bps || bps <= 0) return '';
    return fmtBytes(bps) + '/с';
  }

  function fmtTime(t) {
    if (!t) return '';
    const d = new Date(t);
    const now = new Date();
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, now)) return 'сегодня, ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const y = new Date(now.getTime() - 864e5);
    if (same(d, y)) return 'вчера, ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }

  function icon(d) {
    if (d.state === 'completed') {
      return '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="#4cc38a" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
    }
    if (d.state === 'interrupted' || d.state === 'cancelled') {
      return '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="#f0615a" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 0 1 6.3 12.9L5.1 5.7A8 8 0 0 1 12 4zm0 16a8 8 0 0 1-6.3-12.9l13.2 13.2A8 8 0 0 1 12 20z"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="#9a9ea8" d="M12 3l-1.4 1.4L14.2 8H5v2h9.2l-3.6 3.6L12 15l6-6-6-6zm-7 14h14v2H5v-2z"/></svg>';
  }

  function statusText(d) {
    switch (d.state) {
      case 'completed': return '<span class="status-ok">Готово</span>';
      case 'interrupted': return '<span class="status-err">Ошибка</span>';
      case 'cancelled': return '<span class="status-err">Отменено</span>';
      default: {
        const pct = d.total > 0 ? Math.round((d.received / d.total) * 100) + '%' : '';
        return [pct, fmtSpeed(d.speed)].filter(Boolean).join(' · ');
      }
    }
  }

  function render() {
    list.innerHTML = '';
    empty.classList.toggle('hidden', cache.length > 0);
    cache.forEach((d) => {
      const pct = d.total > 0 ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0;
      const done = d.state === 'completed';
      const err = d.state === 'interrupted' || d.state === 'cancelled';
      const row = document.createElement('div');
      row.className = 'dl' + (done ? ' done' : '') + (err ? ' err' : '');
      row.innerHTML =
        `<div class="dl-icon">${icon(d)}</div>` +
        `<div class="dl-body">` +
        `<div class="dl-name" title="Открыть файл">${esc(d.filename || d.url)}</div>` +
        `<div class="dl-url" title="${esc(d.url)}">${esc(d.url)}</div>` +
        `<div class="dl-meta">${statusText(d)}` +
        (d.received > 0 ? ` · ${fmtBytes(d.received)}` + (d.total > 0 ? ` из ${fmtBytes(d.total)}` : '') : '') +
        ` · ${fmtTime(d.time)}</div>` +
        (done || err
          ? ''
          : `<div class="bar"><div style="width:${pct}%"></div></div>`) +
        `</div>` +
        `<div class="dl-actions">` +
        (done
          ? `<button class="primary" data-open="${d.dlId}">Открыть</button>` +
            `<button data-folder="${d.dlId}">Показать в папке</button>`
          : `<button data-folder="${d.dlId}">Показать в папке</button>`) +
        `</div>`;
      const nameEl = row.querySelector('.dl-name');
      if (done) nameEl.addEventListener('click', () => openDl(d));
      row.querySelector('[data-open]')?.addEventListener('click', () => openDl(d));
      row.querySelector('[data-folder]')?.addEventListener('click', () => {
        if (window.pageAPI && d.path) window.pageAPI.showItemInFolder(d.path);
      });
      list.appendChild(row);
    });
  }

  function openDl(d) {
    if (!d.path) return;
    if (window.pageAPI && window.pageAPI.openFile) window.pageAPI.openFile(d.path);
    else if (window.pageAPI) window.pageAPI.showItemInFolder(d.path);
  }

  async function refresh() {
    if (!window.pageAPI || typeof window.pageAPI.loadDownloads !== 'function') return;
    try {
      cache = (await window.pageAPI.loadDownloads()) || [];
      render();
    } catch (_) {
      /* ignore */
    }
  }

  // пока идёт загрузка — обновляем скорость каждые 1.2с
  let active = false;
  function schedulePoll() {
    const anyActive = cache.some((d) => !d.state || d.state === 'progressing' || d.state === 'interrupted');
    if (anyActive && !active) {
      active = true;
      const t = setInterval(() => {
        refresh().then(() => {
          if (!cache.some((d) => !d.state || d.state === 'progressing' || d.state === 'interrupted')) {
            clearInterval(t);
            active = false;
          }
        });
      }, 1200);
    }
  }

  document.getElementById('open-folder').addEventListener('click', () => {
    if (window.pageAPI) window.pageAPI.openDownloadsFolder();
  });
  document.getElementById('clear').addEventListener('click', async () => {
    if (!window.pageAPI) return;
    if (!cache.length) return;
    if (!confirm('Очистить список загрузок?')) return;
    await window.pageAPI.clearDownloads();
    cache = [];
    render();
  });

  refresh().then(schedulePoll);
})();
