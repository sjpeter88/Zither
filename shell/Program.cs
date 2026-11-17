// Concert Zither — Windows shell.
// A single window hosting the static web app in WebView2. The web files are
// embedded in the .exe, unpacked to %LOCALAPPDATA%\ConcertZither and served
// from a virtual https host, so the page gets a secure context (needed for
// AudioWorklet) without any server.
//
//   ConcertZither.exe             normal start
//   ConcertZither.exe --selftest  start audio, play a chord, write
//                                 %LOCALAPPDATA%\ConcertZither\selftest.json, exit
using System.Reflection;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ConcertZither;

internal static class Program
{
    private const string Host = "concertzither.example";

    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(args.Contains("--selftest")));
    }

    private sealed class MainForm : Form
    {
        private readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(13, 10, 8) };
        private readonly bool _selfTest;
        private readonly string _dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ConcertZither");
        private bool _fullScreen;
        private FormWindowState _restoreState;

        public MainForm(bool selfTest)
        {
            _selfTest = selfTest;
            Text = "Concert Zither";
            BackColor = Color.FromArgb(13, 10, 8);
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(1366, 860);
            MinimumSize = new Size(900, 600);
            try { Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!); } catch { /* keep default */ }
            Controls.Add(_web);
            KeyPreview = true;
            Load += async (_, _) => await StartAsync();
        }

        private void Log(string line)
        {
            try { File.AppendAllText(Path.Combine(_dataDir, "shell.log"), $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {line}{Environment.NewLine}"); } catch { /* logging is best effort */ }
        }

        /// <summary>Keep the log small: once it passes 256 KB only its newest half is kept.</summary>
        private void TrimLog()
        {
            try
            {
                var path = Path.Combine(_dataDir, "shell.log");
                var info = new FileInfo(path);
                if (!info.Exists || info.Length < 256 * 1024) return;
                var lines = File.ReadAllLines(path);
                File.WriteAllLines(path, lines[(lines.Length / 2)..]);
            }
            catch { /* logging is best effort */ }
        }

        private async Task StartAsync()
        {
            try
            {
                Directory.CreateDirectory(_dataDir);
                TrimLog();
                var webDir = ExtractWebApp();
                // Let the page start sound without a click: this is a local instrument, not a web site.
                var options = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(_dataDir, "WebView2"), options);
                await _web.EnsureCoreWebView2Async(env);
                var core = _web.CoreWebView2;
                core.SetVirtualHostNameToFolderMapping(Host, webDir, CoreWebView2HostResourceAccessKind.Deny);
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.Settings.IsSwipeNavigationEnabled = false;
                core.Settings.IsPinchZoomEnabled = false;
#if !DEBUG
                core.Settings.AreDevToolsEnabled = false;
#endif
                // keep everything inside the app: no navigation away, no popups
                core.NavigationStarting += (_, e) => { if (!e.Uri.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase)) e.Cancel = true; };
                core.NewWindowRequested += (_, e) => e.Handled = true;
                core.WebMessageReceived += OnMessage;
                core.ProcessFailed += (_, e) => Log($"WebView2 process failed: {e.ProcessFailedKind}");
                core.ContainsFullScreenElementChanged += (_, _) => SetFullScreen(core.ContainsFullScreenElement);
                Log($"start (WebView2 {env.BrowserVersionString}, selftest={_selfTest})");
                core.Navigate($"https://{Host}/index.html" + (_selfTest ? "?selftest=1" : ""));
                if (_selfTest)
                {
                    // never hang a test run
                    var t = new System.Windows.Forms.Timer { Interval = 60000 };
                    t.Tick += (_, _) => { WriteSelfTest("{\"type\":\"selftest\",\"started\":false,\"error\":\"timeout: the page did not report\"}"); Close(); };
                    t.Start();
                }
            }
            catch (WebView2RuntimeNotFoundException)
            {
                MessageBox.Show(this, "Concert Zither needs the Microsoft Edge WebView2 Runtime, which is not installed on this PC.\n\nIt is a free download from Microsoft: search for \"WebView2 Runtime\".", "Concert Zither", MessageBoxButtons.OK, MessageBoxIcon.Information);
                Close();
            }
            catch (Exception ex)
            {
                Log("startup failed: " + ex);
                if (_selfTest) WriteSelfTest(JsonSerializer.Serialize(new { type = "selftest", started = false, error = ex.Message }));
                else MessageBox.Show(this, "Concert Zither could not start:\n\n" + ex.Message, "Concert Zither", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        /// <summary>Unpack the embedded web app; re-done whenever the .exe changes.</summary>
        private string ExtractWebApp()
        {
            var asm = Assembly.GetExecutingAssembly();
            var stamp = $"{asm.GetName().Version}-{File.GetLastWriteTimeUtc(Environment.ProcessPath!).Ticks}";
            var dir = Path.Combine(_dataDir, "app");
            var stampFile = Path.Combine(dir, ".stamp");
            if (File.Exists(stampFile) && File.ReadAllText(stampFile) == stamp) return dir;
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            Directory.CreateDirectory(dir);
            var root = Path.GetFullPath(dir) + Path.DirectorySeparatorChar;
            foreach (var name in asm.GetManifestResourceNames())
            {
                if (!name.StartsWith("web/", StringComparison.Ordinal)) continue;
                var target = Path.GetFullPath(Path.Combine(dir, name[4..].Replace('\\', '/').Replace('/', Path.DirectorySeparatorChar)));
                if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                using var src = asm.GetManifestResourceStream(name)!;
                using var dst = File.Create(target);
                src.CopyTo(dst);
            }
            File.WriteAllText(stampFile, stamp);
            return dir;
        }

        private void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string json;
            try { json = e.WebMessageAsJson; } catch { return; }
            try
            {
                using var doc = JsonDocument.Parse(json);
                var type = doc.RootElement.TryGetProperty("type", out var t) ? t.GetString() : null;
                if (type == "audio") Log("audio: " + json);
                else if (type == "selftest") { Log("selftest: " + json); WriteSelfTest(json); if (_selfTest) BeginInvoke(Close); }
                else if (type == "save") SaveFile(doc.RootElement);
            }
            catch (JsonException) { /* ignore anything unexpected */ }
        }

        /// <summary>The page asks to save a file (an exported song list or a rendered take): show the Save dialog.</summary>
        private void SaveFile(JsonElement m)
        {
            var name = m.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
            name = string.Concat(Path.GetFileName(name).Split(Path.GetInvalidFileNameChars()));
            if (name.Length == 0) name = "concert-zither-file";
            var ext = Path.GetExtension(name).TrimStart('.').ToLowerInvariant();
            using var dlg = new SaveFileDialog
            {
                FileName = name,
                Filter = (ext == "wav" ? "WAV audio (*.wav)|*.wav|" : ext == "json" ? "Concert Zither songs (*.json)|*.json|" : "") + "All files (*.*)|*.*",
                InitialDirectory = Environment.GetFolderPath(ext == "wav" ? Environment.SpecialFolder.MyMusic : Environment.SpecialFolder.MyDocuments),
                OverwritePrompt = true,
            };
            object reply;
            if (dlg.ShowDialog(this) != DialogResult.OK) reply = new { type = "saved", ok = false };
            else
            {
                try
                {
                    var b64 = m.TryGetProperty("data", out var d) ? d.GetString() ?? "" : "";
                    File.WriteAllBytes(dlg.FileName, Convert.FromBase64String(b64));
                    reply = new { type = "saved", ok = true, path = dlg.FileName };
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or FormatException)
                {
                    reply = new { type = "saved", ok = false, error = ex.Message };
                }
            }
            _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(reply));
        }

        private void WriteSelfTest(string json)
        {
            try { File.WriteAllText(Path.Combine(_dataDir, "selftest.json"), json, new UTF8Encoding(false)); } catch { /* best effort */ }
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.F11) { SetFullScreen(!_fullScreen); e.Handled = true; }
            base.OnKeyDown(e);
        }

        private void SetFullScreen(bool on)
        {
            if (on == _fullScreen) return;
            _fullScreen = on;
            if (on) { _restoreState = WindowState; WindowState = FormWindowState.Normal; FormBorderStyle = FormBorderStyle.None; WindowState = FormWindowState.Maximized; }
            else { FormBorderStyle = FormBorderStyle.Sizable; WindowState = _restoreState; }
        }
    }
}
