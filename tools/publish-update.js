#!/usr/bin/env node
// Публикация новой версии Akiri Browser одной командой:
//   node tools/publish-update.js 0.18.0 --notes="что нового"
//
// Делает:
//   1. собирает установщик (npm run dist) — или берёт готовый из dist/;
//   2. создаёт GitHub Release v<версия> и заливает туда установщик;
//   3. обновляет docs/version.json (url → Release) и docs/index.html (fallback);
//   4. коммитит и пушит — GitHub Pages обновляются сами.
//
// GitHub: токен из env GH_TOKEN (или из хранилища git-credentials).
// Репозиторий: env GITHUB_REPO или по умолчанию Akira-cpu-ui/akiri-browser.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const version = process.argv[2];
if (!version) {
  console.error('Укажите версию: node tools/publish-update.js 0.18.0 --notes="..."');
  process.exit(1);
}
const repo = process.env.GITHUB_REPO || 'Akira-cpu-ui/akiri-browser';
const tag = 'v' + version;
const fileName = `akiri-browser-setup-${version}.exe`;

const notesArg = (process.argv.find((a) => a.startsWith('--notes=')) || '').slice(8);
let notes = notesArg || '';
if (!notes && fs.existsSync(path.join(root, 'notes.md'))) {
  notes = fs.readFileSync(path.join(root, 'notes.md'), 'utf8').trim();
}

// ---------- токен ----------
function getToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const r = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
  const m = (r.stdout || '').match(/^password=(.+)$/m);
  return m ? m[1].trim() : '';
}

async function api(method, url, body, token, extraHeaders) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'token ' + token, 'User-Agent': 'akiri-publish', ...(extraHeaders || {}) },
    body,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${method} ${url} -> ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

(async () => {
  const token = getToken();
  if (!token) {
    console.error('Нет токена GitHub. Задайте GH_TOKEN или сохраните токен в git-credentials.');
    process.exit(1);
  }

  // ---------- 1. установщик ----------
  const installer = path.join(root, 'dist', `Akiri Browser Setup ${version}.exe`);
  if (!fs.existsSync(installer)) {
    console.log('Установщик не найден — собираю (npm run dist)…');
    execSync('npm run dist', { cwd: root, stdio: 'inherit' });
  }
  if (!fs.existsSync(installer)) {
    console.error('Не найден установщик:', installer);
    process.exit(1);
  }
  const sizeMB = (fs.statSync(installer).size / 1048576).toFixed(1);
  console.log(`Установщик: ${sizeMB} МБ`);

  // ---------- 2. GitHub Release ----------
  console.log(`Релиз ${tag} в ${repo}…`);
  let releaseId;
  try {
    const rel = await api('POST', `https://api.github.com/repos/${repo}/releases`, JSON.stringify({
      tag_name: tag, name: 'Akiri Browser ' + version, body: notes || 'Новая версия.', draft: false, prerelease: false,
    }), token, { 'Content-Type': 'application/json' });
    releaseId = rel.id;
  } catch (e) {
    if (String(e.message).includes('already_exists')) {
      const rels = await api('GET', `https://api.github.com/repos/${repo}/releases/tags/${tag}`, null, token);
      releaseId = rels.id;
      console.log('Релиз уже существует — обновляю ассет.');
    } else {
      throw e;
    }
  }

  const rel = await api('GET', `https://api.github.com/repos/${repo}/releases/${releaseId}`, null, token);
  let uploadUrl = rel.upload_url.replace(/\{[^}]*\}/, '');
  // если ассет уже есть — удаляем перед заливкой
  const existing = rel.assets.find((a) => a.name === fileName);
  if (existing) await api('DELETE', `https://api.github.com/repos/${repo}/releases/assets/${existing.id}`, null, token);

  console.log('Заливаю установщик в Release…');
  const up = await fetch(uploadUrl + '?name=' + encodeURIComponent(fileName), {
    method: 'POST',
    headers: { Authorization: 'token ' + token, 'Content-Type': 'application/octet-stream', 'User-Agent': 'akiri-publish' },
    body: fs.createReadStream(installer),
    duplex: 'half',
  });
  if (!up.ok) throw new Error('upload -> ' + up.status + ': ' + (await up.text()).slice(0, 300));

  // ---------- 3. docs/version.json + docs/index.html ----------
  const releaseUrl = `https://github.com/${repo}/releases/download/${tag}/${fileName}`;
  const feedPath = path.join(root, 'docs', 'version.json');
  fs.writeFileSync(feedPath, JSON.stringify({ version, url: releaseUrl, notes }, null, 2));

  const indexHtml = path.join(root, 'docs', 'index.html');
  let html = fs.readFileSync(indexHtml, 'utf8');
  const safe = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
  html = html
    .replace(/version: '[^']*'/, `version: '${version}'`)
    .replace(/url: 'https:\/\/github\.com\/[^']*'/, `url: '${releaseUrl}'`)
    .replace(/notes: '[^']*'/, `notes: '${safe(notes)}'`);
  fs.writeFileSync(indexHtml, html);
  console.log('docs/version.json и лендинг обновлены.');

  // ---------- 4. commit + push ----------
  console.log('Коммит и push…');
  execSync('git add docs/version.json docs/index.html docs/README.md', { cwd: root, stdio: 'inherit' });
  execSync(`git commit -m "v${version}: релиз и обновление сайта"`, { cwd: root, stdio: 'inherit' });
  execSync(`git push https://x-access-token:${token}@github.com/${repo}.git main`, { cwd: root, stdio: 'inherit' });

  console.log('');
  console.log('Готово:');
  console.log('  Release:   https://github.com/' + repo + '/releases/tag/' + tag);
  console.log('  Установщик: ' + releaseUrl);
  console.log('  Файл версий: https://' + repo.split('/')[0].toLowerCase() + '.github.io/' + repo.split('/')[1] + '/version.json');
  console.log('GitHub Pages обновится за 1–2 минуты — браузеры у пользователей найдут обновление сами.');
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
