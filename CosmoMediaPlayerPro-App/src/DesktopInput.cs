using System;
using System.Runtime.InteropServices;
using System.Text;

namespace CosmoPlayer
{
    /// <summary>
    /// A wallpaper sits underneath the desktop icons, so Windows never delivers mouse input
    /// to it. This watches the mouse system-wide (it only looks, it never blocks or changes
    /// anything) and, when the pointer is over the bare desktop, reports where it is inside
    /// the wallpaper as fractions 0..1, plus presses and clicks.
    /// Must be created on a thread that pumps messages (the UI thread).
    /// </summary>
    internal sealed class DesktopInput : IDisposable
    {
        private readonly IntPtr host;
        private readonly Action<double, double, string> report;   // fx, fy, "move" | "down" | "click" | "leave"
        private readonly HookProc proc;                            // kept alive for the hook's lifetime
        private IntPtr hook;
        private int lastMoveTick;
        private bool inside, pressed;
        private POINT downAt;
        private bool swallowUp;
        private double[] controls = new double[0];      // x0,y0,x1,y1 ... as fractions of the wallpaper

        /// <summary>Where the wallpaper's clickable things are; sent by the page ("hit:x0,y0,x1,y1,...").</summary>
        public void SetControls(string list)
        {
            try
            {
                var parts = list.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
                var r = new double[parts.Length / 4 * 4];
                for (int i = 0; i < r.Length; i++) r[i] = double.Parse(parts[i], System.Globalization.CultureInfo.InvariantCulture);
                controls = r;
            }
            catch { controls = new double[0]; }
        }

        private bool OnControl(double fx, double fy)
        {
            var r = controls;
            for (int i = 0; i + 3 < r.Length; i += 4)
                if (fx >= r[i] && fx <= r[i + 2] && fy >= r[i + 1] && fy <= r[i + 3]) return true;
            return false;
        }

        public DesktopInput(IntPtr hostWindow, Action<double, double, string> report)
        {
            host = hostWindow;
            this.report = report;
            proc = Callback;
            hook = SetWindowsHookExW(14 /* WH_MOUSE_LL */, proc, GetModuleHandleW(null), 0);
            Log.Write("desktop input hook: " + (hook != IntPtr.Zero ? "on" : "FAILED " + Marshal.GetLastWin32Error()));
        }

        private IntPtr Callback(int code, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (code >= 0)
                {
                    int msg = wParam.ToInt32();
                    if (msg == 0x200 || msg == 0x201 || msg == 0x202)
                    {
                        var pt = (POINT)Marshal.PtrToStructure(lParam, typeof(POINT));
                        // A press on one of the wallpaper's controls is ours alone: without this
                        // the desktop underneath would also select icons or start a selection box.
                        if (Handle(msg, pt)) return new IntPtr(1);
                    }
                }
            }
            catch { /* never let a hook callback throw */ }
            return CallNextHookEx(hook, code, wParam, lParam);
        }

        /// <summary>Returns true when the event must not reach the desktop.</summary>
        private bool Handle(int msg, POINT pt)
        {
            if (msg == 0x200)
            {
                int now = Environment.TickCount;
                if (now - lastMoveTick < 33) return false;        // ~30 updates a second is plenty
                lastMoveTick = now;
            }

            bool over = OverDesktop(pt, out double fx, out double fy);
            if (!over)
            {
                bool held = swallowUp && msg == 0x202;      // finish a press that began on a control
                swallowUp = swallowUp && msg != 0x202;
                if (inside) { inside = false; pressed = false; report(0, 0, "leave"); }
                return held;
            }
            inside = true;

            if (msg == 0x200) { report(fx, fy, "move"); return false; }
            if (msg == 0x201)
            {
                pressed = true; downAt = pt;
                swallowUp = OnControl(fx, fy);
                report(fx, fy, "down");
                return swallowUp;
            }
            {
                // A click is a press and a release at (nearly) the same spot; a drag is not.
                bool click = pressed && Math.Abs(pt.X - downAt.X) < 12 && Math.Abs(pt.Y - downAt.Y) < 12;
                pressed = false;
                report(fx, fy, click ? "click" : "up");
                bool held = swallowUp;
                swallowUp = false;
                return held;
            }
        }

        /// <summary>Is the topmost window at this point the desktop (or the wallpaper itself)?</summary>
        private bool OverDesktop(POINT pt, out double fx, out double fy)
        {
            fx = fy = 0;
            IntPtr w = WindowFromPoint(pt);
            if (w == IntPtr.Zero) return false;
            if (w != host && !IsChild(host, w))
            {
                var sb = new StringBuilder(64);
                GetClassNameW(w, sb, 64);
                string cls = sb.ToString();
                if (cls == "SysListView32" || cls == "SHELLDLL_DefView")
                {
                    // The same classes are used inside Explorer windows: only the desktop's count.
                    var root = GetAncestor(w, 2 /* GA_ROOT */);
                    sb.Clear(); GetClassNameW(root, sb, 64);
                    cls = sb.ToString();
                }
                if (cls != "Progman" && cls != "WorkerW") return false;
            }
            if (!GetWindowRect(host, out RECT r)) return false;
            int width = r.Right - r.Left, height = r.Bottom - r.Top;
            if (width <= 0 || height <= 0) return false;
            fx = (pt.X - r.Left) / (double)width;
            fy = (pt.Y - r.Top) / (double)height;
            return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1;
        }

        public void Dispose()
        {
            if (hook != IntPtr.Zero) { UnhookWindowsHookEx(hook); hook = IntPtr.Zero; }
        }

        private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookExW(int id, HookProc proc, IntPtr module, uint threadId);
        [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandleW(string name);
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT pt);
        [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr child);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr h, uint flags);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);
    }
}
