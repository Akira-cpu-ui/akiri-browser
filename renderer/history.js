// Akiri Browser — страница «История»: поиск, группировка по дням, удаление.
// Работает через pageAPI (гостевой preload) — доступен только нашим file:// страницам.
(function () {
  'use strict';

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const groupsEl = document.getElementById('groups');
  const emptyEl = document.getElementById('empty');
  const searchEl = document.getElementById('search');
  let cache = [];
  let query = '';

  const hostOf = (u) => {
    try { return new URL(u).host.replace(/^www\./, ''); } catch (_) { return ''; }
  };

  const letter = (title, url) => {
    const t = (title || url || '?').trim();
    const h = hostOf(url || '');
    return (h ? h.charAt(0) : t.charAt(0) || '?').toUpperCase();
  };

  function groupLabel(t) {
    const d = new Date(t);
    const now = new Date();
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, now)) return 'Сегодня';
    if (same(d, new Date(now.getTime() - 864e5))) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function timeLabel(t) {
    return new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function render() {
    groupsEl.innerHTML = '';
    const q = query.trim().toLowerCase();
    const items = cache.filter(
      (h) =>
        !q ||
        (h.title || '').toLowerCase().includes(q) ||
        (h.url || '').toLowerCase().includes(q)
    );
    emptyEl.classList.toggle('hidden', items.length > 0);

    if (!items.length && q) {
      groupsEl.innerHTML = '<div class="empty">Ничего не найдено</div>';
      return;
    }

    const groups = new Map();
    items.forEach((h) => {
      const key = groupLabel(h.time);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(h);
    });

    groups.forEach((list, label) => {
      const sec = document.createElement('div');
      sec.className = 'group';
      sec.innerHTML = `<div class="group-title">${esc(label)}</div>`;
      const wrap = document.createElement('div');
      list.forEach((h, i) => {
        const item = document.createElement('div');
        item.className = 'item';
        item.innerHTML =
          `<div class="item-icon">${esc(letter(h.title, h.url))}</div>` +
          `<div class="item-body">` +
          `<div class="item-title">${esc(h.title || h.url)}</div>` +
          `<div class="item-url">${esc(h.url || '')}</div>` +
          `</div>` +
          `<div class="item-time">${timeLabel(h.time)}</div>` +
          `<button class="item-del" title="Удалить из истории">×</button>`;
        // клик по строке — открываем сайт (ссылка переводит этот view на страницу)
        const a = document.createElement('a');
        a.href = h.url;
        a.style.cssText = 'display:contents';
        item.addEventListener('click', () => { location.href = h.url; });
        const del = item.querySelector('.item-del');
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          cache.splice(cache.indexOf(h), 1);
          if (window.pageAPI) window.pageAPI.saveHistory(cache);
          render();
        });
        wrap.appendChild(item);
      });
      sec.appendChild(wrap);
      groupsEl.appendChild(sec);
    });
  }

  async function refresh() {
    if (!window.pageAPI || typeof window.pageAPI.loadHistory !== 'function') return;
    try {
      cache = (await window.pageAPI.loadHistory()) || [];
      render();
    } catch (_) { /* ignore */ }
  }

  searchEl.addEventListener('input', () => { query = searchEl.value; render(); });

  document.getElementById('clear').addEventListener('click', async () => {
    if (!window.pageAPI) return;
    if (!cache.length) return;
    if (!confirm('Очистить всю историю?')) return;
    await window.pageAPI.clearHistory();
    cache = [];
    render();
  });

  refresh();
})();
