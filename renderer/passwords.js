// Akiri Browser — менеджер паролей.
// Работает через pageAPI (гостевой preload) — доступен только нашим file:// страницам.
(function () {
  'use strict';
  const api = window.pageAPI;
  if (!api) return;

  const $ = (id) => document.getElementById(id);
  let entries = [];
  let filter = '';

  let flashTimer = null;
  function flash(msg) {
    const el = $('flash');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.add('hidden'), 1800);
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function host(u) {
    try {
      return new URL(u).hostname.replace(/^www\./, '') || u;
    } catch (_) {
      return u;
    }
  }
  function hue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  async function refresh() {
    const st = await api.passwordsStatus();
    $('setup').classList.toggle('hidden', st.hasMaster);
    $('unlock').classList.toggle('hidden', !st.hasMaster || st.unlocked);
    $('main').classList.toggle('hidden', !st.unlocked);
    if (st.unlocked) {
      const r = await api.passwordsList();
      if (r && r.ok) {
        entries = r.list || [];
        renderList();
      }
    }
  }

  function renderList() {
    const list = $('list');
    const q = filter.toLowerCase();
    const items = entries.filter((e) => !q || (e.url + ' ' + (e.username || '')).toLowerCase().includes(q));
    if (!items.length) {
      list.innerHTML =
        '<div class="empty">' +
        (entries.length
          ? 'Ничего не найдено'
          : 'Паролей пока нет. Войдите на сайт — браузер сам предложит сохранить пароль.') +
        '</div>';
      return;
    }
    list.innerHTML = items
      .map((e) => {
        const id = entries.indexOf(e);
        const h = host(e.url);
        return (
          `<div class="pw-row" data-id="${id}">` +
          `<span class="pw-avatar" style="background:hsl(${hue(h)},55%,45%)">${esc(h.charAt(0).toUpperCase())}</span>` +
          `<span class="pw-site"><b>${esc(h)}</b><span class="pw-user">${esc(e.username || '—')}</span></span>` +
          `<span class="pw-pass" data-pass="${esc(e.password)}">••••••••</span>` +
          `<span class="pw-actions">` +
          `<button class="pw-btn" data-act="reveal" data-id="${id}" title="Показать пароль">👁</button>` +
          `<button class="pw-btn" data-act="copy-u" data-id="${id}" title="Копировать логин">👤</button>` +
          `<button class="pw-btn" data-act="copy-p" data-id="${id}" title="Копировать пароль">⧉</button>` +
          `<button class="pw-btn danger" data-act="del" data-id="${id}" title="Удалить">🗑</button>` +
          `</span></div>`
        );
      })
      .join('');

    list.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = Number(b.dataset.id);
        const e = entries[id];
        if (!e) return;
        const act = b.dataset.act;
        if (act === 'del') {
          if (confirm('Удалить пароль для ' + host(e.url) + '?')) {
            await api.passwordsDelete(id);
            refresh();
          }
        } else if (act === 'copy-u') {
          try {
            await navigator.clipboard.writeText(e.username || '');
            flash('Логин скопирован');
          } catch (_) {
            flash('Не удалось скопировать');
          }
        } else if (act === 'copy-p') {
          try {
            await navigator.clipboard.writeText(e.password || '');
            flash('Пароль скопирован');
          } catch (_) {
            flash('Не удалось скопировать');
          }
        } else if (act === 'reveal') {
          const passEl = b.closest('.pw-row').querySelector('.pw-pass');
          if (passEl.dataset.open) {
            passEl.textContent = '••••••••';
            passEl.dataset.open = '';
          } else {
            passEl.textContent = e.password;
            passEl.dataset.open = '1';
          }
        }
      });
    });
  }

  function bind() {
    // создание мастер-пароля
    $('setup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const p1 = $('mp1').value;
      const p2 = $('mp2').value;
      if (p1.length < 4) return flash('Мастер-пароль — минимум 4 символа');
      if (p1 !== p2) return flash('Пароли не совпадают');
      const r = await api.passwordsSetMaster('', p1);
      if (r && r.ok) {
        $('mp1').value = '';
        $('mp2').value = '';
        flash('Менеджер паролей включён');
        refresh();
      } else flash('Ошибка: ' + (r && r.error));
    });

    // разблокировка
    $('unlock-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await api.passwordsUnlock($('up').value);
      if (r && r.ok) {
        $('up').value = '';
        flash('Разблокировано');
        refresh();
      } else flash('Неверный мастер-пароль');
    });

    // добавление вручную
    $('btn-add').addEventListener('click', () => {
      $('add-form').classList.toggle('hidden');
    });
    $('add-cancel').addEventListener('click', () => $('add-form').classList.add('hidden'));
    $('add-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = $('add-url').value.trim();
      const username = $('add-user').value.trim();
      const password = $('add-pass').value;
      if (!url || !password) return flash('Заполните сайт и пароль');
      const r = await api.passwordsSave({ url, username, password });
      if (r && r.ok) {
        $('add-url').value = $('add-user').value = $('add-pass').value = '';
        $('add-form').classList.add('hidden');
        flash('Пароль добавлен');
        refresh();
      } else flash('Ошибка: ' + (r && r.error));
    });

    // смена мастер-пароля
    $('btn-change').addEventListener('click', () => $('change-form').classList.toggle('hidden'));
    $('ch-cancel').addEventListener('click', () => $('change-form').classList.add('hidden'));
    $('change-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const oldPw = $('ch-old').value;
      const n1 = $('ch-new1').value;
      const n2 = $('ch-new2').value;
      if (n1.length < 4) return flash('Новый пароль — минимум 4 символа');
      if (n1 !== n2) return flash('Новые пароли не совпадают');
      const r = await api.passwordsSetMaster(oldPw, n1);
      if (r && r.ok) {
        $('ch-old').value = $('ch-new1').value = $('ch-new2').value = '';
        $('change-form').classList.add('hidden');
        flash('Мастер-пароль изменён');
        refresh();
      } else flash('Ошибка: ' + (r && r.error));
    });

    // блокировка и поиск
    $('btn-lock').addEventListener('click', async () => {
      await api.passwordsLock();
      flash('Заблокировано');
      refresh();
    });
    $('search').addEventListener('input', () => {
      filter = $('search').value.trim();
      renderList();
    });
  }

  // если хранилище заблокировали/разблокировали из другого окна — обновляемся
  if (api.onPasswordsChanged) api.onPasswordsChanged(refresh);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  bind();
  refresh();
})();
