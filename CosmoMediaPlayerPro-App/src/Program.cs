using System;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CosmoPlayer
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.ThreadException += (s, e) => Log.Write("thread exception: " + e.Exception);
            AppDomain.CurrentDomain.UnhandledException += (s, e) => Log.Write("unhandled: " + e.ExceptionObject);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            // --host: stand in for Wallpaper Engine. Opens a plain window and starts a second
            // copy of this program inside it, the same way Wallpaper Engine does.
            if ((Environment.CommandLine ?? "").IndexOf("--host", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                var host = new Form { Text = "CosmoHost", ClientSize = new Size(1280, 720), BackColor = Color.DimGray, StartPosition = FormStartPosition.Manual, Location = new Point(60, 60) };
                bool raw = Environment.CommandLine.IndexOf("--host-raw", StringComparison.OrdinalIgnoreCase) >= 0;
                host.Shown += (s, e) =>
                {
                    if (raw)
                    {
                        // Exactly like Wallpaper Engine: the command line has no program-name token.
                        var si = new Native.STARTUPINFO(); si.cb = System.Runtime.InteropServices.Marshal.SizeOf(typeof(Native.STARTUPINFO));
                        Native.CreateProcessW(Application.ExecutablePath, new System.Text.StringBuilder("-WINDOWED -parentHWND " + host.Handle.ToInt64()),
                            IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out Native.PROCESS_INFORMATION pi);
                        return;
                    }
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                    {
                        FileName = Application.ExecutablePath,
                        Arguments = "-WINDOWED -parentHWND " + host.Handle.ToInt64() + " --debug",
                        UseShellExecute = false
                    });
                };
                Application.Run(host);
                return;
            }
            // Stub mode. Wallpaper Engine pulls every window of the process it starts - and of
            // that process's children - into its own window. WebView2 draws from a child
            // browser process, so its windows get pulled away too and it fails to start
            // ("invalid window handle"). So the process Wallpaper Engine starts is only a
            // stub: it starts a second copy, the worker, as a child of the Windows shell where
            // Wallpaper Engine leaves it alone, and waits. The worker starts WebView2, moves
            // itself into Wallpaper Engine's window, and closes when that window disappears.
            string cmdLine = Environment.CommandLine ?? "";
            var hostArg = System.Text.RegularExpressions.Regex.Match(cmdLine, @"-parentHWND\s+(\d+)",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (hostArg.Success && cmdLine.IndexOf("--worker", StringComparison.OrdinalIgnoreCase) < 0
                                && cmdLine.IndexOf("--debug", StringComparison.OrdinalIgnoreCase) < 0)
            {
                Log.Write("stub: [" + cmdLine + "]");
                try
                {
                    int pid = Native.StartUnderShell(Application.ExecutablePath,
                        "-WINDOWED -parentHWND " + hostArg.Groups[1].Value + " --worker --stub " + System.Diagnostics.Process.GetCurrentProcess().Id,
                        AppDomain.CurrentDomain.BaseDirectory, out string err);
                    Log.Write("stub: worker pid " + pid + (err != null ? " error: " + err : ""));
                    if (pid != 0)
                    {
                        using (var worker = System.Diagnostics.Process.GetProcessById(pid))
                        {
                            worker.WaitForExit();
                            Log.Write("stub: worker exited");
                        }
                    }
                }
                catch (Exception ex) { Log.Write("stub: could not start worker: " + ex); }
                return;
            }

            var form = new MainForm(args);
            if (!form.IsHosted && cmdLine.IndexOf("--worker", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                // Wallpaper Engine's window is already gone (it restarted the wallpaper):
                // never fall back to a stand-alone full-screen window in that case.
                Log.Write("worker: host window is gone, exiting");
                return;
            }
            if (form.IsHosted) Application.Run(new HostedContext(form));
            else Application.Run(form);
        }
    }

    /// <summary>
    /// Runs the worker without showing a top-level window: the window stays invisible until
    /// WebView2 is up, and only then is moved into Wallpaper Engine's window and shown.
    /// </summary>
    internal sealed class HostedContext : ApplicationContext
    {
        public HostedContext(MainForm form)
        {
            form.FormClosed += (s, e) => ExitThread();
            var kick = new Timer { Interval = 1 };
            kick.Tick += async (s, e) => { kick.Stop(); kick.Dispose(); await form.StartHostedAsync(); };
            kick.Start();
        }
    }

    /// <summary>
    /// Hosts the wallpaper UI (the HTML in the "web" folder) in WebView2 and feeds it the
    /// two things a Wallpaper Engine web wallpaper cannot get or do on its own:
    /// real audio capture, and control of the system media session.
    ///   --window  run in a normal 1280x720 window instead of borderless full screen
    ///   --debug   enable DevTools and the remote debugging port 9555
    /// </summary>
    internal sealed class MainForm : Form
    {
        private WebView2 web;
        private readonly bool windowed;
        private readonly bool debug;
        private MediaBridge media;
        private AudioBridge audio;

        private readonly IntPtr hostWindow;      // Wallpaper Engine's window to live inside, or zero
        private Timer fitTimer;
        private DesktopInput desktopInput;
        private int stubPid;                     // the process Wallpaper Engine started, or 0
        private string controlRects;             // latest "where the controls are" from the page
        private readonly Label errorLabel;

        public MainForm(string[] args)
        {
            // Wallpaper Engine starts application wallpapers as
            //   <exe> -WINDOWED -parentHWND <handle>
            // and expects the program to draw inside that window. Its command line may not
            // carry the usual program-name token, so parse the raw string, not args.
            string cmd = Environment.CommandLine ?? "";
            windowed = cmd.IndexOf("--window", StringComparison.OrdinalIgnoreCase) >= 0;
            debug = cmd.IndexOf("--debug", StringComparison.OrdinalIgnoreCase) >= 0;
            var m = System.Text.RegularExpressions.Regex.Match(cmd, @"-parentHWND\s+(\d+)",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (m.Success && long.TryParse(m.Groups[1].Value, out long h) && Native.IsWindow(new IntPtr(h)))
                hostWindow = new IntPtr(h);
            var sm = System.Text.RegularExpressions.Regex.Match(cmd, @"--stubs+(d+)");
            if (sm.Success) int.TryParse(sm.Groups[1].Value, out stubPid);
            Log.Write("start: [" + cmd + "] host=" + hostWindow);

            Text = "Cosmo Media Player Pro";
            BackColor = Color.Black;
            StartPosition = FormStartPosition.Manual;
            if (windowed && hostWindow == IntPtr.Zero)
            {
                ClientSize = new Size(1280, 720);
                Location = new Point(80, 80);
            }
            else
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                Bounds = Screen.PrimaryScreen.Bounds;
                // Until it is embedded, stay a tiny on-screen window: WebView2 fails to start
                // ("invalid window handle") in a window parked outside every monitor.
                if (hostWindow != IntPtr.Zero) Bounds = new Rectangle(0, 0, 8, 8);
            }

            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.Black };
            errorLabel = new Label
            {
                Dock = DockStyle.Fill, ForeColor = Color.FromArgb(200, 200, 205), BackColor = Color.Black,
                TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 12f), Visible = false
            };
            Controls.Add(web);
            Controls.Add(errorLabel);

            Load += async (s, e) =>
            {
                if (IsHosted) return;                    // hosted start-up is driven by HostedContext
                try { await InitAsync(); Log.Write("ready"); }
                catch (Exception ex) { ShowError(ex); }
            };
            FormClosed += (s, e) => { fitTimer?.Dispose(); audio?.Dispose(); };
        }

        public bool IsHosted => hostWindow != IntPtr.Zero;

        private void ShowError(Exception ex)
        {
            // Never a message box: Wallpaper Engine would show the dialog as the wallpaper.
            Log.Write("FAILED: " + ex);
            errorLabel.Text = "Cosmo Media Player Pro could not start.\n\n" + ex.Message +
                "\n\nThe Microsoft Edge WebView2 Runtime is required.\nDetails: " + Log.Path;
            errorLabel.Visible = true;
            errorLabel.BringToFront();
        }

        public async Task StartHostedAsync()
        {
            try
            {
                // Touching Handle creates the windows without showing them.
                IntPtr self = Handle;
                AttachWeb();
                await InitAsync();
                Log.Write("webview up");
            }
            catch (Exception ex) { ShowError(ex); }
            try
            {
                EnterHostWindow();
                Show();
                FitHost();
                Log.Write("ready (hosted)");
            }
            catch (Exception ex) { Log.Write("embedding failed: " + ex); }
        }

        /// <summary>Becomes a child of Wallpaper Engine's window and keeps filling it.</summary>
        private void EnterHostWindow()
        {
            if (hostWindow == IntPtr.Zero) return;
            long style = Native.GetWindowLongPtr(Handle, Native.GWL_STYLE).ToInt64();
            style = (style & ~Native.WS_POPUP & ~Native.WS_CAPTION & ~Native.WS_THICKFRAME) | Native.WS_CHILD | Native.WS_VISIBLE;
            Native.SetWindowLongPtr(Handle, Native.GWL_STYLE, new IntPtr(style));
            Native.SetParent(Handle, hostWindow);
            FitHost();
            fitTimer = new Timer { Interval = 1000 };
            fitTimer.Tick += (s, e) =>
            {
                if (!Native.IsWindow(hostWindow)) { Close(); return; }   // the wallpaper was closed
                FitHost();
                // Wallpaper Engine pauses an application wallpaper by suspending the process it
                // started - the stub. Follow it: stop drawing while the stub is suspended, so
                // the user's pause rules (full-screen game, battery, ...) keep working.
                bool paused = StubSuspended();
                if (web.Visible == paused) { web.Visible = !paused; Log.Write(paused ? "paused" : "resumed"); }
            };
            fitTimer.Start();

            if (web.CoreWebView2 != null)
            {
                desktopInput = new DesktopInput(hostWindow, (fx, fy, type) =>
                {
                    try
                    {
                        var inv = System.Globalization.CultureInfo.InvariantCulture;
                        web.CoreWebView2?.ExecuteScriptAsync("window.__cosmoPointer&&window.__cosmoPointer(" +
                            fx.ToString("0.#####", inv) + "," + fy.ToString("0.#####", inv) + ",'" + type + "')");
                    }
                    catch { /* page is going away */ }
                });
                if (controlRects != null) desktopInput.SetControls(controlRects);
                FormClosed += (s, e) => desktopInput?.Dispose();
            }
        }

        private bool StubSuspended()
        {
            if (stubPid == 0) return false;
            try
            {
                using (var stub = System.Diagnostics.Process.GetProcessById(stubPid))
                {
                    if (stub.Threads.Count == 0) return false;
                    foreach (System.Diagnostics.ProcessThread t in stub.Threads)
                        if (t.ThreadState != System.Diagnostics.ThreadState.Wait || t.WaitReason != System.Diagnostics.ThreadWaitReason.Suspended) return false;
                    return true;
                }
            }
            catch { return false; }      // the stub is gone; the host window check closes us
        }

        private void FitHost()
        {
            if (!Native.GetClientRect(hostWindow, out Native.RECT r)) return;
            int w = r.Right - r.Left, h = r.Bottom - r.Top;
            if (w <= 0 || h <= 0) return;
            if (Left != 0 || Top != 0 || Width != w || Height != h)
                Native.SetWindowPos(Handle, IntPtr.Zero, 0, 0, w, h, Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
        }

        /// <summary>
        /// While the form has never been shown, WinForms can keep a child control on its hidden
        /// message-only "parking" window. WebView2 refuses such a window ("invalid window
        /// handle"), so put the window of the control inside the window of the form for real.
        /// </summary>
        private void AttachWeb()
        {
            IntPtr self = Handle, view = web.Handle;
            if (Native.GetParent(view) != self)
            {
                Native.SetParent(view, self);
                Log.Write("attached web control: parent=" + Native.GetParent(view) + " (form " + self + ")");
            }
        }

        private bool webDirty;

        private async Task<CoreWebView2Environment> CreateEnvironmentAsync()
        {
            string root = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CosmoPlayer");
            var options = new CoreWebView2EnvironmentOptions(debug ? "--remote-debugging-port=9555" : null);
            // A data folder can only be shared by instances started with identical options,
            // so debug runs get their own; if the normal one is unusable, fall back to temp.
            string[] candidates =
            {
                Path.Combine(root, debug ? "WebView2-debug" : "WebView2"),
                Path.Combine(Path.GetTempPath(), "CosmoPlayer", "WebView2-" + System.Diagnostics.Process.GetCurrentProcess().Id)
            };
            Exception last = null;
            foreach (string dir in candidates)
            {
                if (webDirty)
                {
                    webDirty = false;
                    // A WebView2 control that failed to initialise cannot be initialised again:
                    // replace it before trying the next folder.
                    Controls.Remove(web);
                    try { web.Dispose(); } catch { }
                    web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.Black };
                    Controls.Add(web);
                    web.SendToBack();
                    AttachWeb();
                }
                try
                {
                    var env = await CoreWebView2Environment.CreateAsync(null, dir, options);
                    await web.EnsureCoreWebView2Async(env);
                    Log.Write("webview data: " + dir);
                    return env;
                }
                catch (Exception ex) { last = ex; webDirty = true; Log.Write("webview init failed in " + dir + ": " + ex.Message); }
            }
            throw last ?? new InvalidOperationException("WebView2 could not be created.");
        }

        private async Task InitAsync()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string webDir = Path.Combine(baseDir, "web");
            await CreateEnvironmentAsync();

            var core = web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = debug;
            core.Settings.AreDevToolsEnabled = debug;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = debug;

            // The UI is plain local files served under a private host name, so relative
            // paths and fetch() (lyrics) behave exactly as on a web server.
            core.SetVirtualHostNameToFolderMapping("cosmo.app", webDir, CoreWebView2HostResourceAccessKind.Allow);
            // The user's own background picture is copied here and served under its own host name
            // (a page cannot load file:// paths).
            Directory.CreateDirectory(UserDir);
            core.SetVirtualHostNameToFolderMapping("cosmo.user", UserDir, CoreWebView2HostResourceAccessKind.Allow);
            await core.AddScriptToExecuteOnDocumentCreatedAsync(File.ReadAllText(Path.Combine(webDir, "js", "bridge.js")));
            core.WebMessageReceived += (s, e) =>
            {
                string cmd;
                try { cmd = e.TryGetWebMessageAsString(); } catch { return; }
                if (cmd == "ready")
                {
                    media?.Resync(); audio?.SendDevice();
                    Post("{\"t\":\"version\",\"v\":" + Json.Str(Application.ProductVersion) + "}");
                    return;
                }
                // "Update available" button. Only ever this one fixed address.
                if (cmd == "openrelease")
                {
                    try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("https://github.com/cosmolabs-kr/Wallpaper/releases/latest") { UseShellExecute = true }); }
                    catch (Exception ex) { Log.Write("open release page: " + ex.Message); }
                    return;
                }
                // Not inside this event handler: a modal dialog here would re-enter WebView2.
                if (cmd == "pickimage") { BeginInvoke((Action)PickBackground); return; }
                if (cmd != null && cmd.StartsWith("hit:")) { controlRects = cmd.Substring(4); desktopInput?.SetControls(controlRects); return; }
                media?.Command(cmd);
            };
            core.Navigate("https://cosmo.app/index.html");

            media = new MediaBridge(Post);
            media.Start();
            audio = new AudioBridge(Post);
            audio.Start();
        }

        private static string UserDir => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CosmoPlayer", "user");

        /// <summary>
        /// "Background image" in the settings panel: shows the Windows file picker, keeps a copy
        /// of the chosen picture, and tells the page its address.
        /// </summary>
        private void PickBackground()
        {
            try
            {
                string picked = null;
                // The wallpaper has no window of its own on top of the desktop: give the
                // dialog an invisible always-on-top owner so it does not open behind things.
                using (var owner = new Form { TopMost = true, ShowInTaskbar = false, Opacity = 0, FormBorderStyle = FormBorderStyle.None, StartPosition = FormStartPosition.CenterScreen, Size = new Size(1, 1) })
                using (var dlg = new OpenFileDialog { Title = "Cosmo Media Player Pro", Filter = "Images|*.jpg;*.jpeg;*.png;*.webp;*.bmp;*.gif", CheckFileExists = true })
                {
                    owner.Show();
                    if (dlg.ShowDialog(owner) == DialogResult.OK) picked = dlg.FileName;
                    owner.Close();
                }
                if (picked == null) return;

                Directory.CreateDirectory(UserDir);
                foreach (string old in Directory.GetFiles(UserDir, "background-*")) { try { File.Delete(old); } catch { } }
                // A new name every time, so the page never shows a cached older picture.
                string name = "background-" + DateTime.UtcNow.Ticks + Path.GetExtension(picked).ToLowerInvariant();
                File.Copy(picked, Path.Combine(UserDir, name), true);
                Post("{\"t\":\"bgimage\",\"url\":" + Json.Str("https://cosmo.user/" + name) + "}");
            }
            catch (Exception ex) { Log.Write("background image: " + ex.Message); }
        }

        /// <summary>Sends one JSON message to the page (safe to call from any thread).</summary>
        private void Post(string json)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try
            {
                BeginInvoke((Action)(() =>
                {
                    try { web.CoreWebView2?.PostWebMessageAsJson(json); } catch { /* page is going away */ }
                }));
            }
            catch { /* form is closing */ }
        }
    }

    internal static class Log
    {
        public static readonly string Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "CosmoPlayer.log");
        private static readonly object Gate = new object();

        public static void Write(string line)
        {
            try
            {
                lock (Gate)
                {
                    if (File.Exists(Path) && new FileInfo(Path).Length > 200 * 1024) File.Delete(Path);
                    File.AppendAllText(Path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  " + line + Environment.NewLine);
                }
            }
            catch { /* logging must never break the wallpaper */ }
        }
    }

    internal static class Native
    {
        public const int GWL_STYLE = -16;
        public const long WS_CHILD = 0x40000000, WS_VISIBLE = 0x10000000, WS_POPUP = 0x80000000,
                          WS_CAPTION = 0x00C00000, WS_THICKFRAME = 0x00040000;
        public const uint SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010;

        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out uint info, int length, out int returned);

        /// <summary>Whether a parent put this process in a job object, and with which UI restrictions.</summary>
        public static string DescribeJob()
        {
            try
            {
                IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out bool inJob);
                if (!inJob) return "job: none";
                bool ok = QueryInformationJobObject(IntPtr.Zero, 4 /* JobObjectBasicUIRestrictions */, out uint ui, 4, out int _);
                return "job: yes, ui restrictions=" + (ok ? "0x" + ui.ToString("x") : "query failed " + System.Runtime.InteropServices.Marshal.GetLastWin32Error());
            }
            catch (Exception ex) { return "job: ? " + ex.Message; }
        }

        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        public struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
        [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
        public static extern bool CreateProcessW(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
        [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
        static extern bool CreateProcessEx(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
        [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr GetShellWindow();

        /// <summary>
        /// Starts a program as a child of the Windows shell (Explorer) instead of this process,
        /// so that whoever watches this process and its children does not see it.
        /// Returns the new process id, or 0.
        /// </summary>
        public static int StartUnderShell(string exe, string arguments, string dir, out string error)
        {
            error = null;
            IntPtr parent = IntPtr.Zero, list = IntPtr.Zero, value = IntPtr.Zero;
            try
            {
                GetWindowThreadProcessId(GetShellWindow(), out uint shellPid);
                if (shellPid == 0) { error = "no shell window"; return 0; }
                parent = OpenProcess(0x0080 /* PROCESS_CREATE_PROCESS */, false, shellPid);
                if (parent == IntPtr.Zero) { error = "OpenProcess " + System.Runtime.InteropServices.Marshal.GetLastWin32Error(); return 0; }

                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                list = System.Runtime.InteropServices.Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) { error = "attribute list " + System.Runtime.InteropServices.Marshal.GetLastWin32Error(); return 0; }
                value = System.Runtime.InteropServices.Marshal.AllocHGlobal(IntPtr.Size);
                System.Runtime.InteropServices.Marshal.WriteIntPtr(value, parent);
                if (!UpdateProcThreadAttribute(list, 0, new IntPtr(0x00020000) /* PARENT_PROCESS */, value, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                { error = "update attribute " + System.Runtime.InteropServices.Marshal.GetLastWin32Error(); return 0; }

                var si = new STARTUPINFOEX();
                si.StartupInfo.cb = System.Runtime.InteropServices.Marshal.SizeOf(typeof(STARTUPINFOEX));
                si.lpAttributeList = list;
                var cmd = new System.Text.StringBuilder("\"" + exe + "\" " + arguments);
                if (!CreateProcessEx(exe, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x00080000 /* EXTENDED_STARTUPINFO_PRESENT */, IntPtr.Zero, dir, ref si, out PROCESS_INFORMATION pi))
                { error = "CreateProcess " + System.Runtime.InteropServices.Marshal.GetLastWin32Error(); return 0; }
                CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
                return pi.dwProcessId;
            }
            catch (Exception ex) { error = ex.Message; return 0; }
            finally
            {
                if (list != IntPtr.Zero) { DeleteProcThreadAttributeList(list); System.Runtime.InteropServices.Marshal.FreeHGlobal(list); }
                if (value != IntPtr.Zero) System.Runtime.InteropServices.Marshal.FreeHGlobal(value);
                if (parent != IntPtr.Zero) CloseHandle(parent);
            }
        }

        [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint threadId);
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr obj, int index, System.Text.StringBuilder info, int length, out int needed);
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder name, int max);

        static string ObjName(IntPtr h) { var sb = new System.Text.StringBuilder(256); return GetUserObjectInformationW(h, 2, sb, 512, out int _) ? sb.ToString() : "?"; }

        /// <summary>Which window station / desktop this process runs on, and where the host window lives.</summary>
        public static string DescribeDesktop(IntPtr host)
        {
            try
            {
                string me = ObjName(GetProcessWindowStation()) + "\\" + ObjName(GetThreadDesktop(GetCurrentThreadId()));
                string h = "none";
                if (host != IntPtr.Zero)
                {
                    uint tid = GetWindowThreadProcessId(host, out uint pid);
                    var cls = new System.Text.StringBuilder(128); GetClassNameW(host, cls, 128);
                    h = "class=" + cls + " pid=" + pid + " desktop=" + ObjName(GetThreadDesktop(tid)) + " parent=" + GetParent(host);
                }
                return "desktop: " + me + "; host: " + h + "; elevated=" + new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            }
            catch (Exception ex) { return "desktop: ? " + ex.Message; }
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsProcessDPIAware();
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);

        /// <summary>Is the active window a full-screen program (not the desktop, not the wallpaper)?</summary>
        public static bool FullScreenProgramInFront(IntPtr wallpaperHost)
        {
            IntPtr fg = GetForegroundWindow();
            if (fg == IntPtr.Zero || fg == wallpaperHost || IsChild(wallpaperHost, fg)) return false;
            var sb = new System.Text.StringBuilder(64); GetClassNameW(fg, sb, 64);
            string cls = sb.ToString();
            if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd") return false;
            if (!GetWindowRect(fg, out RECT r)) return false;
            var on = System.Windows.Forms.Screen.FromHandle(fg);
            // A program covering another monitor does not hide this wallpaper.
            if (on.DeviceName != System.Windows.Forms.Screen.FromHandle(wallpaperHost).DeviceName) return false;
            var screen = on.Bounds;
            return r.Left <= screen.Left && r.Top <= screen.Top && r.Right >= screen.Right && r.Bottom >= screen.Bottom;
        }
        [System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, byte[] buf, int len, out int ret);
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
        [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern uint GetPriorityClass(IntPtr h);
        public static string DescribeWindow(IntPtr h)
        {
            if (h == IntPtr.Zero) return "0";
            var sb = new System.Text.StringBuilder(128); GetClassNameW(h, sb, 128);
            GetWindowThreadProcessId(h, out uint pid);
            return h + "(" + sb + " pid=" + pid + " root=" + GetAncestor(h, 2) + ")";
        }
        public static string DescribeToken()
        {
            try
            {
                IntPtr t = System.Security.Principal.WindowsIdentity.GetCurrent().Token;
                var b = new byte[64]; int n;
                string r = "";
                if (GetTokenInformation(t, 25, b, b.Length, out n)) { int off = BitConverter.ToInt32(b, 0) == 0 ? 0 : 0; r += "integrityRID=0x" + BitConverter.ToInt32(b, n - 4).ToString("X"); }
                if (GetTokenInformation(t, 18, b, b.Length, out n)) r += " elevationType=" + BitConverter.ToInt32(b, 0);
                if (GetTokenInformation(t, 26, b, b.Length, out n)) r += " uiAccess=" + BitConverter.ToInt32(b, 0);
                if (GetTokenInformation(t, 12, b, b.Length, out n)) r += " session=" + BitConverter.ToInt32(b, 0);
                if (GetTokenInformation(t, 29, b, b.Length, out n)) r += " appContainer=" + BitConverter.ToInt32(b, 0);
                if (GetTokenInformation(t, 24, b, b.Length, out n)) r += " virtualization=" + BitConverter.ToInt32(b, 0);
                r += " priority=0x" + GetPriorityClass(System.Diagnostics.Process.GetCurrentProcess().Handle).ToString("X");
                return "token: " + r;
            }
            catch (Exception ex) { return "token: " + ex.Message; }
        }
        [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
        [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
        [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
        [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
        [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);
    }

    internal static class Json
    {
        public static string Str(string s)
        {
            if (s == null) return "\"\"";
            var sb = new System.Text.StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }

        public static string Num(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return "0";
            return v.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
        }
    }
}
