# Akiri Browser

Современный браузер для Windows на движке **Chromium** (WebView2):
вкладки, менеджер паролей, загрузки, история, подсказки в адресной
строке и встроенный AI-ассистент. Бесплатно, данные хранятся только
на вашем компьютере.

- Сайт: https://akira-cpu-ui.github.io/akiri-browser/
- Скачать: страница сайта или раздел **Releases** этого репозитория.

## Движок

Браузер переезжает с Electron (Chromium 130) на **WebView2** (настоящий
Chromium 151, движок Edge) — чтобы сайты и вход в аккаунты Google
работали как в настоящем Chrome. Текущее состояние миграции и причину
(отпечатки TLS) см. в [`webview2-host/README.md`](webview2-host/README.md)
и [`webview2-host/GOOGLE-REJECTION-TLS.md`](webview2-host/GOOGLE-REJECTION-TLS.md).

## Структура

```
renderer/        UI браузера (index.html, app.js, styles.css, ntp, настройки…)
main.js          главный процесс Electron-версии
preload.js       мост Electron-версии
webview2-host/   C# хост на WebView2 (настоящий Chromium) + сборка без dotnet SDK
tools/           publish-update.js (публикация версий), verify.js, tls-fingerprint/
docs/            сайт (лендинг + version.json), публикуется GitHub Pages
```

## Сборка

Electron-версия:

```bash
npm install
npm run dist          # установщик в dist/
```

WebView2-хост (без dotnet SDK):

```bash
cd webview2-host
build.bat             # AkiriBrowser.exe
```

## Публикация новой версии

```bash
node tools/publish-update.js 0.18.0 --notes="что нового"
```

Скрипт собирает установщик, заливает в GitHub Release, обновляет
`docs/version.json` и лендинг, пушит — сайт и автообновление
обновляются сами.
