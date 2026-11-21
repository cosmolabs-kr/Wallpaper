using System;
using System.Threading.Tasks;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace CosmoPlayer
{
    /// <summary>
    /// Reads the system media session (the same source Wallpaper Engine uses: whatever app
    /// currently owns the Windows media overlay) and, unlike a web wallpaper, can also
    /// send it commands: play/pause, next, previous.
    /// Polling rather than events: simple, and immune to sessions appearing and vanishing.
    /// </summary>
    internal sealed class MediaBridge
    {
        private readonly Action<string> post;
        private GlobalSystemMediaTransportControlsSessionManager manager;
        private volatile GlobalSystemMediaTransportControlsSession current;

        public MediaBridge(Action<string> post) { this.post = post; }

        public void Start() { Task.Run(Loop); }

        private volatile bool resync;

        /// <summary>Send the whole current state again (the page has just (re)loaded).</summary>
        public void Resync() { resync = true; }

        /// <summary>The session that is actually playing, if any; otherwise the one Windows calls current.</summary>
        private GlobalSystemMediaTransportControlsSession PickSession()
        {
            try
            {
                foreach (var s in manager.GetSessions())
                {
                    try
                    {
                        if (s.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing) return s;
                    }
                    catch { }
                }
            }
            catch { }
            return manager.GetCurrentSession();
        }

        public async void Command(string cmd)
        {
            var s = current;
            if (s == null || cmd == null) return;
            try
            {
                bool ok = false;
                byte key = 0;
                switch (cmd)
                {
                    case "playpause": ok = await s.TryTogglePlayPauseAsync(); key = 0xB3; break;
                    case "next": ok = await s.TrySkipNextAsync(); key = 0xB0; break;
                    case "prev": ok = await s.TrySkipPreviousAsync(); key = 0xB1; break;
                }
                // Some players (Apple Music for "previous") say no to the session command,
                // or claim the button is unavailable, yet obey the keyboard media key.
                if (!ok && key != 0) PressMediaKey(key);
            }
            catch { /* the player refused or went away */ }
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

        private static void PressMediaKey(byte vk)
        {
            keybd_event(vk, 0, 1 /* extended key */, UIntPtr.Zero);
            keybd_event(vk, 0, 1 | 2 /* key up */, UIntPtr.Zero);
        }

        private async Task Loop()
        {
            try { manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync(); }
            catch
            {
                post("{\"t\":\"status\",\"enabled\":false}");
                return;
            }
            post("{\"t\":\"status\",\"enabled\":true}");

            string lastKey = null, lastThumb = null, lastCaps = null;
            int lastState = -1;
            DateTime keyAt = DateTime.MinValue, timelineAt = DateTime.MinValue;

            while (true)
            {
                try
                {
                    if (resync)
                    {
                        resync = false;
                        lastKey = null; lastThumb = null; lastCaps = null; lastState = -1;
                        post("{\"t\":\"status\",\"enabled\":true}");
                    }
                    var s = PickSession();
                    current = s;
                    var now = DateTime.UtcNow;

                    if (s == null)
                    {
                        if (lastKey != "")
                        {
                            lastKey = ""; lastThumb = null; lastState = 0;
                            post("{\"t\":\"properties\",\"title\":\"\",\"artist\":\"\",\"albumTitle\":\"\"}");
                            post("{\"t\":\"playback\",\"state\":0}");
                        }
                    }
                    else
                    {
                        var p = await s.TryGetMediaPropertiesAsync();
                        string key = p.Title + "\n" + p.Artist + "\n" + p.AlbumTitle;
                        if (key != lastKey)
                        {
                            lastKey = key; keyAt = now; lastThumb = null;
                            post("{\"t\":\"properties\",\"title\":" + Json.Str(p.Title) + ",\"artist\":" + Json.Str(p.Artist) +
                                 ",\"albumTitle\":" + Json.Str(p.AlbumTitle) + ",\"albumArtist\":" + Json.Str(p.AlbumArtist) + "}");
                        }

                        // Players often publish the cover a moment after the title: keep
                        // checking for a few seconds after every track change.
                        if (lastThumb == null || (now - keyAt).TotalSeconds < 4)
                        {
                            string thumb = await ReadThumbnail(p);
                            if (thumb != null && thumb != lastThumb)
                            {
                                lastThumb = thumb;
                                post("{\"t\":\"thumbnail\",\"thumbnail\":" + Json.Str(thumb) + "}");
                            }
                            else if (thumb == null && lastThumb == null && (now - keyAt).TotalSeconds > 2)
                            {
                                lastThumb = "";
                                post("{\"t\":\"thumbnail\",\"thumbnail\":\"\"}");
                                post("{\"t\":\"log\",\"m\":" + Json.Str("thumbnail: " + (p.Thumbnail == null ? "player gave none" : LastThumbError)) + "}");
                            }
                        }

                        var info = s.GetPlaybackInfo();
                        int state = info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing ? 1
                                  : info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused ? 2 : 0;
                        bool stateChanged = state != lastState;
                        if (stateChanged)
                        {
                            lastState = state;
                            post("{\"t\":\"playback\",\"state\":" + state + "}");
                        }

                        // Which buttons this player actually honours.
                        var c = info.Controls;
                        string caps = (c.IsPlayPauseToggleEnabled || c.IsPlayEnabled || c.IsPauseEnabled ? "1" : "0") +
                                      (c.IsNextEnabled ? "1" : "0") + (c.IsPreviousEnabled ? "1" : "0");
                        if (caps != lastCaps)
                        {
                            lastCaps = caps;
                            post("{\"t\":\"controls\",\"playpause\":" + (caps[0] == '1' ? "true" : "false") +
                                 ",\"next\":" + (caps[1] == '1' ? "true" : "false") +
                                 ",\"prev\":" + (caps[2] == '1' ? "true" : "false") +
                                 ",\"app\":" + Json.Str(s.SourceAppUserModelId) + "}");
                        }

                        if (stateChanged || (now - timelineAt).TotalSeconds >= 1)
                        {
                            timelineAt = now;
                            var tl = s.GetTimelineProperties();
                            double dur = (tl.EndTime - tl.StartTime).TotalSeconds;
                            double pos = (tl.Position - tl.StartTime).TotalSeconds;
                            if (state == 1 && tl.LastUpdatedTime.Year > 2000)
                                pos += (DateTimeOffset.UtcNow - tl.LastUpdatedTime).TotalSeconds;
                            if (dur > 0)
                            {
                                if (pos > dur) pos = dur;
                                if (pos < 0) pos = 0;
                                post("{\"t\":\"timeline\",\"position\":" + Json.Num(pos) + ",\"duration\":" + Json.Num(dur) + "}");
                            }
                        }
                    }
                }
                catch { /* a session can disappear mid-read: try again next round */ }

                await Task.Delay(350);
            }
        }

        private static async Task<string> ReadThumbnail(GlobalSystemMediaTransportControlsSessionMediaProperties p)
        {
            try
            {
                if (p.Thumbnail == null) return null;
                using (var stream = await p.Thumbnail.OpenReadAsync())
                {
                    uint size = (uint)stream.Size;
                    if (size == 0 || size > 8 * 1024 * 1024) return null;
                    using (var reader = new DataReader(stream))
                    {
                        await reader.LoadAsync(size);
                        var bytes = new byte[size];
                        reader.ReadBytes(bytes);
                        // Some players report several types at once ("image/jpeg,image/jpe,image/jpg").
                        string type = string.IsNullOrEmpty(stream.ContentType) ? "image/png" : stream.ContentType.Split(',')[0].Trim();
                        return "data:" + type + ";base64," + Convert.ToBase64String(bytes);
                    }
                }
            }
            catch (Exception ex) { LastThumbError = ex.GetType().Name + ": " + ex.Message; return null; }
        }

        internal static string LastThumbError;
    }
}
