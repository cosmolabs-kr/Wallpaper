/* Analyzer panel: stereo spectrum with peak hold, spectrogram, level / balance / width
 * meters, band energy readouts and a tempo estimate.
 * Wallpaper Engine only provides 64 normalized bands per channel (~30 Hz update), so
 * everything here is derived from that; absolute Hz / dB values are not available. */
window.Analyzer = (function () {
  'use strict';

  var N = 64;
  var $ = function (id) { return document.getElementById(id); };
  var enabled = true;
  var fg = [18, 20, 24], accent = [52, 84, 128];

  var tL = new Float32Array(N), tR = new Float32Array(N);   // latest raw frame
  var L = new Float32Array(N), R = new Float32Array(N);     // smoothed for display
  var pkL = new Float32Array(N), pkR = new Float32Array(N); // peak hold
  var prev = new Float32Array(N);
  var lastAt = 0;

  /* ── tempo ── */
  var ENV = 1024;
  var env = new Float32Array(ENV), envT = new Float64Array(ENV), envN = 0, envI = 0;
  var lastTempoAt = 0, lastStoreAt = 0;
  var fluxAvg = 0, beat = 0, lastBeatAt = 0;
  var bpmHist = [], bpmShown = 0, bpmConf = 0;
  /* ── beat position: a clock locked to the detected onsets ── */
  var beatT0 = 0, beatMiss = 0, barAcc = [0, 0, 0, 0];
  /* ── tonal balance: the spectrum averaged over ~10 s ── */
  var tone = new Float32Array(N), toneAt = 0;
  var tc = $('anTone'), tctx = tc.getContext('2d'), tcW = 0, tcH = 0;
  var overL = -1e9, overR = -1e9;

  /* ── spectrogram ── */
  var gram = $('anGram'), gctx = gram.getContext('2d', { willReadFrequently: false });
  var col = gctx.createImageData(1, N);
  var lastColAt = 0;

  /* ── spectrum canvas ── */
  var sp = $('anSpectrum'), sctx = sp.getContext('2d');
  var spW = 0, spH = 0, sizeAt = -1e9;

  var el = {
    bpm: $('anBpm'), beats: $('anBeats').children, conf: $('anConf'), lo: $('anLo'), ro: $('anRo'), tilt: $('anTilt'),
    l: $('anL'), r: $('anR'), lp: $('anLp'), rp: $('anRp'),
    bal: $('anBal'), wid: $('anWid'),
    dr: $('anDr'), sim: $('anSim'), peak: $('anPeak'), left: $('anLeft')
  };
  var m = { l: 0, r: 0, lp: 0, rp: 0, lpAt: 0, rpAt: 0, bal: 0, wid: 0, low: 0, mid: 0, high: 0, bright: 0,
            sim: 0, peakBand: -1, dr: 0 };
  var textAt = 0;

  /* ── loudness history: 10 samples/s for 30 s ── */
  var LOUD = 300;
  var loud = new Float32Array(LOUD), loudN = 0, loudI = 0, loudAt = 0;
  var lc = $('anLoud'), lctx = lc.getContext('2d'), lcW = 0, lcH = 0;

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    var s = sec % 60;
    return Math.floor(sec / 60) + ':' + (s < 10 ? '0' : '') + s;
  }

  function pushLoudness(now) {
    if (now - loudAt < 100) return;
    loudAt = now;
    loud[loudI] = (m.l + m.r) * 0.5;
    loudI = (loudI + 1) % LOUD;
    if (loudN < LOUD) loudN++;

    // Dynamic range over the last 10 s: peak vs. average level, as a relative dB figure.
    var n = Math.min(loudN, 100), peak = 0, sum = 0;
    for (var i = 1; i <= n; i++) {
      var v = loud[(loudI - i + LOUD) % LOUD];
      if (v > peak) peak = v;
      sum += v;
    }
    var mean = sum / Math.max(1, n);
    m.dr = n >= 30 && mean > 0.03 ? 20 * Math.log(peak / mean) / Math.LN10 : 0;
  }

  function drawLoudness() {
    if (!lcW || !lcH) return;
    lctx.clearRect(0, 0, lcW, lcH);
    if (loudN < 2) return;
    var fgS = fg[0] + ',' + fg[1] + ',' + fg[2];
    var step = lcW / (LOUD - 1), pad = Math.max(1, lcH * 0.08), usable = lcH - pad * 2;
    var x0 = (LOUD - loudN) * step, i, sum = 0;
    lctx.beginPath();
    for (i = 0; i < loudN; i++) {
      var v = loud[(loudI - loudN + i + LOUD * 2) % LOUD];
      sum += v;
      var x = x0 + i * step, y = pad + (1 - v) * usable;
      if (i === 0) lctx.moveTo(x, y); else lctx.lineTo(x, y);
    }
    lctx.lineWidth = Math.max(1, lcH * 0.04);
    lctx.lineJoin = 'round';
    lctx.strokeStyle = 'rgba(' + fgS + ',.85)';
    lctx.stroke();
    lctx.lineTo(lcW, lcH);
    lctx.lineTo(x0, lcH);
    lctx.closePath();
    lctx.fillStyle = 'rgba(' + fgS + ',.14)';
    lctx.fill();
    // Average line.
    var ay = Math.round(pad + (1 - sum / loudN) * usable);
    lctx.fillStyle = 'rgb(' + accent[0] + ',' + accent[1] + ',' + accent[2] + ')';
    for (var dx = 0; dx < lcW; dx += 8) lctx.fillRect(dx, ay, 4, 1);
  }

  function clamp01(v) { return v > 1 ? 1 : (v > 0 ? v : 0); }

  function onAudio(arr, now) {
    if (!enabled) return;
    var i, flux = 0;
    for (i = 0; i < N; i++) {
      tL[i] = clamp01(arr[i]);
      tR[i] = clamp01(arr[i + N]);
    }
    for (i = 0; i < 12; i++) {
      var v = (tL[i] + tR[i]) * 0.5;
      var d = v - prev[i];
      if (d > 0) flux += d;
      prev[i] = v;
    }

    lastAt = now;

    // Store the low-band level, at most ~80 samples/s so the ring always spans 12 s+.
    if (now - lastStoreAt >= 12) {
      var lowSum = 0;
      for (i = 0; i < 12; i++) lowSum += prev[i];
      lastStoreAt = now;
      env[envI] = lowSum;
      envT[envI] = now;
      envI = (envI + 1) % ENV;
      if (envN < ENV) envN++;
    }

    fluxAvg += (flux - fluxAvg) * 0.05;
    if (flux > fluxAvg * 1.7 + 0.03 && now - lastBeatAt > 220) { beat = 1; lastBeatAt = now; onOnset(now, flux); }

    if (now - lastColAt >= 28) { pushColumn(); lastColAt = now; }
    if (now - lastTempoAt > 1000) { lastTempoAt = now; estimateTempo(); }
  }

  /* Keeps the beat clock in step with the music: an onset close to where a beat was
     expected pulls the clock slightly towards it; a run of onsets that do not fit means
     the clock is wrong, so it starts over. Which beat is "1" cannot be known from the
     spectrum, so the beat that has carried the most low-end energy is taken as the first. */
  function onOnset(now, strength) {
    if (!bpmShown) { beatT0 = 0; return; }
    var period = 60000 / bpmShown;
    if (!beatT0) { beatT0 = now; beatMiss = 0; barAcc = [0, 0, 0, 0]; return; }
    var ph = (now - beatT0) / period, k = Math.round(ph), off = ph - k;
    if (Math.abs(off) < 0.22) {
      beatT0 += off * period * 0.3;
      beatMiss = 0;
      var idx = ((k % 4) + 4) % 4;
      for (var i = 0; i < 4; i++) barAcc[i] *= 0.97;
      barAcc[idx] += strength;
    } else if (++beatMiss > 5) { beatT0 = now; beatMiss = 0; barAcc = [0, 0, 0, 0]; }
  }

  function drawTone() {
    if (!tcW || !tcH) return;
    tctx.clearRect(0, 0, tcW, tcH);
    var i, v = new Float32Array(N), max = 0;
    for (i = 0; i < N; i++) {
      // 5-band smoothing: the curve is about the overall shape, not single bands.
      var a = 0, n = 0;
      for (var j = -2; j <= 2; j++) { var q = i + j; if (q >= 0 && q < N) { a += tone[q] * (1 + q / N * 1.6); n++; } }
      v[i] = a / n;
      if (v[i] > max) max = v[i];
    }
    if (max < 0.02) { el.tilt.textContent = '--'; return; }
    var fgS = fg[0] + ',' + fg[1] + ',' + fg[2];
    var pad = Math.max(1, tcH * 0.1), usable = tcH - pad * 2;
    // Least-squares line through the curve = the tilt (bass-heavy <-> treble-heavy).
    var sx = 0, sy = 0, sxy = 0, sxx = 0;
    tctx.beginPath();
    for (i = 0; i < N; i++) {
      var y = v[i] / max;
      sx += i; sy += y; sxy += i * y; sxx += i * i;
      var px = i / (N - 1) * tcW, py = pad + (1 - y) * usable;
      if (i === 0) tctx.moveTo(px, py); else tctx.lineTo(px, py);
    }
    tctx.lineWidth = Math.max(1, tcH * 0.06);
    tctx.lineJoin = 'round';
    tctx.strokeStyle = 'rgba(' + fgS + ',.85)';
    tctx.stroke();
    tctx.lineTo(tcW, tcH); tctx.lineTo(0, tcH); tctx.closePath();
    tctx.fillStyle = 'rgba(' + fgS + ',.12)';
    tctx.fill();
    var slope = (N * sxy - sx * sy) / (N * sxx - sx * sx), icpt = (sy - slope * sx) / N;
    tctx.strokeStyle = 'rgb(' + accent[0] + ',' + accent[1] + ',' + accent[2] + ')';
    tctx.lineWidth = Math.max(1, tcH * 0.04);
    tctx.setLineDash([Math.max(2, tcW * 0.012), Math.max(2, tcW * 0.012)]);
    tctx.beginPath();
    tctx.moveTo(0, pad + (1 - icpt) * usable);
    tctx.lineTo(tcW, pad + (1 - (icpt + slope * (N - 1))) * usable);
    tctx.stroke();
    tctx.setLineDash([]);
    var tilt = slope * (N - 1);                    // change across the whole range, -1..1
    el.tilt.textContent = "Tilt " + (tilt > 0 ? "+" : "") + Math.round(tilt * 100);
  }

  function pushColumn() {
    var w = gram.width, d = col.data;
    gctx.globalCompositeOperation = 'copy';
    gctx.drawImage(gram, -1, 0);
    gctx.globalCompositeOperation = 'source-over';
    for (var y = 0; y < N; y++) {
      var b = N - 1 - y; // low bands at the bottom
      var v = Math.pow(clamp01((tL[b] + tR[b]) * 0.5 * (1 + b / N * 1.6)), 0.75);
      var o = y * 4;
      d[o] = accent[0] + (fg[0] - accent[0]) * v;
      d[o + 1] = accent[1] + (fg[1] - accent[1]) * v;
      d[o + 2] = accent[2] + (fg[2] - accent[2]) * v;
      d[o + 3] = Math.min(255, v * 300);
    }
    gctx.putImageData(col, w - 1, 0);
  }

  /* Autocorrelation of the low-band onset envelope. The ~30 Hz frame rate limits the
   * resolution, so the result is smoothed and shown as an estimate. */
  function estimateTempo() {
    // Audio frames arrive at an uneven rate, so resample the low-band level onto a
    // uniform 50 Hz grid by timestamp, then take its rising edges as the onset envelope.
    // Uses up to 9 s of history, but starts estimating from 5 s so a value appears
    // quickly after a track change or a pause; it firms up as the window fills.
    var GRID = 0.02;
    if (envN < 100) return;
    var newest = envT[(envI - 1 + ENV) % ENV];
    var oldestIdx = (envI - envN + ENV * 2) % ENV;
    var n = Math.min(450, Math.floor((newest - envT[oldestIdx]) / (GRID * 1000)));
    if (n < 250) return;
    var dtAvg = GRID;
    var i, x = new Float32Array(n), mean = 0;
    var k = oldestIdx, left = envN, prevG = -1;
    for (i = 0; i < n; i++) {
      var tt = newest - (n - 1 - i) * GRID * 1000;
      while (left > 1 && envT[(k + 1) % ENV] <= tt) { k = (k + 1) % ENV; left--; }
      var k2 = left > 1 ? (k + 1) % ENV : k;
      var span = envT[k2] - envT[k];
      var fr = span > 0 ? Math.max(0, Math.min(1, (tt - envT[k]) / span)) : 0;
      var gv = env[k] + (env[k2] - env[k]) * fr;
      x[i] = prevG >= 0 && gv > prevG ? gv - prevG : 0;
      prevG = gv;
    }
    for (i = 0; i < n; i++) mean += x[i];
    mean /= n;
    var r0 = 0;
    for (i = 0; i < n; i++) { x[i] -= mean; r0 += x[i] * x[i]; }
    if (r0 < 1e-4) { bpmHist.length = 0; bpmShown = 0; bpmConf = 0; return; }

    var lagMin = Math.max(2, Math.floor(60 / (200 * dtAvg)));
    var lagMax = Math.min(n - 20, Math.ceil(60 / (60 * dtAvg)));
    var best = -1, bestScore = -1, rs = [];
    for (var lag = lagMin - 1; lag <= lagMax + 1; lag++) {
      var s = 0;
      for (i = lag; i < n; i++) s += x[i] * x[i - lag];
      s /= (n - lag);
      rs[lag] = s;
    }
    var r0n = r0 / n;
    for (lag = lagMin; lag <= lagMax; lag++) {
      var bpm = 60 / (lag * dtAvg);
      var o = Math.log(bpm / 120) / Math.LN2;
      var score = rs[lag] / r0n * Math.exp(-0.5 * (o / 0.8) * (o / 0.8));
      if (score > bestScore && rs[lag] >= rs[lag - 1] && rs[lag] >= rs[lag + 1]) { bestScore = score; best = lag; }
    }
    if (best < 0 || rs[best] / r0n < 0.1) { bpmConf *= 0.8; return; }   // no clear pulse right now
    // Parabolic interpolation around the peak for sub-frame lag.
    var a = rs[best - 1], b = rs[best], c = rs[best + 1];
    var den = a - 2 * b + c;
    var off = den !== 0 ? 0.5 * (a - c) / den : 0;
    var est = 60 / ((best + Math.max(-0.5, Math.min(0.5, off))) * dtAvg);
    bpmHist.push(est);
    if (bpmHist.length > 7) bpmHist.shift();
    var sorted = bpmHist.slice().sort(function (p, q) { return p - q; });
    var before = bpmShown;
    bpmShown = sorted[Math.floor(sorted.length / 2)];
    // Confidence: how closely the recent estimates agree, and how many there are yet.
    var dev = bpmHist.map(function (v) { return Math.abs(v - bpmShown); }).sort(function (p, q) { return p - q; });
    var mad = dev[Math.floor(dev.length / 2)] / bpmShown;
    bpmConf = clamp01(1 - mad / 0.04) * Math.min(1, bpmHist.length / 5);
    if (before && Math.abs(before - bpmShown) / bpmShown > 0.04) beatT0 = 0;   // tempo changed: re-lock the beat clock
  }

  function size(now) {
    if (now - sizeAt < 500) return;
    sizeAt = now;
    var dpr = window.devicePixelRatio || 1;
    var w = Math.round(sp.clientWidth * dpr), h = Math.round(sp.clientHeight * dpr);
    if (w && h && (w !== spW || h !== spH)) { sp.width = spW = w; sp.height = spH = h; }
    w = Math.round(lc.clientWidth * dpr); h = Math.round(lc.clientHeight * dpr);
    if (w && h && (w !== lcW || h !== lcH)) { lc.width = lcW = w; lc.height = lcH = h; }
    w = Math.round(tc.clientWidth * dpr); h = Math.round(tc.clientHeight * dpr);
    if (w && h && (w !== tcW || h !== tcH)) { tc.width = tcW = w; tc.height = tcH = h; }
  }

  function shape(v, i) { return Math.pow(clamp01(v * (1 + i / N * 1.6)), 0.82); }

  function drawSpectrum() {
    if (!spW || !spH) return;
    sctx.clearRect(0, 0, spW, spH);
    var mid = Math.round(spH / 2);
    var slot = spW / N;
    var bw = Math.max(1, Math.round(slot * 0.56));
    var cap = Math.max(1, Math.round(spH * 0.012));
    var fgS = fg[0] + ',' + fg[1] + ',' + fg[2];
    var acS = 'rgb(' + accent[0] + ',' + accent[1] + ',' + accent[2] + ')';
    var maxH = mid - cap - 1;

    sctx.fillStyle = 'rgba(' + fgS + ',.22)';
    sctx.fillRect(0, mid, spW, 1);

    for (var i = 0; i < N; i++) {
      var x = Math.round(i * slot + (slot - bw) / 2);
      var l = shape(L[i], i), r = shape(R[i], i);
      var hl = Math.max(1, l * maxH), hr = Math.max(1, r * maxH);
      sctx.fillStyle = 'rgba(' + fgS + ',' + (0.3 + 0.6 * l).toFixed(3) + ')';
      sctx.fillRect(x, mid - hl, bw, hl);
      sctx.fillStyle = 'rgba(' + fgS + ',' + (0.2 + 0.5 * r).toFixed(3) + ')';
      sctx.fillRect(x, mid + 1, bw, hr);

      var pl = shape(pkL[i], i) * maxH, pr = shape(pkR[i], i) * maxH;
      sctx.fillStyle = acS;
      if (pl > 2) sctx.fillRect(x, mid - pl - cap, bw, cap);
      if (pr > 2) sctx.fillRect(x, mid + 1 + pr, bw, cap);
    }

    // Dominant band marker along the top edge.
    if (m.peakBand >= 0) {
      sctx.fillStyle = acS;
      sctx.fillRect(Math.round(m.peakBand * slot), 0, Math.max(2, Math.round(slot)), Math.max(2, cap * 2));
    }
  }

  var lastFrameAt = 0;

  function frame(dt, now, pos, dur) {
    if (!enabled) return;
    // Wallpaper Engine freezes the wallpaper while another app is maximized. On resume,
    // restart the envelope (it has a hole in it) and treat the audio as fresh, so the
    // freeze is not mistaken for silence and the tempo stays on screen.
    if (lastFrameAt && now - lastFrameAt > 1500) { envN = 0; lastAt = now; }
    lastFrameAt = now;
    var silent = now - lastAt > 400;
    var up = 1 - Math.exp(-dt * 30), down = 1 - Math.exp(-dt * 8);
    var sumL = 0, sumR = 0, diff = 0, wsum = 0, low = 0, midE = 0, high = 0, i;
    var dotLR = 0, sqL = 0, sqR = 0, top = 0, topI = -1;
    var toneK = 1 - Math.exp(-dt / 10);

    for (i = 0; i < N; i++) {
      var a = silent ? 0 : tL[i], b = silent ? 0 : tR[i];
      var d = a - L[i]; L[i] += d * (d > 0 ? up : down);
      d = b - R[i]; R[i] += d * (d > 0 ? up : down);
      pkL[i] = L[i] > pkL[i] ? L[i] : Math.max(0, pkL[i] - dt * 0.35);
      pkR[i] = R[i] > pkR[i] ? R[i] : Math.max(0, pkR[i] - dt * 0.35);
      sumL += L[i]; sumR += R[i];
      diff += Math.abs(L[i] - R[i]);
      var mono = (L[i] + R[i]) * 0.5;
      dotLR += L[i] * R[i]; sqL += L[i] * L[i]; sqR += R[i] * R[i];
      if (mono > top) { top = mono; topI = i; }
      wsum += mono * i;
      if (i < 6) low += mono; else if (i < 26) midE += mono; else high += mono;
      if (!silent) tone[i] += (mono - tone[i]) * toneK;
    }

    var tot = sumL + sumR;
    var s = 1 - Math.exp(-dt * 6);
    m.l = clamp01(sumL / N * 2.4);
    m.r = clamp01(sumR / N * 2.4);
    // The meters are clamped at full scale: reaching it is as loud as this display can show.
    if (sumL / N * 2.4 >= 0.99) overL = now;
    if (sumR / N * 2.4 >= 0.99) overR = now;
    if (m.l >= m.lp) { m.lp = m.l; m.lpAt = now; } else if (now - m.lpAt > 900) m.lp = Math.max(m.l, m.lp - dt * 0.5);
    if (m.r >= m.rp) { m.rp = m.r; m.rpAt = now; } else if (now - m.rpAt > 900) m.rp = Math.max(m.r, m.rp - dt * 0.5);
    m.bal += ((tot > 0.05 ? (sumR - sumL) / tot : 0) - m.bal) * s;
    m.wid += ((tot > 0.05 ? clamp01(diff / tot * 2.5) : 0) - m.wid) * s;
    m.low += (clamp01(low / 6 * 1.4) - m.low) * s;
    m.mid += (clamp01(midE / 20 * 2.0) - m.mid) * s;
    m.high += (clamp01(high / 38 * 3.2) - m.high) * s;
    m.bright += ((tot > 0.05 ? clamp01(wsum / (tot * 0.5) / 30) : 0) - m.bright) * s;
    // Spectral similarity of the two channels (cosine): 100 = identical spectra (mono-like).
    // Not a phase correlation; phase is not available from Wallpaper Engine.
    var den = Math.sqrt(sqL * sqR);
    m.sim += ((den > 1e-4 ? dotLR / den : 0) - m.sim) * s;
    m.peakBand = top > 0.03 ? topI : -1;
    pushLoudness(now);

    el.l.style.transform = 'scaleX(' + m.l.toFixed(3) + ')';
    el.r.style.transform = 'scaleX(' + m.r.toFixed(3) + ')';
    el.lp.style.left = (m.lp * 99).toFixed(1) + '%';
    el.rp.style.left = (m.rp * 99).toFixed(1) + '%';
    el.bal.style.left = (50 + Math.max(-1, Math.min(1, m.bal * 2.5)) * 46).toFixed(1) + '%';
    el.wid.style.transform = 'scaleX(' + m.wid.toFixed(3) + ')';

    beat = Math.max(0, beat - dt * 5);
    var bi, active = -1, glow = beat;
    if (bpmShown && beatT0 && !silent) {
      var bph = (now - beatT0) / (60000 / bpmShown), bk = Math.floor(bph + 0.06);
      var first = 0;
      for (bi = 1; bi < 4; bi++) if (barAcc[bi] > barAcc[first]) first = bi;
      active = (((bk - first) % 4) + 4) % 4;
      glow = Math.max(0, 1 - (bph + 0.06 - bk) * 2.4);
    } else if (beat > 0) active = 0;       // no tempo yet: just flash on each onset
    for (bi = 0; bi < 4; bi++) el.beats[bi].style.opacity = (bi === active ? 0.25 + 0.75 * glow : 0.15).toFixed(2);

    if (now - textAt > 150) {
      textAt = now;
      el.lo.classList.toggle('on', now - overL < 1200);
      el.ro.classList.toggle('on', now - overR < 1200);
      el.dr.textContent = m.dr > 0 ? m.dr.toFixed(1) : '--';
      el.sim.textContent = tot > 0.05 ? Math.round(m.sim * 100) : '--';
      el.peak.textContent = m.peakBand >= 0 ? 'B' + (m.peakBand + 1) : '--';
      el.left.textContent = dur > 0 ? '-' + fmtTime(dur - pos) : '--';
      // A gap in the audio makes the stored envelope useless, so drop it, but keep the
      // tempo on screen: it is still right for this track. Clear it only after real silence.
      if (silent && now - lastAt > 3000) envN = 0;
      if (silent && now - lastAt > 20000) { bpmHist.length = 0; bpmShown = 0; bpmConf = 0; beatT0 = 0; }
      el.bpm.textContent = bpmShown ? Math.round(bpmShown) : '--';
      // An unsure estimate is shown dimmer instead of jumping around at full strength.
      el.bpm.style.opacity = bpmShown ? (0.45 + 0.55 * bpmConf).toFixed(2) : '1';
      el.conf.style.transform = 'scaleX(' + (bpmShown ? bpmConf : 0).toFixed(2) + ')';
    }

    size(now);
    drawSpectrum();
    drawLoudness();
    if (now - toneAt > 120) { toneAt = now; drawTone(); }
  }

  function setColors(f, a) { fg = f.map(Math.round); accent = a.map(Math.round); }
  function setEnabled(on) { enabled = !!on; sizeAt = -1e9; }
  function resetTempo() {
    bpmHist.length = 0; bpmShown = 0; bpmConf = 0; envN = 0; beatT0 = 0;
    for (var i = 0; i < N; i++) tone[i] = 0;      // a new track gets its own tonal balance
  }

  return { onAudio: onAudio, frame: frame, setColors: setColors, setEnabled: setEnabled, resetTempo: resetTempo };
})();
