// Akiri Browser — хост на WebView2 (этап 1: главное окно + UI + вкладки с навигацией).
// Настоящий Chromium (движок Edge/WebView2) вместо Electron — Google принимает вход,
// совместимость сайтов 100%, движок обновляется Microsoft'ом.
//
// Архитектура (та же, что у Electron-версии):
//   - UI (renderer/index.html + app.js) грузится в WebView2, занимающем всё окно,
//     через виртуальный хост https://akiri.local/ (SetVirtualHostNameToFolderMapping).
//   - Каждая вкладка — отдельный WebView2 (как WebContentsView), позиционируется
//     по прямоугольнику #views, который UI сообщает через browserAPI.setViewRect.
//   - Мост UI <-> хост: window.chrome.webview.postMessage (renderer/webview-bridge.js).
//   - Данные (settings/bookmarks/history/session/downloads.json) — те же файлы
//     в %APPDATA%\Akiri Browser, что у Electron-версии (совместимы 1-в-1).
//
// Сборка без dotnet SDK: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
// (C# 5: без строк-интерполяций, без ?., без await в catch).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AkiriBrowser
{
    // одна вкладка = один WebView2 (слой поверх UI, как WebContentsView в Electron)
    class Tab
    {
        public int Id;
        public WebView2 View;
        public string Url = "";
        public string Title = "Новая вкладка";
        public bool Loading;
        public bool Pinned;
    }

    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                Application.Run(new HostForm());
            }
            catch (Exception ex)
            {
                try { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "host-crash.txt"), ex.ToString()); } catch { }
                throw;
            }
        }
    }

    class HostForm : Form
    {
        const string APP_NAME = "Akiri Browser";
        const string APP_VERSION = "0.18.0-wv2a1"; // этап 1 WebView2
        const string VHOST = "akiri.local";
        const string VHOST_URL = "https://akiri.local/index.html";
        const int DEFAULT_TOP = 88; // стартовый отступ страницы, пока UI не сообщил #views

        // Хоткеи браузера на страницах вкладок: WebView2 не отдаёт Ctrl+T/W/L и т.п.
        // странице как обычные клавиши, поэтому перехватываем их на уровне документа
        // и шлём хосту через window.chrome.webview.postMessage.
        // (AcceleratorKeyPressed недоступен в этой версии SDK — нет доступа к контроллеру.)
        const string ACCEL_JS = "(function () {" +
            "  try {" +
            "    if (window.__akiriAccel) return;" +
            "    window.__akiriAccel = true;" +
            "    document.addEventListener('keydown', function (e) {" +
            "      var k = e.key; var ctrl = e.ctrlKey || e.metaKey; var alt = e.altKey; var shift = e.shiftKey;" +
            "      var action = null; var payload = null;" +
            "      if (ctrl && !alt) {" +
            "        if (k === 't') action = shift ? 'reopen-tab' : 'new-tab';" +
            "        else if (k === 'w') action = 'close-tab';" +
            "        else if (k === 'Tab') action = shift ? 'prev-tab' : 'next-tab';" +
            "        else if (k === 'l' || k === 'L') action = 'focus-address';" +
            "        else if (k === 'd' || k === 'D') action = 'bookmark';" +
            "        else if (k === 'j' || k === 'J') action = 'open-downloads';" +
            "        else if (k === 'h' || k === 'H') action = 'open-history';" +
            "        else if (k === 'A') action = 'tab-search';" +
            "        else if (k === 'Delete') action = 'clear-data';" +
            "        else if (k === '=' || k === '+') action = 'zoom-in';" +
            "        else if (k === '-') action = 'zoom-out';" +
            "        else if (k === '0') action = 'zoom-reset';" +
            "        else if (k >= '1' && k <= '8') { action = 'select-tab'; payload = parseInt(k, 10) - 1; }" +
            "        else if (k === '9') { action = 'select-tab'; payload = 8; }" +
            "      }" +
            "      if (alt && !ctrl && (k === 'ArrowLeft' || k === 'ArrowRight')) action = (k === 'ArrowLeft') ? 'back' : 'forward';" +
            "      if (!action) return;" +
            "      e.preventDefault(); e.stopPropagation();" +
            "      try { window.chrome.webview.postMessage({ __akiriShortcut: action, __akiriPayload: payload }); } catch (err) {}" +
            "    }, true);" +
            "  } catch (err) {}" +
            "})();";

        readonly JavaScriptSerializer _json = new JavaScriptSerializer();
        readonly List<Tab> _tabs = new List<Tab>();
        readonly Timer _saveTimer;

        WebView2 _ui;
        CoreWebView2Environment _env;
        string _dataDir;     // %APPDATA%\Akiri Browser — общие JSON с Electron-версией
        string _rendererDir; // папка renderer/ (виртуальный хост)
        string _logPath;
        string _downloadsDir;
        Dictionary<string, object> _settings;

        Rectangle _viewRect = Rectangle.Empty;
        int _activeId;
        int _nextTabId = 1;
        bool _devtools;
        bool _fullscreen;
        FormWindowState _prevWinState;

        public HostForm()
        {
            Text = APP_NAME;
            ClientSize = new Size(1280, 820);
            MinimumSize = new Size(640, 420);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(26, 27, 31);

            _dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), APP_NAME);
            try { Directory.CreateDirectory(_dataDir); } catch { }
            _downloadsDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
            _rendererDir = ResolveRendererDir();
            _logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "host.log");
            string cdp = Environment.GetEnvironmentVariable("AKIRI_CDP_PORT");
            _devtools = Environment.GetEnvironmentVariable("AKIRI_DEVTOOLS") == "1" || !string.IsNullOrEmpty(cdp);
            Log("start renderer=" + _rendererDir + " data=" + _dataDir);

            _ui = new WebView2();
            _ui.DefaultBackgroundColor = Color.FromArgb(26, 27, 31);
            _ui.Dock = DockStyle.Fill;
            Controls.Add(_ui);
            _ui.BringToFront();

            _saveTimer = new Timer();
            _saveTimer.Interval = 500;
            _saveTimer.Tick += (s, e) => { _saveTimer.Stop(); PersistSession(); };

            Shown += OnShown;
            FormClosing += OnFormClosing;
        }

        // ---------------- инициализация ----------------
        async void OnShown(object sender, EventArgs e)
        {
            try
            {
                _env = await CreateEnvAsync();
                await _ui.EnsureCoreWebView2Async(_env);
                var cwv = _ui.CoreWebView2;
                cwv.Settings.AreDefaultContextMenusEnabled = false;
                cwv.Settings.AreDevToolsEnabled = _devtools;
                cwv.Settings.IsStatusBarEnabled = false;
                cwv.Settings.IsZoomControlEnabled = false;
                cwv.Settings.IsPinchZoomEnabled = false;
                cwv.Settings.AreBrowserAcceleratorKeysEnabled = false; // хоткеи браузера — наши
                cwv.SetVirtualHostNameToFolderMapping(VHOST, _rendererDir, CoreWebView2HostResourceAccessKind.Allow);
                cwv.WebMessageReceived += OnUiMessage;
                cwv.DocumentTitleChanged += (s2, e2) => { try { if (!string.IsNullOrEmpty(cwv.DocumentTitle)) Text = cwv.DocumentTitle; } catch { } };
                _settings = LoadSettings();
                Log("env ready browser=" + cwv.Environment.BrowserVersionString);
                cwv.Navigate(VHOST_URL);
            }
            catch (Exception ex)
            {
                Log("init ERROR: " + ex);
                try { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "host-crash.txt"), ex.ToString()); } catch { }
                MessageBox.Show(this, "Не удалось запустить WebView2: " + ex.Message, APP_NAME, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        async Task<CoreWebView2Environment> CreateEnvAsync()
        {
            string dataFolder = Path.Combine(_dataDir, "WebView2");
            try { Directory.CreateDirectory(dataFolder); } catch { }
            CoreWebView2EnvironmentOptions opts = null;
            string cdp = Environment.GetEnvironmentVariable("AKIRI_CDP_PORT");
            if (!string.IsNullOrEmpty(cdp))
            {
                opts = new CoreWebView2EnvironmentOptions();
                opts.AdditionalBrowserArguments = "--remote-debugging-port=" + cdp.Trim();
            }
            CoreWebView2Environment env = null;
            Exception err = null;
            try
            {
                env = await CoreWebView2Environment.CreateAsync(null, dataFolder, opts);
            }
            catch (Exception ex)
            {
                err = ex;
            }
            if (env == null)
            {
                string rt = FindRuntime();
                Log("registry env failed: " + (err != null ? err.Message : "?") + "; explicit runtime: " + (rt ?? "none"));
                if (rt != null)
                {
                    try
                    {
                        env = await CoreWebView2Environment.CreateAsync(rt, dataFolder, opts);
                    }
                    catch (Exception ex2)
                    {
                        err = ex2;
                    }
                }
                if (env == null)
                {
                    if (err == null) err = new Exception("WebView2 runtime not found");
                    throw err;
                }
            }
            return env;
        }

        string FindRuntime()
        {
            string[] roots =
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "EdgeWebView", "Application"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "EdgeWebView", "Application"),
            };
            string best = null;
            Version bestV = null;
            foreach (string root in roots)
            {
                try
                {
                    if (!Directory.Exists(root)) continue;
                    foreach (string d in Directory.GetDirectories(root))
                    {
                        string name = Path.GetFileName(d);
                        Version v;
                        if (Version.TryParse(name, out v))
                        {
                            if (bestV == null || v > bestV) { bestV = v; best = d; }
                        }
                    }
                }
                catch { }
            }
            return best;
        }

        string ResolveRendererDir()
        {
            string envDir = Environment.GetEnvironmentVariable("AKIRI_WEBROOT");
            if (!string.IsNullOrEmpty(envDir) && Directory.Exists(envDir)) return Path.GetFullPath(envDir);
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string[] candidates =
            {
                Path.GetFullPath(Path.Combine(baseDir, "..", "renderer")),
                Path.GetFullPath(Path.Combine(baseDir, "..", "..", "renderer")),
                Path.GetFullPath(Path.Combine(baseDir, "renderer")),
            };
            foreach (string c in candidates) if (Directory.Exists(c)) return c;
            return baseDir;
        }

        // ---------------- мост UI -> хост ----------------
        async void OnUiMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Dictionary<string, object> msg = null;
            try { msg = _json.DeserializeObject(e.WebMessageAsJson) as Dictionary<string, object>; } catch { }
            if (msg == null) return;
            int id = GetInt(Get(msg, "id"));
            string method = GetStr(Get(msg, "method"));
            object[] args = msg.ContainsKey("args") ? msg["args"] as object[] : null;
            if (args == null) args = new object[0];
            try
            {
                switch (method)
                {
                    // ---- настройки и данные ----
                    case "load-settings": Reply(id, LoadSettings()); break;
                    case "save-settings": SaveSettings(GetDict(Arg(args, 0))); Reply(id, true); break;
                    case "load-bookmarks": Reply(id, ReadFile("bookmarks.json", new object[0])); break;
                    case "save-bookmarks": WriteFile("bookmarks.json", Arg(args, 0)); Reply(id, true); break;
                    case "load-history": Reply(id, ReadFile("history.json", new object[0])); break;
                    case "save-history": WriteFile("history.json", Arg(args, 0)); Reply(id, true); break;
                    case "load-downloads": Reply(id, ReadFile("downloads.json", new object[0])); break;
                    case "load-session": Reply(id, ReadFile("session.json", new object[0])); break;
                    case "save-session": WriteFile("session.json", Arg(args, 0)); Reply(id, true); break;
                    case "app-version": Reply(id, new Dictionary<string, object> { { "version", APP_VERSION }, { "name", APP_NAME } }); break;
                    case "suggest": Reply(id, await SuggestAsync(GetStr(Arg(args, 0)))); break;

                    // ---- вкладки ----
                    case "create-tab": Reply(id, await CreateTabAsync(GetStr(Arg(args, 0)), GetBool(Arg(args, 1)))); break;
                    case "close-tab": CloseTab(GetInt(Arg(args, 0))); Reply(id, true); break;
                    case "set-pinned": SetPinned(GetInt(Arg(args, 0)), GetBool(Arg(args, 1))); Reply(id, true); break;
                    case "activate-tab": ActivateTab(GetInt(Arg(args, 0))); Reply(id, true); break;
                    case "navigate-tab": NavigateTab(GetInt(Arg(args, 0)), GetStr(Arg(args, 1))); Reply(id, true); break;
                    case "reorder-tabs": ReorderTabs(Arg(args, 0)); Reply(id, true); break;
                    case "nav-tab": TabNav(GetInt(Arg(args, 0)), GetStr(Arg(args, 1))); Reply(id, true); break;
                    case "tab-state": Reply(id, TabState(GetInt(Arg(args, 0)))); break;
                    case "zoom-tab": ZoomTab(GetInt(Arg(args, 0)), GetInt(Arg(args, 1))); Reply(id, true); break;
                    case "mute-tab": MuteTab(GetInt(Arg(args, 0)), GetBool(Arg(args, 1))); Reply(id, true); break;
                    case "screenshot-tab": await ScreenshotTabAsync(GetInt(Arg(args, 0))); Reply(id, true); break;

                    // ---- окно ----
                    case "set-view-rect": SetViewRect(GetDict(Arg(args, 0))); Reply(id, true); break;
                    case "toggle-fullscreen": ToggleFullscreen(); Reply(id, true); break;
                    case "clear-browsing-data": await ClearBrowsingDataAsync(); Reply(id, true); break;
                    case "show-tab-menu": ShowTabMenu(GetInt(Arg(args, 0)), GetInt(Arg(args, 1)), GetInt(Arg(args, 2)), GetBool(Arg(args, 3)), GetBool(Arg(args, 4))); Reply(id, true); break;
                    case "copy-text": SetClipboard(GetStr(Arg(args, 0))); Reply(id, true); break;
                    case "show-item-in-folder": ShowInFolder(GetStr(Arg(args, 0))); Reply(id, true); break;
                    case "open-downloads-folder": OpenDownloadsFolder(); Reply(id, true); break;

                    // ---- заглушки следующих этапов ----
                    case "find-tab":
                    case "stop-find-tab":
                    case "print-tab":
                    case "reader-tab":
                    case "dark-tab":
                    case "devtools-tab":
                    case "get-page-text":
                    case "passwords-set-master":
                    case "passwords-unlock":
                    case "passwords-lock":
                    case "passwords-save":
                    case "passwords-delete":
                    case "passwords-offer-clear":
                        Reply(id, true);
                        break;
                    case "passwords-status": Reply(id, new Dictionary<string, object> { { "hasMaster", false }, { "unlocked", false } }); break;
                    case "passwords-list": Reply(id, new object[0]); break;
                    case "passwords-offer": Reply(id, null); break;
                    case "ai-chat": Reply(id, new Dictionary<string, object> { { "error", "AI-ассистент появится в следующем этапе WebView2-версии" } }); break;
                    case "update-check-now":
                    case "update-info":
                        Reply(id, new Dictionary<string, object> { { "enabled", false }, { "current", APP_VERSION }, { "available", false } });
                        break;

                    default:
                        Reply(id, null);
                        break;
                }
            }
            catch (Exception ex)
            {
                Log("msg error " + method + ": " + ex.Message);
                Reply(id, null, ex.Message);
            }
        }

        // ---------------- вкладки ----------------
        async Task<int> CreateTabAsync(string url, bool incognito)
        {
            string target = string.IsNullOrEmpty(url) ? "about:blank" : url;
            var wv = new WebView2();
            wv.DefaultBackgroundColor = Color.FromArgb(26, 27, 31);
            await wv.EnsureCoreWebView2Async(_env);
            var cwv = wv.CoreWebView2;
            cwv.Settings.AreDefaultContextMenusEnabled = false;
            cwv.Settings.AreDevToolsEnabled = _devtools;
            cwv.Settings.IsStatusBarEnabled = false;
            cwv.Settings.IsZoomControlEnabled = false; // зум — только через наши кнопки (Ctrl+=)
            cwv.Settings.IsPinchZoomEnabled = true;
            cwv.Settings.AreBrowserAcceleratorKeysEnabled = true; // F5/Ctrl+R/Ctrl+F внутри страницы
            cwv.SetVirtualHostNameToFolderMapping(VHOST, _rendererDir, CoreWebView2HostResourceAccessKind.Allow);

            var tab = new Tab { Id = _nextTabId++, View = wv, Url = target };
            int tid = tab.Id;

            cwv.NavigationStarting += (s2, e2) =>
            {
                tab.Loading = true;
                EmitTabEvent(tid, new Dictionary<string, object> { { "type", "loading" }, { "loading", true } });
            };
            cwv.NavigationCompleted += (s2, e2) =>
            {
                tab.Loading = false;
                EmitTabEvent(tid, new Dictionary<string, object> { { "type", "loading" }, { "loading", false } });
                if (!e2.IsSuccess)
                {
                    EmitTabEvent(tid, new Dictionary<string, object> { { "type", "fail" }, { "code", (int)e2.WebErrorStatus }, { "desc", e2.WebErrorStatus.ToString() } });
                }
                ScheduleSessionSave();
            };
            cwv.SourceChanged += (s2, e2) =>
            {
                try { tab.Url = cwv.Source; } catch { }
                EmitTabEvent(tid, new Dictionary<string, object> { { "type", "navigate" }, { "url", tab.Url } });
                ScheduleSessionSave();
            };
            cwv.DocumentTitleChanged += (s2, e2) =>
            {
                try { tab.Title = cwv.DocumentTitle; } catch { }
                if (string.IsNullOrEmpty(tab.Title)) tab.Title = "Новая вкладка";
                EmitTabEvent(tid, new Dictionary<string, object> { { "type", "title" }, { "title", tab.Title } });
            };
            cwv.FaviconChanged += (s2, e2) =>
            {
                string uri = "";
                try { uri = cwv.FaviconUri; } catch { }
                if (!string.IsNullOrEmpty(uri))
                    EmitTabEvent(tid, new Dictionary<string, object> { { "type", "favicon" }, { "favicons", new object[] { uri } } });
            };
            cwv.NewWindowRequested += (s2, e2) =>
            {
                e2.Handled = true;
                string u = e2.Uri;
                if (string.IsNullOrEmpty(u)) return;
                if (u.StartsWith("http:") || u.StartsWith("https:") || u.StartsWith("about:"))
                    PostEvent("open-new-tab", new object[] { u });
                else
                {
                    try { Process.Start(u); } catch { }
                }
            };
            cwv.DownloadStarting += (s2, e2) => OnDownloadStarting(e2);
            cwv.ProcessFailed += (s2, e2) =>
            {
                if (e2.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited)
                    EmitTabEvent(tid, new Dictionary<string, object> { { "type", "crashed" } });
            };
            cwv.ContextMenuRequested += (s2, e2) => OnPageContextMenu(tab, e2);
            cwv.ContainsFullScreenElementChanged += (s2, e2) =>
            {
                try { SetAppFullscreen(cwv.ContainsFullScreenElement); } catch { }
            };
            cwv.PermissionRequested += (s2, e2) => OnPermissionRequested(e2);
            cwv.WebMessageReceived += OnTabWebMessage;
            cwv.IsDocumentPlayingAudioChanged += (s2, e2) =>
            {
                bool audible = false;
                try { audible = cwv.IsDocumentPlayingAudio; } catch { }
                EmitTabEvent(tid, new Dictionary<string, object> { { "type", "audio" }, { "audible", audible } });
            };
            // хоткеи браузера на страницах вкладок (AcceleratorKeyPressed недоступен в этом SDK)
            try { Task _s = cwv.AddScriptToExecuteOnDocumentCreatedAsync(ACCEL_JS); } catch { }

            _tabs.Add(tab);
            ScheduleSessionSave(); // новая вкладка сразу попадает в сессию (даже если на NTP)
            Controls.Add(wv);
            wv.Visible = false;
            if (_viewRect != Rectangle.Empty) wv.Bounds = _viewRect;
            else wv.Bounds = new Rectangle(0, DEFAULT_TOP, ClientSize.Width, Math.Max(0, ClientSize.Height - DEFAULT_TOP));
            try { cwv.Navigate(target); } catch { }
            Log("tab created id=" + tid + " url=" + target);
            return tid;
        }

        void CloseTab(int id)
        {
            Tab t = FindTab(id);
            if (t == null) return;
            _tabs.Remove(t);
            try { t.View.Dispose(); } catch { }
            ScheduleSessionSave();
            Log("tab closed id=" + id);
        }

        void SetPinned(int id, bool pinned)
        {
            Tab t = FindTab(id);
            if (t == null) return;
            t.Pinned = pinned;
            ScheduleSessionSave();
        }

        // новый порядок вкладок после перетаскивания — чтобы сессия восстанавливала
        // порядок, который выстроил пользователь (а не порядок создания)
        void ReorderTabs(object ids)
        {
            try
            {
                object[] arr = ids as object[];
                if (arr == null || arr.Length < 2) return;
                var byId = new Dictionary<int, Tab>();
                foreach (Tab t in _tabs) byId[t.Id] = t;
                var reordered = new List<Tab>();
                foreach (object o in arr)
                {
                    int tid = GetInt(o);
                    if (byId.ContainsKey(tid)) { reordered.Add(byId[tid]); byId.Remove(tid); }
                }
                // те, что UI не назвал (не должно быть), приклеиваем в конец
                foreach (Tab t in byId.Values) reordered.Add(t);
                _tabs.Clear();
                _tabs.AddRange(reordered);
                ScheduleSessionSave();
                Log("tabs reordered to " + arr.Length + " entries");
            }
            catch (Exception ex) { Log("reorder error: " + ex.Message); }
        }

        void ActivateTab(int id)
        {
            if (FindTab(id) == null) return;
            _activeId = id;
            Rectangle bounds = _viewRect != Rectangle.Empty
                ? _viewRect
                : new Rectangle(0, DEFAULT_TOP, ClientSize.Width, Math.Max(0, ClientSize.Height - DEFAULT_TOP));
            foreach (Tab t in _tabs)
            {
                bool active = t.Id == id;
                try
                {
                    t.View.Visible = active;
                    if (active)
                    {
                        t.View.Bounds = bounds;
                        t.View.BringToFront();
                        if (t.View.CanFocus) t.View.Focus();
                    }
                }
                catch { }
            }
        }

        void NavigateTab(int id, string url)
        {
            Tab t = FindTab(id);
            if (t == null) return;
            try
            {
                if (string.IsNullOrEmpty(url)) url = "about:blank";
                t.Url = url;
                t.View.CoreWebView2.Navigate(url);
            }
            catch { }
        }

        void TabNav(int id, string action)
        {
            Tab t = FindTab(id);
            if (t == null || t.View.CoreWebView2 == null) return;
            try
            {
                if (action == "back") { t.View.CoreWebView2.GoBack(); Log("nav back id=" + id); }
                else if (action == "forward") { t.View.CoreWebView2.GoForward(); Log("nav forward id=" + id); }
                else if (action == "stop") t.View.CoreWebView2.Stop();
                else { t.View.CoreWebView2.Reload(); Log("nav reload id=" + id); }
            }
            catch (Exception ex) { Log("nav error " + action + " id=" + id + ": " + ex.Message); }
        }

        Dictionary<string, object> TabState(int id)
        {
            Tab t = FindTab(id);
            if (t == null || t.View.CoreWebView2 == null) return null;
            bool back = false, fwd = false;
            try { back = t.View.CoreWebView2.CanGoBack; fwd = t.View.CoreWebView2.CanGoForward; } catch { }
            return new Dictionary<string, object>
            {
                { "url", t.Url },
                { "title", t.Title },
                { "loading", t.Loading },
                { "canGoBack", back },
                { "canGoForward", fwd },
            };
        }

        void ZoomTab(int id, int dir)
        {
            Tab t = FindTab(id);
            if (t == null || t.View.CoreWebView2 == null) return;
            try
            {
                double z = t.View.ZoomFactor;
                if (dir == 0) z = 1.0;
                else z = Math.Round(Math.Max(0.4, Math.Min(2.5, z + (dir > 0 ? 0.1 : -0.1))) * 10.0) / 10.0;
                t.View.ZoomFactor = z;
            }
            catch { }
        }

        void MuteTab(int id, bool muted)
        {
            Tab t = FindTab(id);
            if (t == null || t.View.CoreWebView2 == null) return;
            try { t.View.CoreWebView2.IsMuted = muted; } catch { }
        }

        async Task ScreenshotTabAsync(int id)
        {
            Tab t = FindTab(id);
            if (t == null || t.View.CoreWebView2 == null) return;
            string stamp = DateTime.Now.ToString("yyyy-MM-dd HH-mm-ss");
            string p = Path.Combine(_downloadsDir, "Akiri " + stamp + ".png");
            try
            {
                using (var fs = new FileStream(p, FileMode.Create))
                {
                    await t.View.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
                }
                ShowInFolder(p);
            }
            catch { }
        }

        // ---------------- окно ----------------
        void SetViewRect(Dictionary<string, object> r)
        {
            if (r == null) return;
            int x = GetInt(Get(r, "x"));
            int y = GetInt(Get(r, "y"));
            int w = GetInt(Get(r, "w"));
            int h = GetInt(Get(r, "h"));
            if (w < 40 || h < 40) return;
            _viewRect = new Rectangle(x, y, w, h);
            ActivateTab(_activeId);
        }

        void ToggleFullscreen()
        {
            if (_fullscreen) { SetAppFullscreen(false); return; }
            if (WindowState == FormWindowState.Maximized) WindowState = FormWindowState.Normal;
            else WindowState = FormWindowState.Maximized;
        }

        void SetAppFullscreen(bool fs)
        {
            if (fs && !_fullscreen)
            {
                _prevWinState = WindowState;
                _fullscreen = true;
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Maximized;
            }
            else if (!fs && _fullscreen)
            {
                _fullscreen = false;
                FormBorderStyle = FormBorderStyle.Sizable;
                WindowState = _prevWinState;
            }
        }

        async Task ClearBrowsingDataAsync()
        {
            try
            {
                if (_ui.CoreWebView2 != null)
                    await _ui.CoreWebView2.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.AllProfile);
            }
            catch { }
            PostEvent("browsing-data-cleared", new object[0]);
        }

        // ---------------- контекстное меню вкладки (из UI) ----------------
        void ShowTabMenu(int id, int x, int y, bool pinned, bool muted)
        {
            Tab t = FindTab(id);
            if (t == null) return;
            var menu = new ContextMenuStrip();
            menu.ShowImageMargin = false;
            Action<string> act = (a) => PostAction("tab-menu-action", new Dictionary<string, object> { { "id", id }, { "action", a } });
            AddItem(menu, "Дублировать вкладку", () => act("duplicate"));
            AddItem(menu, pinned ? "Открепить вкладку" : "Закрепить вкладку", () => act("pin"));
            AddItem(menu, "Обновить", () => act("reload"));
            AddItem(menu, "Копировать адрес", () => act("copy"));
            AddItem(menu, muted ? "Включить звук" : "Отключить звук", () => act("mute"));
            menu.Items.Add(new ToolStripSeparator());
            AddItem(menu, "Закрыть вкладку", () => act("close"));
            AddItem(menu, "Закрыть другие вкладки", () => act("close-others"));
            AddItem(menu, "Закрыть вкладки справа", () => act("close-right"));
            try { menu.Show(this, new Point(x, y)); } catch { }
        }

        // ---------------- контекстное меню страницы ----------------
        void OnPageContextMenu(Tab tab, CoreWebView2ContextMenuRequestedEventArgs e)
        {
            var tgt = e.ContextMenuTarget;
            var menu = new ContextMenuStrip();
            menu.ShowImageMargin = false;
            AddItem(menu, "Назад", () => TabNav(tab.Id, "back"));
            AddItem(menu, "Вперёд", () => TabNav(tab.Id, "forward"));
            AddItem(menu, "Перезагрузить", () => TabNav(tab.Id, "reload"));
            bool hasSel = false;
            string sel = "";
            try { hasSel = tgt.HasSelection; sel = tgt.SelectionText; } catch { }
            bool hasLink = false;
            string link = "";
            try { hasLink = tgt.HasLinkUri; link = tgt.LinkUri; } catch { }
            if (hasSel && !string.IsNullOrEmpty(sel))
            {
                menu.Items.Add(new ToolStripSeparator());
                string copy = sel.Replace("\r", " ").Replace("\n", " ").Trim();
                AddItem(menu, "Копировать", () => SetClipboard(copy));
                string q = copy.Length > 40 ? copy.Substring(0, 40) + "…" : copy;
                AddItem(menu, "Поиск: «" + q + "» в Google", () =>
                    PostEvent("open-new-tab", new object[] { "https://www.google.com/search?q=" + Uri.EscapeDataString(copy) }));
            }
            if (hasLink && !string.IsNullOrEmpty(link))
            {
                menu.Items.Add(new ToolStripSeparator());
                AddItem(menu, "Открыть ссылку в новой вкладке", () => PostEvent("open-new-tab", new object[] { link }));
                AddItem(menu, "Копировать адрес ссылки", () => SetClipboard(link));
            }
            menu.Items.Add(new ToolStripSeparator());
            AddItem(menu, "Настройки Akiri…", () => PostAction("open-settings", null));
            AddItem(menu, "О браузере", () => PostAction("open-about", null));
            Point p;
            try { p = e.Location; } catch { p = new Point(8, 8); }
            Point screen = PointToScreen(new Point(tab.View.Left + p.X, tab.View.Top + p.Y));
            try { menu.Show(screen); } catch { }
        }

        void AddItem(ContextMenuStrip menu, string label, Action click)
        {
            var it = new ToolStripMenuItem(label);
            it.Click += (s, e) => { try { click(); } catch { } };
            menu.Items.Add(it);
        }

        // ---------------- загрузки (в Downloads, с прогрессом в UI) ----------------
        void OnDownloadStarting(CoreWebView2DownloadStartingEventArgs e)
        {
            var dl = e.DownloadOperation;
            string fname = "";
            try { fname = Path.GetFileName(e.ResultFilePath); } catch { }
            if (string.IsNullOrEmpty(fname)) fname = "download";
            fname = Sanitize(fname);
            string path = Path.Combine(_downloadsDir, fname);
            string uri = "";
            try { uri = dl.Uri; } catch { }
            e.ResultFilePath = path;
            e.Handled = true;
            int dlId = uri.GetHashCode();
            long lastBytes = 0;
            DateTime lastTime = DateTime.UtcNow;
            double smooth = 0;
            Action snapshot = () =>
            {
                long recv = 0, total = 0;
                CoreWebView2DownloadState state = CoreWebView2DownloadState.InProgress;
                try { recv = dl.BytesReceived; if (dl.TotalBytesToReceive.HasValue) total = (long)dl.TotalBytesToReceive.Value; state = dl.State; } catch { }
                DateTime now = DateTime.UtcNow;
                double speed = 0;
                if (state == CoreWebView2DownloadState.InProgress)
                {
                    double dt = (now - lastTime).TotalSeconds;
                    if (dt > 0.05)
                    {
                        double inst = Math.Max(0, (recv - lastBytes) / dt);
                        smooth = smooth > 0 ? smooth * 0.7 + inst * 0.3 : inst;
                        speed = smooth;
                        lastBytes = recv;
                        lastTime = now;
                    }
                }
                else
                {
                    speed = smooth;
                }
                string st = "progressing";
                if (state == CoreWebView2DownloadState.Completed) st = "completed";
                else if (state == CoreWebView2DownloadState.Interrupted) st = "interrupted";
                long nowMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                var d = new Dictionary<string, object>
                {
                    { "type", "download" },
                    { "dlId", dlId },
                    { "url", uri },
                    { "filename", fname },
                    { "state", st },
                    { "received", recv },
                    { "total", total },
                    { "speed", (long)speed },
                    { "path", path },
                    { "time", nowMs },
                };
                foreach (Tab t in _tabs) EmitTabEvent(t.Id, d);
                PersistDownload(d);
            };
            try
            {
                dl.BytesReceivedChanged += (s2, e2) => snapshot();
                dl.StateChanged += (s2, e2) => snapshot();
            }
            catch { }
            snapshot();
            Log("download start: " + fname + " -> " + path);
        }

        void PersistDownload(Dictionary<string, object> d)
        {
            try
            {
                object[] list = ReadFile("downloads.json", new object[0]) as object[];
                if (list == null) list = new object[0];
                var items = new List<object>(list);
                long dlId = GetInt(Get(d, "dlId"));
                int idx = -1;
                for (int i = 0; i < items.Count; i++)
                {
                    Dictionary<string, object> it = items[i] as Dictionary<string, object>;
                    if (it != null && GetInt(Get(it, "dlId")) == dlId) { idx = i; break; }
                }
                if (idx >= 0) items[idx] = d;
                else items.Insert(0, d);
                if (items.Count > 100) items.RemoveRange(100, items.Count - 100);
                WriteFile("downloads.json", items);
            }
            catch { }
        }

        // ---------------- подсказки поиска ----------------
        Task<object[]> SuggestAsync(string q)
        {
            return Task.Factory.StartNew<object[]>(() => SuggestSync(q));
        }

        object[] SuggestSync(string q)
        {
            if (string.IsNullOrWhiteSpace(q)) return new object[0];
            try
            {
                string url = "https://suggestqueries.google.com/complete/search?client=chrome&hl=ru&q=" + Uri.EscapeDataString(q.Trim());
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 5000;
                req.UserAgent = "Mozilla/5.0";
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    string text = sr.ReadToEnd();
                    object[] arr = _json.DeserializeObject(text) as object[];
                    if (arr != null && arr.Length > 1)
                    {
                        object[] sugg = arr[1] as object[];
                        if (sugg != null) return sugg;
                    }
                }
            }
            catch { }
            return new object[0];
        }

        // ---------------- настройки (те же файлы, что у Electron-версии) ----------------
        Dictionary<string, object> DefaultSettings()
        {
            var ai = new Dictionary<string, object>
            {
                { "baseUrl", "https://opencode.ai/zen/v1" },
                { "model", "mimo-v2.5-free" },
                { "apiKey", "" },
            };
            return new Dictionary<string, object>
            {
                { "homeUrl", "https://www.google.com/" },
                { "searchEngine", "google" },
                { "accent", "#5b8cff" },
                { "startPage", "ntp" },
                { "newTabPage", "ntp" },
                { "wallpaper", "network" },
                { "suggestions", true },
                { "saveHistory", true },
                { "restoreSession", true },
                { "autoUpdate", true },
                { "aiEnabled", true },
                { "autofillPasswords", true },
                { "popupWindows", true },
                { "downloadDir", "" },
                { "zoom", 1 },
                { "sidePanel", true },
                { "updateUrl", "" },
                { "chromeDeviceId", "" },
                { "ai", ai },
            };
        }

        Dictionary<string, object> LoadSettings()
        {
            Dictionary<string, object> s = ReadFile("settings.json", new Dictionary<string, object>()) as Dictionary<string, object>;
            if (s == null) s = new Dictionary<string, object>();
            var merged = new Dictionary<string, object>(DefaultSettings());
            foreach (KeyValuePair<string, object> kv in s)
            {
                if (kv.Key == "ai" && kv.Value is Dictionary<string, object>)
                {
                    var ai = merged["ai"] as Dictionary<string, object>;
                    foreach (KeyValuePair<string, object> a in (Dictionary<string, object>)kv.Value) ai[a.Key] = a.Value;
                }
                else
                {
                    merged[kv.Key] = kv.Value;
                }
            }
            _settings = merged;
            return merged;
        }

        void SaveSettings(Dictionary<string, object> s)
        {
            if (s == null) return;
            Dictionary<string, object> cur = _settings;
            foreach (KeyValuePair<string, object> kv in s) cur[kv.Key] = kv.Value;
            WriteFile("settings.json", cur);
            PostEvent("settings-changed", new object[0]);
        }

        // ---------------- сессия ----------------
        void ScheduleSessionSave()
        {
            _saveTimer.Stop();
            _saveTimer.Start();
        }

        void PersistSession()
        {
            try
            {
                var urls = new List<object>();
                foreach (Tab t in _tabs)
                {
                    string u = t.Url;
                    if (string.IsNullOrEmpty(u) || u == "about:blank") continue;
                    if (u.StartsWith("https://" + VHOST + "/ntp.html")) continue; // стартовая
                    if (u.StartsWith("file:")) continue;
                    if (t.Pinned) urls.Add(new Dictionary<string, object> { { "url", u }, { "pinned", true } });
                    else urls.Add(u);
                }
                WriteFile("session.json", urls);
            }
            catch { }
        }

        // ---------------- файлы данных ----------------
        object ReadFile(string name, object fallback)
        {
            try
            {
                string p = Path.Combine(_dataDir, name);
                if (File.Exists(p)) return _json.DeserializeObject(File.ReadAllText(p));
            }
            catch { }
            return fallback;
        }

        void WriteFile(string name, object data)
        {
            try
            {
                File.WriteAllText(Path.Combine(_dataDir, name), _json.Serialize(data));
            }
            catch { }
        }

        // ---------------- системные мелочи ----------------
        string GetDownloadsDir()
        {
            string d = GetStr(Get(_settings, "downloadDir"));
            if (!string.IsNullOrEmpty(d) && Directory.Exists(d)) return d;
            return _downloadsDir;
        }

        static string Sanitize(string name)
        {
            var bad = Path.GetInvalidFileNameChars();
            var sb = new StringBuilder(name.Length);
            foreach (char c in name) sb.Append(Array.IndexOf(bad, c) >= 0 ? '_' : c);
            return sb.ToString();
        }

        void SetClipboard(string text)
        {
            try
            {
                if (!string.IsNullOrEmpty(text)) Clipboard.SetText(text);
            }
            catch { }
        }

        void ShowInFolder(string p)
        {
            try
            {
                if (string.IsNullOrEmpty(p) || !File.Exists(p)) return;
                Process.Start("explorer.exe", "/select,\"" + p + "\"");
            }
            catch { }
        }

        void OpenDownloadsFolder()
        {
            try { Process.Start("explorer.exe", "\"" + GetDownloadsDir() + "\""); } catch { }
        }

        // ---------------- хоткеи: сообщения от страниц вкладок и от UI-моста ----------------
        void OnTabWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                string json = e.WebMessageAsJson;
                if (string.IsNullOrEmpty(json) || json.IndexOf("__akiriShortcut", StringComparison.Ordinal) < 0) return;
                var msg = _json.DeserializeObject(json) as Dictionary<string, object>;
                if (msg == null) return;
                string action = GetStr(Get(msg, "__akiriShortcut"));
                if (string.IsNullOrEmpty(action)) return;
                object payload = Get(msg, "__akiriPayload");
                PostAction(action, payload);
            }
            catch { }
        }

        void OnPermissionRequested(CoreWebView2PermissionRequestedEventArgs e)
        {
            try
            {
                var kind = e.PermissionKind;
                if (kind == CoreWebView2PermissionKind.Microphone ||
                    kind == CoreWebView2PermissionKind.Camera ||
                    kind == CoreWebView2PermissionKind.Geolocation ||
                    kind == CoreWebView2PermissionKind.Notifications ||
                    kind == CoreWebView2PermissionKind.ClipboardRead)
                {
                    e.State = CoreWebView2PermissionState.Allow;
                }
            }
            catch { }
        }

        // ---------------- события в UI ----------------
        void Reply(int id, object result, string error)
        {
            var d = new Dictionary<string, object>();
            if (error != null)
            {
                d["id"] = id;
                d["error"] = error;
            }
            else
            {
                d["id"] = id;
                d["result"] = result;
            }
            PostRaw(d);
        }

        void Reply(int id, object result) { Reply(id, result, null); }

        void PostAction(string action, object payload)
        {
            PostEvent("menu-action", new object[] { action, payload });
        }

        void PostEvent(string name, object[] args)
        {
            var d = new Dictionary<string, object> { { "type", "event" }, { "name", name }, { "args", args } };
            PostRaw(d);
        }

        void EmitTabEvent(int id, Dictionary<string, object> evt)
        {
            evt["id"] = id;
            PostEvent("tab-event", new object[] { evt });
        }

        void PostRaw(Dictionary<string, object> d)
        {
            try { _ui.CoreWebView2.PostWebMessageAsJson(_json.Serialize(d)); } catch { }
        }

        // ---------------- helpers ----------------
        Tab FindTab(int id)
        {
            foreach (Tab t in _tabs) if (t.Id == id) return t;
            return null;
        }

        static object Arg(object[] args, int i) { return args != null && i < args.Length ? args[i] : null; }

        static object Get(Dictionary<string, object> d, string key)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v)) return v;
            return null;
        }

        static string GetStr(object o)
        {
            if (o == null) return "";
            if (o is string) return (string)o;
            return Convert.ToString(o, System.Globalization.CultureInfo.InvariantCulture);
        }

        static int GetInt(object o)
        {
            if (o == null) return 0;
            if (o is int) return (int)o;
            if (o is long) return (int)(long)o;
            if (o is double) return (int)Math.Round((double)o);
            if (o is bool) return (bool)o ? 1 : 0;
            int r;
            if (int.TryParse(Convert.ToString(o), out r)) return r;
            return 0;
        }

        static bool GetBool(object o)
        {
            if (o == null) return false;
            if (o is bool) return (bool)o;
            if (o is long) return (long)o != 0;
            if (o is double) return (double)o != 0;
            if (o is int) return (int)o != 0;
            string s = Convert.ToString(o);
            return s == "true" || s == "1";
        }

        static Dictionary<string, object> GetDict(object o)
        {
            return o as Dictionary<string, object>;
        }

        void Log(string m)
        {
            try { File.AppendAllText(_logPath, DateTime.Now.ToString("HH:mm:ss") + " " + m + Environment.NewLine); } catch { }
        }

        void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            try { PersistSession(); } catch { }
        }
    }
}
