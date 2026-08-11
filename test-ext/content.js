// Тестовое расширение: добавляет метку на страницу
(() => {
  const el = document.createElement('div');
  el.id = 'akiri-test-ext';
  el.textContent = 'EXT OK';
  el.style.cssText =
    'position:fixed;top:8px;left:8px;z-index:2147483646;background:#2b6;color:#fff;' +
    'font:12px system-ui;padding:4px 10px;border-radius:999px;pointer-events:none;';
  document.documentElement.appendChild(el);
})();
