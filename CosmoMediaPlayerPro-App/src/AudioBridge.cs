using System;
using System.Text;
using System.Threading;
using NAudio.CoreAudioApi;
using NAudio.Dsp;
using NAudio.Wave;

namespace CosmoPlayer
{
    /// <summary>
    /// Captures what the default output device is playing (WASAPI loopback) and turns it
    /// into the same shape Wallpaper Engine gives web wallpapers - 64 bands per channel,
    /// left then right, ~30 times a second - so the existing UI works unchanged.
    /// Because this is real audio, the bands have known frequencies (log spaced
    /// 40 Hz - 16 kHz) and the device name and format are known too.
    /// </summary>
    internal sealed class AudioBridge : IDisposable
    {
        private const int FftSize = 2048;       // ~43 ms at 48 kHz
        private const int FftBits = 11;
        private const int Bands = 64;
        private const double FreqLo = 40, FreqHi = 16000;

        private readonly Action<string> post;
        private readonly object gate = new object();
        private readonly float[] ringL = new float[FftSize * 4];
        private readonly float[] ringR = new float[FftSize * 4];
        private int write;
        private DateTime lastData = DateTime.MinValue;
        private WasapiLoopbackCapture capture;
        private Timer timer;
        private int sampleRate = 48000;
        private readonly double[] window = new double[FftSize];
        private bool sentSilence;

        public AudioBridge(Action<string> post)
        {
            this.post = post;
            for (int i = 0; i < FftSize; i++) window[i] = 0.5 * (1 - Math.Cos(2 * Math.PI * i / (FftSize - 1)));
        }

        public void Start()
        {
            try
            {
                string name = "";
                try
                {
                    using (var en = new MMDeviceEnumerator())
                    using (var dev = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia))
                        name = dev.FriendlyName;
                }
                catch { /* name is optional */ }

                capture = new WasapiLoopbackCapture();
                var f = capture.WaveFormat;
                sampleRate = f.SampleRate;
                int channels = f.Channels;
                bool isFloat = f.Encoding == WaveFormatEncoding.IeeeFloat ||
                               (f is WaveFormatExtensible ext && ext.SubFormat == NAudio.Dmo.AudioMediaSubtypes.MEDIASUBTYPE_IEEE_FLOAT);
                int bytesPerSample = f.BitsPerSample / 8;

                capture.DataAvailable += (s, e) =>
                {
                    int frame = bytesPerSample * channels;
                    if (frame == 0) return;
                    lock (gate)
                    {
                        for (int i = 0; i + frame <= e.BytesRecorded; i += frame)
                        {
                            float l = Sample(e.Buffer, i, bytesPerSample, isFloat);
                            float r = channels > 1 ? Sample(e.Buffer, i + bytesPerSample, bytesPerSample, isFloat) : l;
                            ringL[write] = l;
                            ringR[write] = r;
                            write = (write + 1) % ringL.Length;
                        }
                        lastData = DateTime.UtcNow;
                    }
                };
                capture.StartRecording();

                deviceJson = "{\"t\":\"device\",\"name\":" + Json.Str(name) + ",\"rate\":" + sampleRate +
                     ",\"bits\":" + f.BitsPerSample + ",\"channels\":" + channels + "}";
                post(deviceJson);
                timer = new Timer(_ => Tick(), null, 200, 33);
            }
            catch (Exception ex)
            {
                deviceJson = "{\"t\":\"device\",\"name\":" + Json.Str("audio capture unavailable: " + ex.Message) + ",\"rate\":0,\"bits\":0,\"channels\":0}";
                post(deviceJson);
            }
        }

        private static float Sample(byte[] buf, int offset, int bytes, bool isFloat)
        {
            if (isFloat && bytes == 4) return BitConverter.ToSingle(buf, offset);
            if (bytes == 2) return BitConverter.ToInt16(buf, offset) / 32768f;
            if (bytes == 3) return ((buf[offset + 2] << 24 | buf[offset + 1] << 16 | buf[offset] << 8) >> 8) / 8388608f;
            if (bytes == 4) return BitConverter.ToInt32(buf, offset) / 2147483648f;
            return 0f;
        }

        private string deviceJson;

        public void SendDevice() { if (deviceJson != null) post(deviceJson); }

        private int busy;

        /// <summary>While paused nothing is analysed or sent to the page.</summary>
        public volatile bool Paused;

        private void Tick()
        {
            if (Paused) return;
            if (Interlocked.Exchange(ref busy, 1) == 1) return;
            try
            {
                var l = new float[FftSize];
                var r = new float[FftSize];
                bool silent;
                lock (gate)
                {
                    // WASAPI loopback delivers nothing at all while nothing is playing.
                    silent = (DateTime.UtcNow - lastData).TotalMilliseconds > 250;
                    if (!silent)
                    {
                        int start = (write - FftSize + ringL.Length) % ringL.Length;
                        for (int i = 0; i < FftSize; i++)
                        {
                            int k = (start + i) % ringL.Length;
                            l[i] = ringL[k];
                            r[i] = ringR[k];
                        }
                    }
                }

                if (silent)
                {
                    if (sentSilence) return;
                    sentSilence = true;
                }
                else sentSilence = false;

                var bl = BandsOf(l);
                var br = BandsOf(r);
                var sb = new StringBuilder(1200);
                sb.Append("{\"t\":\"audio\",\"d\":[");
                for (int i = 0; i < Bands; i++) sb.Append(Json.Num(bl[i])).Append(',');
                for (int i = 0; i < Bands; i++) { sb.Append(Json.Num(br[i])); if (i < Bands - 1) sb.Append(','); }
                sb.Append("]}");
                post(sb.ToString());
            }
            catch { /* one bad frame is not worth dying for */ }
            finally { Interlocked.Exchange(ref busy, 0); }
        }

        private double[] BandsOf(float[] samples)
        {
            var c = new Complex[FftSize];
            for (int i = 0; i < FftSize; i++) { c[i].X = (float)(samples[i] * window[i]); c[i].Y = 0; }
            FastFourierTransform.FFT(true, FftBits, c);

            var bands = new double[Bands];
            double binHz = (double)sampleRate / FftSize;
            for (int b = 0; b < Bands; b++)
            {
                double f0 = FreqLo * Math.Pow(FreqHi / FreqLo, (double)b / Bands);
                double f1 = FreqLo * Math.Pow(FreqHi / FreqLo, (double)(b + 1) / Bands);
                int i0 = Math.Max(1, (int)Math.Floor(f0 / binHz));
                int i1 = Math.Min(FftSize / 2 - 1, Math.Max(i0, (int)Math.Ceiling(f1 / binHz) - 1));
                double peak = 0;
                for (int i = i0; i <= i1; i++)
                {
                    double m = Math.Sqrt(c[i].X * c[i].X + c[i].Y * c[i].Y);
                    if (m > peak) peak = m;
                }
                // NAudio's forward FFT divides by N; a full-scale sine through a Hann window
                // peaks near 0.25, so x4 maps full scale to about 1.
                bands[b] = Math.Min(1.5, peak * 4.0);
            }
            return bands;
        }

        public void Dispose()
        {
            try { timer?.Dispose(); } catch { }
            try { capture?.StopRecording(); capture?.Dispose(); } catch { }
        }
    }
}
