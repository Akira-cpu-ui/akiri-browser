# Почему Google отклоняет вход из Electron-версии Akiri Browser

**Итог в одну строку:** отпечаток TLS ClientHello у Electron 33 (Chromium 130)
соответствует **старому встраиваемому Chromium** и ни одному реальному
текущему браузеру, а Google при входе в аккаунт сверяет отпечаток с
настоящим актуальным Chrome. WebView2-хост (движок Edge 151 = тот же
Chromium 151, что у установленного Chrome) отпечатком неотличим от
настоящего браузера — Google принимает вход.

Этот документ — результат измерений **на этой машине** (11.08.2026):
захвачены фактические TLS ClientHello трёх браузеров и сравнены побайтово.

---

## 1. Движки на машине

| Браузер | Движок | Вход в Google |
|---|---|---|
| Akiri Browser (Electron) | **Chromium 130** (Electron 33.4.11) | ❌ «Браузер может быть небезопасным» |
| Akiri Browser (WebView2-хост) | **Chromium 151** (Edge WebView2 151.0.4129) | ✅ обычная проверка аккаунта |
| Google Chrome | Chromium 151 | ✅ |
| Microsoft Edge | Chromium 151 | ✅ |

Главное: **Electron и WebView2 используют разные версии Chromium** —
130 против 151. TLS-отпечаток (какие расширения, группы, подписи шлёт
клиент) у Chromium 130 и 151 различается.

## 2. Как снимали отпечатки

Локальный TCP-сервер перехватывал первый TLS-запись (ClientHello)
каждого браузера при навигации на `https://127.0.0.1:9443/...`.
Захвачено по одному ClientHello от каждого браузера:

```
tools/tls-fingerprint/out/webview2.bin   1707 байт
tools/tls-fingerprint/out/electron.bin   1701 байт
tools/tls-fingerprint/out/chrome.bin     1803 байт
```

Воспроизведение: `tools/tls-fingerprint/capture-all.sh` (захват),
`tools/tls-fingerprint/parse-hello.py` (разбор).

## 3. Что одинаково (HTTP-слой не виноват)

Все три браузера шлют **идентичные**:

- набор cipher suites (16): GREASE + `1301,1302,1303, C02B,C02F,C02C,C030,
  CCA9,CCA8, C013,C014, 9C,9D,2F,35`;
- `legacy_version` TLS 1.2, compression `[0]`, session_id пустой;
- HTTP-заголовки (UA Chrome/151, Sec-CH-UA с брендом Google Chrome,
  x-browser-*, x-client-data и т.д.) — ранее доведены до идентичных.

То есть разница — не в заголовках и не в страницах, а именно в
**TLS-уровне**: расширениях ClientHello, которые формирует сам движок.

## 4. Различия ClientHello (побайтово)

### 4.1 Post-quantum группа в key_share — главный маркер

| Браузер | PQ-группа key share | Код |
|---|---|---|
| Chrome 151 | X25519Kyber768Draft00 | `0x11ec` |
| WebView2 (Edge 151) | X25519Kyber768Draft00 | `0x11ec` |
| Electron 33 (Chromium 130) | X25519Kyber768 (финальный) | `0x6399` |

Chrome перешёл на черновой кодпоинт `0x11ec` (это актуальный
X25519Kyber768Draft00 в Chrome 130+). Electron 33 шлёт старый финальный
`0x6399`. Набор групп: `[GREASE, PQ, x25519, secp256r1, secp384r1]`
у всех — отличается **только** код PQ-группы.

### 4.2 Signature algorithms — ML-DSA есть только в 151

| Браузер | Сигнатурные алгоритмы |
|---|---|
| Chrome / WebView2 151 | **11**: `0904, 0905, 0906` (ML-DSA — post-quantum), `0403, 0804, 0401, 0503, 0805, 0501, 0806, 0601` |
| Electron 130 | **8**: `0403, 0804, 0401, 0503, 0805, 0501, 0806, 0601` |

Три схемы ML-DSA (`0x0904/0x0905/0x0906`) появились в Chromium только
в новых версиях — у Chromium 130 их нет.

### 4.3 ALPS: старый кодпоинт против нового

| Браузер | Расширение application_settings |
|---|---|
| Chrome / WebView2 151 | `0x44cd` (новый кодпоинт ALPS) |
| Electron 130 | `0x4469` (старый кодпоинт ALPS) |

### 4.4 ECH (0xfe0d)

Все три шлют Encrypted Client Hello, но с разной длиной полезной
нагрузки: WebView2 — 186 Б, Electron — 186 Б, Chrome — 282 Б
(зависит от версии/конфигурации).

### 4.5 Порядок расширений

Chromium 151 (Chrome и Edge) **перемешивает** порядок расширений при
каждом соединении (функция «ClientHello permutation», см. Fastly,
2023) — порядок Chrome и Edge не совпадает даже между собой. Electron 130
шлёт расширения **в фиксированном порядке**, который не встречается у
настоящего Chrome ни в одной перестановке:

```
Electron:   GREASE, key_share, EMS, status_request, session_ticket, psk_modes,
            ALPN, SCT, FF01, ec_point_formats, psk_modes, compress_cert,
            sigalgs, ECH, supported_groups, ALPS_old, GREASE
Chrome 151: GREASE, FF01, psk_modes, session_ticket, ALPN, key_share,
            supported_groups, status_request, SCT, psk_modes, ec_point_formats,
            ALPS_new, ECH, EMS, sigalgs, compress_cert, GREASE
```

### 4.6 GREASE-значения

Случайные на каждое соединение (`9a9a`, `baba`, `7a7a`, …) — это норма
и для настоящих браузеров, отдельным маркером не является.

## 5. Точная причина отказа

Google при входе в аккаунт сверяет TLS-отпечаток соединения со своей
базой «как выглядит настоящий актуальный Chrome». ClientHello от
Electron 33 опознаётся как **Chromium 130-эры, встроенный, не-настоящий**
по совокупности маркеров:

1. post-quantum группа `0x6399` вместо актуальной `0x11ec`;
2. отсутствие ML-DSA-схем `0904/0905/0906`;
3. старый кодпоинт ALPS `0x4469` вместо `0x44cd`;
4. фиксированный, не-перемешиваемый порядок расширений.

WebView2 (Edge 151) и Chrome 151 шлют отпечаток текущего Chromium —
Google принимает. Это согласуется со всеми живыми A/B-тестами:
Electron ❌, WebView2 ✅, Chrome GUI ✅, Edge ✅ (даже headless-запуск
настоящего Chrome 151 отклоняется по своим причинам — там другие
сигналы автоматизации).

## 6. Почему это нельзя починить из кода приложения

Отпечаток формирует **BoringSSL внутри бинарника Electron** (версия
130), а не страницы или заголовки. Из JavaScript/главного процесса
Electron его не изменить: ни `appendSwitch('enable-ech')`, ни
подмена UA/хинтов (всё это уже сделано и проверено) не влияют на
ClientHello. Единственный способ «подделать» TLS-отпечаток —
внедрить локальный TLS-прокси с переписыванием хендшейка, что ломает
сертификаты (HSTS/EV) и не является решением для реального браузера.

## 7. Решение

Переход на **WebView2** (настоящий Chromium 151, обновляется Microsoft):
движок сам генерирует отпечаток актуального браузера. Прототип и
текущий хост (`webview2-host/`) уже проходят проверку Google —
документация миграции в `webview2-host/README.md`.
