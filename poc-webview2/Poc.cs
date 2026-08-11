// Akiri Browser — прототип на WebView2 (настоящий Chromium).
// Доказывает, что движок Edge/WebView2 проходит риск-проверку Google,
// в отличие от Electron (TLS-отпечаток настоящего Chromium).
// URL страницы — из переменной окружения AKIRI_POC_URL.
using System;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

class AkiriPoc
{
    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var form = new Form
        {
            Text = "Akiri Browser — WebView2 POC (real Chromium)",
            Width = 1280,
            Height = 820,
            StartPosition = FormStartPosition.CenterScreen,
        };
        var wv = new WebView2 { Dock = DockStyle.Fill };
        form.Controls.Add(wv);
        var log = Path.Combine(Application.StartupPath, "poc.log");
        Action<string> L = (m) => { try { File.AppendAllText(log, DateTime.Now.ToString("HH:mm:ss") + " " + m + Environment.NewLine); } catch { } };
        form.Shown += async (s, e) =>
        {
            try
            {
                L("shown: start");
                var dataDir = Path.Combine(Application.StartupPath, "wv2data");
                // сначала пробуем штатный поиск рантайма (реестр), потом явную папку
                // (C# 5 не позволяет await внутри catch — поэтому через флаг)
                CoreWebView2Environment env = null;
                Exception envErr = null;
                try
                {
                    L("creating env (registry lookup)");
                    env = await CoreWebView2Environment.CreateAsync(null, dataDir, null);
                }
                catch (Exception ex)
                {
                    envErr = ex;
                }
                if (envErr != null)
                {
                    L("registry lookup failed: " + envErr.Message);
                    var rt = @"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\151.0.4129.72";
                    L("trying explicit runtime folder: " + rt);
                    env = await CoreWebView2Environment.CreateAsync(rt, dataDir, null);
                }
                L("env created");
                await wv.EnsureCoreWebView2Async(env);
                L("core ready");
                var url = Environment.GetEnvironmentVariable("AKIRI_POC_URL");
                if (string.IsNullOrEmpty(url)) url = "https://www.google.com/";
                wv.CoreWebView2.Navigate(url);
                L("navigated to " + url);
                form.Text = "Akiri WebView2 POC — " + url;
            }
            catch (Exception ex)
            {
                L("ERROR: " + ex);
                try { File.WriteAllText(Path.Combine(Application.StartupPath, "poc-err.txt"), ex.ToString()); } catch { }
            }
        };
        Application.Run(form);
    }
}
