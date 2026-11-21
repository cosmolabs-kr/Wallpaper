// Records the Workshop preview GIF from the demo's ?preview mode.
// Needs: the dev server running (node dev-server.js), Chrome, ffmpeg on PATH.
// Usage: node --experimental-websocket tools/record-preview.js
// Output: wallpaper/preview.gif (256x256, the Workshop maximum; must stay under 1 MB)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// MODE=4: app edition close-up - media buttons, analyzer panel stays (default).
// MODE=3: close-up where the analyzer panel opens and closes.
// MODE=2: close-up of the card + lyrics.
// MODE=1: player + analyzer + lyrics.
const URL = 'http://localhost:5190/?preview=' + (process.env.MODE || '4');
const PORT = 9334;
const VIEW = 512;                              // captured size, downscaled 2:1
const FPS = Number(process.env.FPS || 8);
const SECONDS = 10;                            // one full cycle: 4 tracks x 2.5 s
const COLORS = Number(process.env.COLORS || 256);
const OUT = process.env.OUT ? path.resolve(process.env.OUT) : path.join(__dirname, '..', 'preview.gif');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-preview-'));
const frames = path.join(work, 'frames');
fs.mkdirSync(frames);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(work, 'profile'),
    '--window-size=' + VIEW + ',' + VIEW, '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--enable-unsafe-swiftshader', URL
  ], { stdio: 'ignore' });

  try {
    let page;
    for (let i = 0; i < 50 && !page; i++) {
      await sleep(300);
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        page = list.find(p => p.type === 'page' && p.url.indexOf('localhost:5190') >= 0);
      } catch (e) { /* not up yet */ }
    }
    if (!page) throw new Error('Chrome page not found. Is the dev server running?');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP connect failed')); });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params) => new Promise(res => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
    const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.result.value;

    await send('Emulation.setDeviceMetricsOverride', { width: VIEW, height: VIEW, deviceScaleFactor: 1, mobile: false });

    console.log('Warming up (tempo estimate needs ~10 s)...');
    await sleep(11000);
    // Start a moment after the switch to START_TRACK, once its transition has settled:
    // the first frame doubles as the static thumbnail, and one full cycle later the
    // scene is in the same state, so the GIF still loops cleanly.
    const START_TRACK = Number(process.env.START_TRACK || 1);
    let last = await evaluate('window.__trackIndex');
    for (let i = 0; i < 800; i++) {
      await sleep(15);
      const cur = await evaluate('window.__trackIndex');
      if (cur === START_TRACK && last !== START_TRACK) break;
      last = cur;
    }
    await sleep(Number(process.env.START_DELAY || 900));

    const total = FPS * SECONDS, t0 = Date.now();
    for (let i = 0; i < total; i++) {
      const wait = t0 + i * 1000 / FPS - Date.now();
      if (wait > 0) await sleep(wait);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(frames, 'f_' + String(i).padStart(4, '0') + '.png'), Buffer.from(shot.result.data, 'base64'));
    }
    console.log('Captured ' + total + ' frames in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
    ws.close();
  } finally {
    chrome.kill();
  }

  // Light ordered (bayer) dithering: its pattern is fixed per pixel, so unchanged areas
  // stay identical between frames. Error-diffusion dithering roughly doubles the file.
  const vf = 'scale=256:256:flags=lanczos,split[a][b];[a]palettegen=max_colors=' + COLORS +
    ':stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS),
    '-i', path.join(frames, 'f_%04d.png'), '-vf', vf, '-loop', '0', OUT], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed');
  // Keep one frame for a quick visual check.
  fs.copyFileSync(path.join(frames, 'f_0030.png'), path.join(work, 'sample.png'));
  console.log('Wrote ' + OUT + ' (' + (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB)');
  console.log('Sample frame: ' + path.join(work, 'sample.png'));
}

main().catch(e => { console.error(e.message); process.exit(1); });
