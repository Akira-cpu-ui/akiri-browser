// Akiri Browser — стартовая страница: плитки закладок, поиск выбранной системой
// и ИИ-ответ прямо на странице (запрос начинается с «ai:» или по кнопке ✨).
// Работает через pageAPI (гостевой preload) — доступен только нашим file:// страницам.
(function () {
  'use strict';

  const esc = (s) =>
    String(s).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const letter = (title) => {
    const t = (title || '?').trim();
    return t ? t.charAt(0).toUpperCase() : '?';
  };

  const hueFor = (text) => {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
    return h;
  };

  const short = (title) => (title.length > 24 ? title.slice(0, 24) + '…' : title);

  const ENGINES = {
    google: { action: 'https://www.google.com/search', ph: 'Search with Google or ask Akiri AI…' },
    yandex: { action: 'https://yandex.ru/search/', ph: 'Искать в Яндексе или спросить Akiri AI…' },
    duckduckgo: { action: 'https://duckduckgo.com/', ph: 'Искать в DuckDuckGo или спросить Akiri AI…' },
  };

  async function renderBookmarks() {
    if (!window.pageAPI || typeof window.pageAPI.loadBookmarks !== 'function') return;
    let bookmarks = [];
    try {
      bookmarks = (await window.pageAPI.loadBookmarks()) || [];
    } catch (_) {
      return;
    }
    const section = document.getElementById('bookmarks-section');
    const grid = document.getElementById('bookmarks');
    if (!section || !grid) return;

    if (bookmarks.length) {
      grid.innerHTML = bookmarks
        .slice(0, 24)
        .map((b) => {
          const title = b.title || b.url;
          const color = `hsl(${hueFor(title)}, 55%, 45%)`;
          return (
            `<a class="tile" href="${esc(b.url)}" title="${esc(title)}">` +
            `<span class="tile-icon" style="background:linear-gradient(145deg, hsl(${hueFor(title)},55%,52%), hsl(${hueFor(title)},55%,38%))">${esc(letter(title))}</span>` +
            `<span class="tile-name">${esc(short(title))}</span>` +
            `</a>`
          );
        })
        .join('');
      section.classList.remove('hidden');
    }
  }

  async function applySettings() {
    const form = document.getElementById('search');
    const input = form.querySelector('input[name="q"]');
    if (!form || !input) return;
    let engine = 'google';
    let accent = '#5b8cff';
    let wallpaper = 'network';
    let aiEnabled = true;
    try {
      const s = (await window.pageAPI.loadSettings()) || {};
      engine = s.searchEngine || 'google';
      accent = s.accent || '#5b8cff';
      wallpaper = s.wallpaper || 'network';
      aiEnabled = s.aiEnabled !== false;
    } catch (_) {
      /* ignore */
    }
    const cfg = ENGINES[engine] || ENGINES.google;
    form.action = cfg.action;
    input.placeholder = cfg.ph;
    document.documentElement.style.setProperty('--accent', accent);
    document.body.className = 'wp-' + wallpaper;
    // AI выключен → убираем кнопку ✨ и «ai:» превращается в обычный поиск
    const aiBtn = document.getElementById('ai-btn');
    if (aiBtn) aiBtn.classList.toggle('hidden', aiEnabled === false);
    window.__aiEnabled = aiEnabled;
  }

  // ---------- ИИ-ответ прямо на странице ----------
  const answerBox = document.getElementById('ai-answer');
  const aiBody = document.getElementById('ai-body');

  function showAi(kind, text) {
    answerBox.classList.remove('hidden');
    aiBody.className = 'ai-body' + (kind ? ' ' + kind : '');
    aiBody.textContent = text;
    answerBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function askAi(raw) {
    const q = String(raw || '').trim();
    if (!q) return;
    if (!window.pageAPI || typeof window.pageAPI.aiChat !== 'function') {
      showAi('error', 'AI-ассистент недоступен на этой странице.');
      return;
    }
    showAi('typing', '…');
    try {
      const res = await window.pageAPI.aiChat([{ role: 'user', content: q }]);
      if (res && res.error) {
        showAi('error', res.error === 'no-key'
          ? 'Ключ API не настроен — откройте Настройки и вставьте ключ OpenCode Zen.'
          : 'Ошибка: ' + res.error);
      } else {
        showAi('', (res && res.text) || 'Нет ответа');
      }
    } catch (err) {
      showAi('error', 'Ошибка: ' + String((err && err.message) || err));
    }
  }

  function bindAi() {
    const form = document.getElementById('search');
    const input = form.querySelector('input[name="q"]');
    const aiBtn = document.getElementById('ai-btn');
    const aiClose = document.getElementById('ai-close');

    form.addEventListener('submit', (e) => {
      const q = input.value.trim();
      // «ai: вопрос» или «@ai вопрос» → ИИ (если включён), остальное → поиск
      const m = window.__aiEnabled === false ? null : q.match(/^(ai[:\s]|@ai\s)(.+)$/i);
      if (m) {
        e.preventDefault();
        askAi(m[2]);
        input.value = '';
      }
    });

    aiBtn.addEventListener('click', () => {
      if (window.__aiEnabled === false) return;
      const q = input.value.trim();
      const looksLikeUrl = /^[\w-]+(\.[\w-]+)+([\/?#].*)?$/.test(q) || /^\d{1,3}(\.\d{1,3}){3}/.test(q) || /^https?:\/\//i.test(q);
      if (q && !looksLikeUrl) {
        askAi(q);
        input.value = '';
      } else {
        input.focus();
        input.placeholder = 'Начните с «ai:» — например: ai: напиши стих про браузер';
        setTimeout(() => {
          const s = (window.__engineCfg && window.__engineCfg.ph) || 'Search with Google or ask Akiri AI…';
          input.placeholder = s;
        }, 2600);
      }
    });

    aiClose.addEventListener('click', () => {
      answerBox.classList.add('hidden');
    });
  }

  // версия в подвале (для тех, у кого установлен браузер)
  const foot = document.querySelector('.foot');
  if (foot && window.pageAPI && typeof window.pageAPI.appInfo === 'function') {
    window.pageAPI.appInfo().then((a) => {
      if (a && a.version) foot.textContent = 'Akiri Browser v' + a.version + ' — вкладки, пароли и ИИ в одном браузере';
    }).catch(() => {});
  }

  if (window.pageAPI && typeof window.pageAPI.onSettingsChanged === 'function') {
    window.pageAPI.onSettingsChanged(applySettings);
  }

  renderBookmarks();
  applySettings().then(() => {
    window.__engineCfg = null;
  });
  bindAi();
})();
