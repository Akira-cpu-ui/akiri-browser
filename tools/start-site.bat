@echo off
REM Akiri Browser — публичный сайт (update-site) через бесплатный туннель Cloudflare.
REM Запусти этот файл — он поднимет сайт и покажет реальный публичный адрес
REM вида https://слово-слово-слово.trycloudflare.com (люди смогут открыть его из интернета).
REM ВАЖНО: адрес меняется при каждом запуске, и сайт живёт, пока окно открыто.
REM Для постоянного адреса (навсегда) — Netlify Drop: https://app.netlify.com/drop
REM (перетащи туда папку update-site, получишь https://akiribrowser.netlify.app).
cd /d "%~dp0.."
REM статический сервер для папки сайта (порт 8080)
start "Akiri Site HTTP" /min cmd /c "cd /d "%~dp0..\update-site" && python -m http.server 8080 --bind 127.0.0.1"
timeout /t 2 /nobreak > nul
REM публичный туннель — адрес появится в выводе
echo Ожидание публичного адреса...
tools\bin\cloudflared.exe tunnel --url http://127.0.0.1:8080
