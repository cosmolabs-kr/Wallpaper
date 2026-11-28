/* Chroma Flow — app logic: Wallpaper Engine integration, player UI, spectrum, dust, clock. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var root = document.documentElement;
  var body = document.body;
  var player = $('player');
  var IN_WE = typeof window.wallpaperRegisterAudioListener === 'function';
  // ?preview : demo laid out and paced for recording the Workshop preview GIF.
  var PREVIEW = !IN_WE && /[?&]preview/.test(location.search);
  // In preview recordings the background ignores the audio: a frame that pulses as a
  // whole with every beat cannot be stored efficiently in a GIF.
  var CALM = { bass: 0, mid: 0, high: 0, energy: 0 };

  var CLOSEUP = PREVIEW && /[?&]preview=2/.test(location.search); // card + lyrics only
  var TOGGLE = PREVIEW && /[?&]preview=3/.test(location.search);  // close-up; analyzer opens and closes
  var KEEP = PREVIEW && /[?&]preview=4/.test(location.search);    // app edition close-up: media buttons, analyzer stays
  var STRINGS = {
    en: { playing: 'Now playing', paused: 'Paused', idle: 'Idle', nothing: 'Nothing playing',
          info: 'Track info', date: 'Released', genre: 'Genre', track: 'Track', type: 'Type', label: 'Label',
          feat: 'Featuring', isrc: 'ISRC', bpm: 'Ref. tempo', gain: 'ReplayGain',
          loading: 'Looking up…', notfound: 'Not found in the music catalogs', off: 'Online track info is off',
          types: { album: 'Album', single: 'Single', ep: 'EP', compile: 'Compilation' } },
    ko: { playing: '재생 중', paused: '일시정지', idle: '대기 중', nothing: '재생 중인 음악이 없습니다',
          info: '곡 정보', date: '발매일', genre: '장르', track: '트랙', type: '형태', label: '레이블',
          feat: '참여', isrc: 'ISRC', bpm: '기준 템포', gain: '리플레이게인',
          loading: '찾는 중…', notfound: '음악 카탈로그에서 찾지 못했습니다', off: '온라인 곡 정보가 꺼져 있습니다',
          types: { album: '앨범', single: '싱글', ep: 'EP', compile: '컴필레이션' } },
    zh: { playing: '正在播放', paused: '已暂停', idle: '空闲', nothing: '当前没有播放音乐',
          info: '曲目信息', date: '发行日期', genre: '流派', track: '曲目', type: '类型', label: '厂牌',
          feat: '参与', isrc: 'ISRC', bpm: '参考节拍', gain: '回放增益',
          loading: '查找中…', notfound: '未在音乐曲库中找到', off: '在线曲目信息已关闭',
          types: { album: '专辑', single: '单曲', ep: 'EP', compile: '合辑' } }
  };
  /* 'auto' follows the Windows display language; anything not listed falls back to English. */
  function resolveLang(l) {
    if (l === 'en' || l === 'ko' || l === 'zh') return l;
    var n = PREVIEW ? 'en' : (navigator.language || '').toLowerCase();
    return n.indexOf('ko') === 0 ? 'ko' : n.indexOf('zh') === 0 ? 'zh' : 'en';
  }
  var T = STRINGS[resolveLang('auto')];

  var settings = {
    mood: 'auto', intensity: 1, speed: 1, react: 1, mouse: false,
    particles: true, clock24: true, fps: 0, autogain: true, idleDark: true,
    trackInfo: true, hdCover: true
  };

  /* ───────── Palette / theme ───────── */
  var P = window.Palette;
  var rawPalette = P.DEFAULT;

  function applyMood(p) {
    var bg = p.bg, acc = p.accents;
    var mood = settings.mood;
    // Nothing playing: there is no album to take colors from, so the user picks light or dark.
    if (mood === 'auto' && p === P.DEFAULT && settings.idleDark) mood = 'dark';
    // The character picture is dark: light glass would sit on it like a gray slab.
    if (mood === 'auto' && settings.bgMode === 'character') mood = 'dark';
    if (mood === 'light') {
      bg = P.mix(bg, [255, 255, 255], 0.8);
      if (P.lum(bg) < 0.86) bg = P.mix(bg, [255, 255, 255], 0.5);
      acc = acc.map(function (a) { return P.lum(a) > 0.8 ? P.shade(a, -0.3) : a; });
    } else if (mood === 'dark') {
      var l = Math.max(P.lum(bg), 0.02);
      var k = Math.min(1, 0.075 / l);
      bg = P.mix([bg[0] * k, bg[1] * k, bg[2] * k], [10, 11, 14], 0.35);
      acc = acc.map(function (a) { return P.lum(a) < 0.16 ? P.shade(a, 0.4) : a; });
    }
    return { bg: bg, accents: acc };
  }

  function rgbStr(c) { return Math.round(c[0]) + ', ' + Math.round(c[1]) + ', ' + Math.round(c[2]); }

  var dustTint = [255, 255, 255];

  function applyPalette(instant) {
    var p = applyMood(rawPalette);
    window.Flow.setPalette(p.bg, p.accents, instant);

    var light = P.lum(p.bg) > 0.52;
    var fg = light ? [18, 20, 24] : [246, 247, 250];
    // UI accent: the most colorful accent that still reads on the glass.
    var best = null, bestC = 0.12;
    p.accents.forEach(function (a) {
      var l = P.lum(a), c = P.chroma(a);
      if ((light ? l < 0.55 : l > 0.42) && c > bestC) { best = a; bestC = c; }
    });
    root.style.setProperty('--fg', rgbStr(fg));
    // A fixed accent chosen by the user replaces the one taken from the album.
    if (settings.accent) best = settings.accent;
    root.style.setProperty('--accent', rgbStr(best || fg));
    root.style.setProperty('--glass', light ? '255, 255, 255' : '16, 17, 21');
    root.style.setProperty('--glass-a', light ? '.46' : '.42');
    root.style.setProperty('--edge-a', light ? '.6' : '.14');
    body.style.backgroundColor = 'rgb(' + rgbStr(p.bg) + ')';
    $('lyrics').style.setProperty('--halo', light ? '255, 255, 255' : '0, 0, 0');
    window.Analyzer.setColors(fg, best || fg);
    window.Character.setAccent(best || fg);
    window.Character.setBackdrop(p.bg);
    dustTint = light ? P.mix(p.bg, [255, 255, 255], 0.85) : [255, 255, 255];
  }

  /* ───────── Media state ───────── */
  var media = { title: '', artist: '', album: '', playing: false, pos: 0, dur: 0, stamp: 0, thumb: '' };
  var titleEl = $('title'), artistEl = $('artist'), albumEl = $('album'), metaEl = $('meta');
  var statusEl = $('statusText');
  var coverA = $('coverA'), coverB = $('coverB'), coverFront = null;
  var swapTimer = 0;

  function renderStatus() {
    var has = !!media.title;
    player.classList.toggle('has-track', has);
    player.classList.toggle('is-idle', !has);
    player.classList.toggle('is-playing', has && media.playing);
    player.classList.toggle('is-paused', has && !media.playing);
    // Mirrored on <body> for things outside the player (lyrics) that follow the hide options.
    body.classList.toggle('media-idle', !has);
    body.classList.toggle('media-paused', has && !media.playing);
    statusEl.textContent = !has ? T.idle : (media.playing ? T.playing : T.paused);
  }

  function renderMeta() {
    clearTimeout(swapTimer);
    metaEl.classList.add('swap');
    swapTimer = setTimeout(function () {
      titleEl.textContent = media.title || T.nothing;
      artistEl.textContent = media.title ? media.artist : '';
      renderAlbum();
      fitTitle();
      metaEl.classList.remove('swap');
    }, 340);
  }

  /* The card widens with the title (in player units, so it is scale-independent).
   * Titles wider than the widest card fall back to two smaller lines. */
  var INFO_MIN = 16.2, INFO_MAX = 27;
  var measureEl = $('titleMeasure');
  function fitTitle() {
    var uPx = player.offsetHeight / (body.classList.contains('compact') ? 10 : 14);
    if (!uPx) return;
    var w = 0;
    if (media.title) {
      measureEl.textContent = media.title;
      w = measureEl.offsetWidth / uPx + 0.4;
    }
    player.classList.toggle('title-long', w > INFO_MAX);
    root.style.setProperty('--info-w', Math.min(INFO_MAX, Math.max(INFO_MIN, w)).toFixed(2));
  }

  function getPosition(now) {
    var pos = media.pos + (media.playing ? (now - media.stamp) / 1000 : 0);
    if (media.dur > 0 && pos > media.dur) pos = media.dur;
    return pos < 0 ? 0 : pos;
  }

  function onProperties(e) {
    e = e || {};
    var title = (e.title || '').trim();
    var artist = (e.artist || '').trim();
    var album = (e.albumTitle || '').trim();
    // Apple Music for Windows reports "Artist — Album" in the artist field.
    if (!album) {
      var cut = artist.indexOf(' — ');
      if (cut > 0) { album = artist.slice(cut + 3).trim(); artist = artist.slice(0, cut).trim(); }
    } else if (artist.length > album.length && artist.slice(-album.length) === album) {
      artist = artist.slice(0, -album.length).replace(/[\s—-]+$/, '') || artist;
    }
    var changed = title !== media.title || artist !== media.artist || album !== media.album;
    if (title !== media.title) {
      media.pos = 0; media.dur = 0; media.stamp = performance.now();
      // Some players do not send the new cover with the new title. If none has come
      // 3 s later, the catalog cover (when found) stands in for it.
      media.titleAt = performance.now();
      media.hdShown = false;
      setTimeout(maybeHd, 3100);
      if (!PREVIEW) window.Analyzer.resetTempo();
    }
    media.title = title; media.artist = artist; media.album = album;
    window.Lyrics.setTrack(title, artist);
    if (changed && !PREVIEW) window.TrackInfo.setTrack(title, artist);
    if (changed) renderMeta();
    renderStatus();
    if (!title) setThumbnail('');
  }

  function setThumbnail(src) {
    if (src && src.indexOf('data:') !== 0 && src.indexOf('file:') !== 0 && src.indexOf('http') !== 0) {
      src = 'data:image/png;base64,' + src;
    }
    if (src === media.thumb) return;
    media.thumb = src;

    if (!src) {
      if (coverFront) coverFront.classList.remove('show');
      coverFront = null;
      $('coverFillA').classList.remove('show');
      $('coverFillB').classList.remove('show');
      player.classList.remove('has-art');
      $('vinylLabel').style.backgroundImage = '';
      rawPalette = P.DEFAULT;
      applyPalette(false);
      return;
    }

    media.lowres = false;
    media.hdShown = false;
    media.thumbAt = performance.now();
    showCover(src, src, false);
  }

  /* A small or non-square cover (video thumbnails) is replaced by the catalog's 1000x1000
     cover when the catalog lookup found the same track. */
  function maybeHd() {
    var info = media.info;
    var stale = media.titleAt && (media.thumbAt || 0) < media.titleAt && performance.now() - media.titleAt > 3000;
    if (!settings.hdCover || !info || !info.cover || !(media.lowres || stale) || media.hdShown || !media.thumb) return;
    media.hdShown = true;
    showCover(info.cover, media.thumb, true, info);
  }

  function showCover(src, token, isHd, info) {
    var img = new Image();
    if (/^https?:/i.test(src)) img.crossOrigin = 'anonymous'; // keeps the canvas readable for the palette
    img.onload = function () {
      if (media.thumb !== token) return; // superseded by a newer cover
      if (isHd && media.info !== info) return;
      if (!isHd) {
        var short = Math.min(img.naturalWidth, img.naturalHeight);
        var r0 = img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
        media.lowres = short < 500 || r0 > 1.15 || r0 < 0.87;
      }
      var next = coverFront === coverA ? coverB : coverA;
      var fill = $(next === coverA ? 'coverFillA' : 'coverFillB');
      var otherFill = $(next === coverA ? 'coverFillB' : 'coverFillA');
      var ratio = img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
      var whole = ratio > 1.15 || ratio < 0.87;      // not (nearly) square: show all of it
      next.classList.toggle('fit', whole);
      fill.style.backgroundImage = whole ? 'url("' + src + '")' : '';
      fill.classList.toggle('show', whole);
      otherFill.classList.remove('show');
      next.src = src;
      next.classList.add('show');
      if (coverFront) coverFront.classList.remove('show');
      coverFront = next;
      var css = 'url("' + src + '")';
      $('ambient').style.backgroundImage = css;
      $('ipAmbient').style.backgroundImage = css;   // the info panel wears the same cover glow
      $('vinylLabel').style.backgroundImage = css;
      player.classList.add('has-art');
      rawPalette = P.extract(img);
      applyPalette(false);
      if (!isHd) maybeHd();
    };
    img.onerror = function () { if (!isHd && media.thumb === token) { media.thumb = ''; } };
    img.src = src;
  }

  function renderAlbum() { albumEl.textContent = media.title ? media.album : ''; }

  /* Track info panel: one row per value the catalogs returned. */
  var ipList = $('ipList'), ipNote = $('ipNote');
  function renderInfoPanel() {
    var i = media.info || {}, rows = [];
    function row(label, value) { if (value !== undefined && value !== null && value !== '') rows.push([label, value]); }
    row(T.date, i.date);
    row(T.genre, i.genre);
    row(T.track, i.track ? i.track + ' / ' + i.tracks : '');
    row(T.type, i.type ? (T.types[i.type] || i.type) : '');
    row(T.label, i.label);
    row(T.feat, i.feat);
    row(T.isrc, i.isrc);
    row(T.bpm, i.bpm ? Math.round(i.bpm) + ' BPM' : '');
    row(T.gain, typeof i.gain === 'number' ? (i.gain > 0 ? '+' : '') + i.gain.toFixed(1) + ' dB' : '');
    ipList.textContent = '';
    rows.forEach(function (rw) {
      var dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = rw[0];
      dd.textContent = dd.title = rw[1];
      ipList.appendChild(dt);
      ipList.appendChild(dd);
    });
    var st = media.infoState;
    ipNote.textContent = rows.length ? '' : st === 'loading' ? T.loading : st === 'off' ? T.off : st === 'done' ? T.notfound : '';
    $('ipTitle').textContent = T.info;
    $('ipExplicit').classList.toggle('on', !!i.explicit);
    // Card corner: a spinner while the catalogs are asked, then an "i" once there is
    // something to show (nothing when the track was not found).
    var btn = $('infoBtn');
    btn.classList.toggle('loading', st === 'loading');
    btn.classList.toggle('ready', rows.length > 0);
  }

  function onTrackInfo(info, state) {
    media.info = info;
    media.infoState = state;
    renderInfoPanel();
    window.Analyzer.setReference(info && info.bpm, info && info.gain);
    if (info) maybeHd();
  }

  /* Clicking the card opens or closes the info panel. The stage ignores the pointer
     (clicks have to reach the desktop), so the hit test is done by position. */
  function inPlayer(e) {
    var b = player.getBoundingClientRect();
    return e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom;
  }
  /* The panel opens on whichever side of the card has room for it (right first). */
  /* The "i" button, with a little extra room around it so it is easy to hit. It counts only
     while it is showing (there is something to open). */
  var infoBtn = $('infoBtn');
  function overInfoBtn(e) {
    if (!infoBtn.classList.contains('ready')) return false;
    var b = infoBtn.getBoundingClientRect(), pad = b.width * 0.45;
    return e.clientX >= b.left - pad && e.clientX <= b.right + pad && e.clientY >= b.top - pad && e.clientY <= b.bottom + pad;
  }
  // The stage ignores the pointer, so :hover never fires: the hover look is set from here.
  window.addEventListener('mousemove', function (e) {
    var over = !PREVIEW && !!media.title && overInfoBtn(e);
    if (over !== infoBtn.classList.contains('hover')) infoBtn.classList.toggle('hover', over);
  });
  document.addEventListener('mouseleave', function () { infoBtn.classList.remove('hover'); });

  var rigEl = $('rig'), infoEl = $('infoPanel');
  function placeInfo() {
    var b = player.getBoundingClientRect(), w = infoEl.offsetWidth, gap = b.height * 1.7 / 14;
    var left = b.right + gap + w > window.innerWidth && b.left - gap - w >= 0;
    if (left !== rigEl.classList.contains('info-left')) rigEl.classList.toggle('info-left', left);
  }

  window.addEventListener('click', function (e) {
    if (PREVIEW || !media.title) return;
    // The panel opens from the "i" button only; once open, a click anywhere on the card closes it.
    if (body.classList.contains('info-open')) { if (inPlayer(e)) body.classList.remove('info-open'); }
    else if (overInfoBtn(e)) body.classList.add('info-open');
  });

  function onThumbnail(e) { setThumbnail((e && e.thumbnail) || ''); }

  function onPlayback(e) {
    var mi = window.wallpaperMediaIntegration || {};
    var PLAYING = mi.PLAYBACK_PLAYING !== undefined ? mi.PLAYBACK_PLAYING
      : (mi.playback && mi.playback.PLAYING !== undefined ? mi.playback.PLAYING : 1);
    var was = media.playing;
    var now = performance.now();
    if (was) media.pos += (now - media.stamp) / 1000;
    media.stamp = now;
    media.playing = !!e && e.state === PLAYING;
    renderStatus();
  }

  function onTimeline(e) {
    if (!e) return;
    media.pos = Number(e.position) || 0;
    media.dur = Number(e.duration) || 0;
    media.stamp = performance.now();
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  var tCur = $('tCur'), tDur = $('tDur'), tFill = $('tFill'), lastCur = '', lastDur = '';
  function renderTimeline(now) {
    var ok = media.dur > 0 && !!media.title;
    player.classList.toggle('no-timeline', !ok);
    if (!ok) return;
    var pos = getPosition(now);
    var c = fmt(pos), d = fmt(media.dur);
    if (c !== lastCur) { tCur.textContent = lastCur = c; }
    if (d !== lastDur) { tDur.textContent = lastDur = d; }
    tFill.style.transform = 'scaleX(' + (pos / media.dur).toFixed(4) + ')';
  }

  /* ───────── Audio ───────── */
  var BANDS = 64;
  var target = new Float32Array(BANDS);
  var level = new Float32Array(BANDS);
  var audio = { bass: 0, mid: 0, high: 0, energy: 0 };
  var lastAudioAt = 0;

  /* Auto gain. Wallpaper Engine captures the audio after any software volume control
   * (Equalizer APO / Peace preamp, per-app volume, ...), so a system that sets its
   * listening level in software delivers a very small signal here. The gain follows the
   * recent peak level: quick to back off when the signal gets louder, slow (tens of
   * seconds) to rise, so it stays steady within a track. */
  var AGC_MAX = 150, AGC_TARGET = 0.85, AGC_GATE = 0.0006;
  // Start from a tiny reference: the first real signal raises it within a few frames
  // (attack is fast), so the gain is right almost immediately at any input level.
  var agcPeak = AGC_TARGET / AGC_MAX, agcAt = 0, agcLowSince = 0;
  var gained = new Float32Array(128);

  function onAudio(arr) {
    if (!arr || arr.length < 128) return;
    var now = performance.now(), i, gain = 1;
    if (settings.autogain) {
      var peak = 0;
      for (i = 0; i < 128; i++) if (arr[i] > peak) peak = arr[i];
      var dt = agcAt ? Math.min(0.2, (now - agcAt) / 1000) : 0;
      agcAt = now;
      if (peak > agcPeak) {
        agcPeak += (peak - agcPeak) * 0.35;
        agcLowSince = 0;
      } else if (peak > AGC_GATE) { // below the gate (silence) the gain is held
        // Normally the gain rises slowly. If the signal has stayed far below the
        // reference for a few seconds (start-up, or the volume was turned down),
        // catch up quickly instead of taking a minute.
        if (peak > agcPeak / 6) agcLowSince = 0;
        else if (!agcLowSince) agcLowSince = now;
        var tau = agcLowSince && now - agcLowSince > 3000 ? 1.2 : 25;
        agcPeak = Math.max(peak, agcPeak * Math.exp(-dt / tau));
      }
      gain = Math.min(AGC_MAX, AGC_TARGET / Math.max(agcPeak, 1e-5));
      if (gain < 1) gain = 1;
    }
    for (i = 0; i < 128; i++) {
      var g = arr[i] * gain;
      gained[i] = g > 1 ? 1 : (g > 0 ? g : 0);
    }
    for (i = 0; i < BANDS; i++) target[i] = (gained[i] + gained[i + 64]) * 0.5;
    lastAudioAt = now;
    window.Analyzer.onAudio(gained, now);
  }

  function avg(a, from, to) { var s = 0; for (var i = from; i < to; i++) s += a[i]; return s / (to - from); }

  function updateAudio(dt, now) {
    if (now - lastAudioAt > 400) target.fill(0);
    var up = 1 - Math.exp(-dt * 28), down = 1 - Math.exp(-dt * 7);
    for (var i = 0; i < BANDS; i++) {
      var d = target[i] - level[i];
      level[i] += d * (d > 0 ? up : down);
    }
    var r = settings.react;
    var bass = Math.min(1, avg(level, 0, 6) * 1.4 * r);
    var mid = Math.min(1, avg(level, 6, 26) * 2.0 * r);
    var high = Math.min(1, avg(level, 26, 64) * 3.2 * r);
    var s = 1 - Math.exp(-dt * 6); // extra smoothing for the shader inputs
    audio.bass += (bass - audio.bass) * s;
    audio.mid += (mid - audio.mid) * s;
    audio.high += (high - audio.high) * s;
    audio.energy += ((bass * 0.6 + mid * 0.4) - audio.energy) * (1 - Math.exp(-dt * 2));
  }

  /* ───────── Spectrum ───────── */
  var spec = $('spectrum'), sctx = spec.getContext('2d');
  var NBARS = 40, specW = 0, specH = 0;

  function sizeSpectrum() {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.round(spec.clientWidth * dpr), h = Math.round(spec.clientHeight * dpr);
    if (w && h && (w !== specW || h !== specH)) { spec.width = specW = w; spec.height = specH = h; }
  }

  /* Styles: 'bars' (bottom-aligned), 'mirror' (centered bars), 'wave' (filled curve),
     'dots' (a dot riding on each band). */
  var specVals = new Float32Array(NBARS);
  function drawSpectrum() {
    if (!specW || !specH) return;
    sctx.clearRect(0, 0, specW, specH);
    var slot = specW / NBARS;
    var bw = Math.max(1, Math.round(slot * 0.5));
    var rad = bw / 2;
    var fg = getFg();
    var style = settings.specStyle;
    var j, v, h, x, y;
    for (j = 0; j < NBARS; j++) {
      var pos = j / (NBARS - 1) * 54;
      var i0 = Math.floor(pos), fr = pos - i0;
      v = level[i0] * (1 - fr) + level[Math.min(BANDS - 1, i0 + 1)] * fr;
      specVals[j] = Math.pow(Math.min(1, v * (1 + j / NBARS * 1.6) * settings.react), 0.82);
    }
    if (style === 'wave') {
      var lw = Math.max(1, specH * 0.07), top = lw, usable = specH - lw * 1.5;
      var px = function (k) { return k / (NBARS - 1) * specW; };
      var py = function (k) { return top + (1 - specVals[k]) * usable; };
      sctx.beginPath();
      sctx.moveTo(0, py(0));
      for (j = 1; j < NBARS; j++) {
        var mx = (px(j - 1) + px(j)) / 2;
        sctx.bezierCurveTo(mx, py(j - 1), mx, py(j), px(j), py(j));
      }
      sctx.lineWidth = lw;
      sctx.lineJoin = 'round';
      sctx.strokeStyle = 'rgba(' + fg + ',.85)';
      sctx.stroke();
      sctx.lineTo(specW, specH); sctx.lineTo(0, specH); sctx.closePath();
      var g = sctx.createLinearGradient(0, 0, 0, specH);
      g.addColorStop(0, 'rgba(' + fg + ',.32)');
      g.addColorStop(1, 'rgba(' + fg + ',.04)');
      sctx.fillStyle = g;
      sctx.fill();
      return;
    }
    for (j = 0; j < NBARS; j++) {
      v = specVals[j];
      x = Math.round(j * slot + (slot - bw) / 2);
      sctx.fillStyle = 'rgba(' + fg + ',' + (0.3 + 0.6 * v).toFixed(3) + ')';
      sctx.beginPath();
      if (style === 'dots') {
        var r = Math.max(1, bw * 0.62);
        y = specH - r - v * (specH - r * 2);
        sctx.arc(x + bw / 2, y, r, 0, 6.2832);
        sctx.fill();
        continue;
      }
      h = Math.max(bw, v * specH);
      y = style === 'mirror' ? (specH - h) / 2 : specH - h;
      if (sctx.roundRect) sctx.roundRect(x, y, bw, h, rad); else sctx.rect(x, y, bw, h);
      sctx.fill();
    }
  }

  var fgCache = '', fgAt = -1e9;
  function getFg() {
    var now = performance.now();
    if (now - fgAt > 500) { fgCache = getComputedStyle(root).getPropertyValue('--fg').trim() || '20,20,20'; fgAt = now; }
    return fgCache;
  }

  /* ───────── Dust ───────── */
  var dust = $('dust'), dctx = dust.getContext('2d');
  var motes = [], sprite = null, spriteTint = '';

  function sizeDust() {
    dust.width = Math.round(window.innerWidth / 2);
    dust.height = Math.round(window.innerHeight / 2);
    if (!motes.length) {
      for (var i = 0; i < 46; i++) {
        motes.push({
          x: Math.random(), y: Math.random(),
          r: 0.0025 + Math.random() * 0.007,
          vx: (Math.random() - 0.5) * 0.004, vy: -(0.003 + Math.random() * 0.01),
          ph: Math.random() * 6.28, a: 0.12 + Math.random() * 0.3
        });
      }
    }
  }

  function makeSprite() {
    var key = rgbStr(dustTint);
    if (sprite && key === spriteTint) return;
    spriteTint = key;
    sprite = document.createElement('canvas');
    sprite.width = sprite.height = 64;
    var c = sprite.getContext('2d');
    var g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(' + key + ',1)');
    g.addColorStop(0.35, 'rgba(' + key + ',.55)');
    g.addColorStop(1, 'rgba(' + key + ',0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
  }

  function drawDust(dt, t) {
    if (!settings.particles) return;
    makeSprite();
    var w = dust.width, h = dust.height;
    dctx.clearRect(0, 0, w, h);
    var boost = 1 + audio.energy * 2.5;
    for (var i = 0; i < motes.length; i++) {
      var m = motes[i];
      m.x += (m.vx + Math.sin(t * 0.3 + m.ph) * 0.003) * dt * boost;
      m.y += m.vy * dt * boost;
      if (m.y < -0.05) { m.y = 1.05; m.x = Math.random(); }
      if (m.x < -0.05) m.x = 1.05; else if (m.x > 1.05) m.x = -0.05;
      var size = m.r * h * 2 * (1 + audio.high * 0.5);
      dctx.globalAlpha = m.a * (0.6 + 0.4 * Math.sin(t * 0.9 + m.ph * 3)) * (0.75 + audio.high * 0.6);
      dctx.drawImage(sprite, m.x * w - size, m.y * h - size, size * 2, size * 2);
    }
    dctx.globalAlpha = 1;
  }

  /* ───────── Clock ───────── */
  var clockTime = $('clockTime'), clockDate = $('clockDate'), lastClock = '';
  var dateFmt;
  function setDateLocale(loc) {
    try { dateFmt = new Intl.DateTimeFormat(loc || 'en', { weekday: 'long', month: 'long', day: 'numeric' }); }
    catch (e) { dateFmt = null; }
  }
  setDateLocale(navigator.language);

  /* Language of the few words on screen and of the date: 'auto' | 'en' | 'ko' | 'zh'. */
  window.cosmoSetLanguage = function (l) {
    var lang = resolveLang(l);
    T = STRINGS[lang];
    setDateLocale(l === 'auto' || !l ? navigator.language : { en: 'en-US', ko: 'ko-KR', zh: 'zh-CN' }[lang]);
    lastClock = '';
    renderStatus();
    if (!media.title) titleEl.textContent = T.nothing;
    renderInfoPanel();
  };

  function renderClock() {
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    if (!settings.clock24) h = h % 12 || 12;
    var s = (settings.clock24 && h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    var key = s + d.getDate();
    if (key === lastClock) return;
    lastClock = key;
    clockTime.textContent = s;
    clockDate.textContent = dateFmt ? dateFmt.format(d) : d.toDateString();
  }

  /* ───────── Wallpaper Engine properties ───────── */
  function num(p, fallback) { var n = Number(p.value); return isFinite(n) ? n : fallback; }
  function bool(p) { return p.value === true || p.value === 'true' || p.value === 1; }

  /* The user's own picture as the background: a file path (web edition, from Wallpaper
     Engine) or a URL (app edition, from the host program); empty when cleared.
     The silk shader stops while a picture is shown. */
  function setBackgroundImage(value) {
    var el = $('bgImage');
    var path = value ? String(value) : '';
    if (!path) { settings.bgImage = false; body.classList.remove('has-bgimage'); return; }
    var url = /^(file|https?|data):/i.test(path) ? path : 'file:///' + path.split('\\').join('/');
    var img = new Image();
    img.onload = function () {
      el.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
      settings.bgImage = true;
      body.classList.add('has-bgimage');
    };
    img.onerror = function () { settings.bgImage = false; body.classList.remove('has-bgimage'); };
    img.src = url;
  }

  window.wallpaperPropertyListener = {
    applyUserProperties: function (p) {
      if (p.language) window.cosmoSetLanguage(String(p.language.value));
      if (p.colormood) { settings.mood = String(p.colormood.value); applyPalette(false); }
      if (p.flowintensity) settings.intensity = num(p.flowintensity, 100) / 100;
      if (p.flowspeed) settings.speed = num(p.flowspeed, 100) / 100;
      if (p.audioreact) settings.react = num(p.audioreact, 100) / 100;
      if (p.autogain) settings.autogain = bool(p.autogain);
      if (p.mouseinteract) settings.mouse = bool(p.mouseinteract);
      if (p.quality) window.Flow.setQuality(num(p.quality, 0.5));
      if (p.particles) {
        settings.particles = bool(p.particles);
        body.classList.toggle('no-dust', !settings.particles);
      }
      if (p.playerscale) root.style.setProperty('--scale', String(num(p.playerscale, 100) / 100));
      if (p.playerx) root.style.setProperty('--px', String(num(p.playerx, 50)));
      if (p.playery) root.style.setProperty('--py', String(num(p.playery, 50)));
      if (p.idletheme) { settings.idleDark = String(p.idletheme.value) === 'dark'; applyPalette(false); }
      if (p.bgimage) setBackgroundImage(p.bgimage.value);
      if (p.bgdim) $('bgImage').style.setProperty('--dim', String(num(p.bgdim, 25) / 100));
      if (p.bgblur) $('bgImage').style.setProperty('--blur', num(p.bgblur, 0) + 'px');
      if (p.glassblur) body.classList.toggle('no-blur', !bool(p.glassblur));
      if (p.showspectrum) body.classList.toggle('hide-spectrum', !bool(p.showspectrum));
      if (p.spectrumstyle) settings.specStyle = String(p.spectrumstyle.value || 'bars');
      if (p.fixedaccent) settings.fixedAccent = bool(p.fixedaccent);
      if (p.accentcolor) settings.accentRaw = String(p.accentcolor.value || '');
      if (p.fixedaccent || p.accentcolor) {
        // Wallpaper Engine colors are "r g b" with each part 0..1.
        var ac = (settings.accentRaw || '').split(/\s+/).map(Number);
        settings.accent = settings.fixedAccent && ac.length >= 3 && ac.every(isFinite)
          ? ac.slice(0, 3).map(function (c) { return Math.max(0, Math.min(255, c * 255)); }) : null;
        applyPalette(false);
      }
      if (p.playerstyle || p.showvinyl) {
        if (p.playerstyle) settings.compact = String(p.playerstyle.value) === 'compact';
        if (p.showvinyl) settings.vinyl = bool(p.showvinyl);
        body.classList.toggle('compact', !!settings.compact);
        body.classList.toggle('no-vinyl', !settings.compact && settings.vinyl === false);
        specW = specH = 0;
        fitTitle();
      }
      if (p.trackinfo) {
        settings.trackInfo = bool(p.trackinfo);
        window.TrackInfo.setEnabled(settings.trackInfo);
        // Turning it on looks up the current track; off clears what is shown.
        window.TrackInfo.setTrack(settings.trackInfo ? media.title : '', media.artist);
      }
      if (p.hdcover) { settings.hdCover = bool(p.hdcover); maybeHd(); }
      if (p.bgmode) {
        settings.bgMode = String(p.bgmode.value || 'silk');
        body.classList.toggle('bg-character', settings.bgMode === 'character');
        applyPalette(false);
      }
      if (p.charwind) window.Character.setOptions({ wind: (parseFloat(p.charwind.value) || 0) / 100 });
      // Saved values from before this was a slider are true/false.
      if (p.charlight) window.Character.setOptions({ light: typeof p.charlight.value === 'boolean' ? (p.charlight.value ? 1 : 0) : (parseFloat(p.charlight.value) || 0) / 100 });
      if (p.charnod) window.Character.setOptions({ nod: (parseFloat(p.charnod.value) || 0) / 100 });
      if (p.charblink) window.Character.setOptions({ blink: bool(p.charblink) });
      if (p.chareq) window.Character.setOptions({ eq: bool(p.chareq) });
      if (p.analyzerlayout) $('analyzer').setAttribute('data-layout', String(p.analyzerlayout.value || 'full'));
      if (p.showtimeline) body.classList.toggle('hide-timeline', !bool(p.showtimeline));
      if (p.hideidle) settings.hideIdle = bool(p.hideidle);
      if (p.hidepaused) settings.hidePaused = bool(p.hidepaused);
      if (p.hideidle || p.hidepaused) {
        body.classList.toggle('hide-idle', !!settings.hideIdle);
        body.classList.toggle('hide-paused', !!settings.hideIdle && !!settings.hidePaused);
      }
      if (p.showclock) body.classList.toggle('hide-clock', !bool(p.showclock));
      if (p.clock24h) { settings.clock24 = bool(p.clock24h); lastClock = ''; }
      var clockEl = $('clock');
      if (p.clockx) {
        var cx = num(p.clockx, 100);
        clockEl.style.setProperty('--cx', String(cx / 100));
        clockEl.classList.toggle('align-left', cx < 34);
        clockEl.classList.toggle('align-center', cx >= 34 && cx <= 66);
      }
      if (p.clocky) clockEl.style.setProperty('--cy', String(num(p.clocky, 100) / 100));
      if (p.clocksize) clockEl.style.setProperty('--cs', String(num(p.clocksize, 100) / 100));
      if (p.clockfont) clockEl.setAttribute('data-font', String(p.clockfont.value || 'default'));
      if (p.clockglass) body.classList.toggle('clock-glass', bool(p.clockglass));
      if (p.analyzer) {
        var on = bool(p.analyzer);
        body.classList.toggle('hide-analyzer', !on);
        window.Analyzer.setEnabled(on);
      }
      if (p.lyrics) {
        var ly = bool(p.lyrics);
        body.classList.toggle('hide-lyrics', !ly);
        window.Lyrics.setEnabled(ly);
      }
      if (p.lyricsoffset) window.Lyrics.setOffset(num(p.lyricsoffset, 0));
      if (p.lyricsy) $('lyrics').style.setProperty('--ly', String(num(p.lyricsy, 84)));
      if (p.lyricssize) $('lyrics').style.setProperty('--ls', String(num(p.lyricssize, 100) / 100));
    },
    applyGeneralProperties: function (p) {
      if (p.fps) settings.fps = Number(p.fps) || 0;
    }
  };

  /* ───────── Main loop ───────── */
  var hasGL = window.Flow.init($('bg'));
  if (!hasGL) $('bg').style.display = 'none';
  var hasChar = window.Character.init($('charBg'));

  function onResize() { sizeDust(); specW = specH = 0; }
  window.addEventListener('resize', onResize);
  sizeDust();

  var lastFrame = performance.now(), sizeCheck = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    var elapsed = now - lastFrame;
    if (settings.fps > 0 && elapsed < 1000 / settings.fps - 1) return;
    lastFrame = now;
    var dt = Math.min(0.1, elapsed / 1000);

    if (demo) demo.tick(now);
    updateAudio(dt, now);
    var charMode = settings.bgMode === 'character' && hasChar && !settings.bgImage;
    // In character mode the silk still runs: it is the backdrop the picture fades into.
    if (hasGL && !settings.bgImage) window.Flow.frame(dt, PREVIEW ? CALM : audio, settings);
    if (charMode) window.Character.frame(dt, audio, window.Analyzer.getBeat(now), { flow: settings.intensity, speed: settings.speed, bands: level });
    drawDust(dt, now / 1000);
    if (now - sizeCheck > 500) { sizeSpectrum(); placeInfo(); sizeCheck = now; }
    drawSpectrum();
    var pos = getPosition(now);
    window.Analyzer.frame(dt, now, pos, media.title ? media.dur : 0);
    window.Lyrics.frame(pos);
    renderTimeline(now);
    renderClock();
  }

  /* ───────── Demo mode (plain browser, outside Wallpaper Engine) ───────── */
  var demo = null;
  // ?director : no built-in demo; a recording script drives everything through window.__cosmoDemo
  // (used by tools/record-thumb.js to make the Workshop thumbnail).
  if (!IN_WE) {
    if (/[?&]director/.test(location.search)) {
      window.__cosmoDemo = { properties: onProperties, thumbnail: onThumbnail, timeline: onTimeline, playback: onPlayback,
        audio: onAudio, settings: settings };
    } else demo = makeDemo();
  }

  function makeDemo() {
    // Outside Wallpaper Engine only: lets a test drive the media inputs directly.
    window.__cosmoDemo = { properties: onProperties, thumbnail: onThumbnail, timeline: onTimeline, playback: onPlayback };
    var tracks = [
      { title: 'Paper Moon', artist: 'Demo Artist', album: 'White Room', dur: 214,
        cols: ['#f2f1ee', '#4f7fb5', '#15171c', '#eeb08a'],
        lines: ['Paper moon above the bay', 'Hold the light a little longer'] },
      { title: '한밤의 드라이브 (Midnight Drive)', pt: 'Midnight Drive', artist: '데모 아티스트', album: 'Neon Avenue', dur: 187,
        cols: ['#151030', '#e0458f', '#f59a3c', '#5b4bd6'],
        lines: ['City lights are running low', 'Drive until the morning shows'] },
      { title: 'Low Tide', artist: 'Demo Artist — Salt & Cedar', album: '', dur: 251,
        cols: ['#0f5c5a', '#f1e6cf', '#f0785a', '#0a2f33'],
        lines: ['Salt and cedar on the wind', 'Let the tide come rolling in'] },
      { title: 'Signal Red', artist: 'Demo Artist', album: 'Primary', dur: 163,
        cols: ['#d4372c', '#f4c531', '#1b2550', '#f6efe2'],
        lines: ['Paint it loud in signal red', 'Every word we never said'] }
    ];
    var idx = -1, startedAt = 0, playing = true;
    var HOLD = PREVIEW ? 2500 : 30000;
    // ?level=0.02 simulates a system whose volume is turned down in software.
    var lvMatch = /[?&]level=([\d.]+)/.exec(location.search);
    var DEMO_LEVEL = lvMatch ? parseFloat(lvMatch[1]) : 1;

    if (PREVIEW) {
      settings.grain = 0; // film grain compresses badly in a GIF
      // Thumbnail-only resolution badge (never shown in the real wallpaper).
      var badge = document.createElement('div');
      badge.textContent = '4K';
      badge.style.cssText = 'position:fixed;top:calc(3.2*var(--b));right:calc(3.2*var(--b));z-index:9;' +
        'padding:calc(.2*var(--b)) calc(1.7*var(--b)) calc(.5*var(--b));border-radius:calc(1.8*var(--b));' +
        'background:rgba(12,12,15,.9);border:calc(.45*var(--b)) solid #fff;color:#fff;' +
        'font-size:calc(7.4*var(--b));font-weight:800;line-height:1.1;letter-spacing:-.02em;' +
        'box-shadow:0 calc(.6*var(--b)) calc(2*var(--b)) rgba(0,0,0,.35)';
      body.appendChild(badge);
      if (KEEP) body.classList.add('app');   // show the app edition's media buttons
      window.Flow.setFade(0.6);
      window.wallpaperPropertyListener.applyUserProperties((TOGGLE || KEEP) ? {
        playerscale: { value: 205 }, playery: { value: 42 }, quality: { value: '1' },
        flowspeed: { value: 25 },
        particles: { value: false }, showclock: { value: false },
        lyricssize: { value: 210 }, lyricsy: { value: 88 }
      } : CLOSEUP ? {
        playerscale: { value: 225 }, playery: { value: 40 }, quality: { value: '1' },
        flowspeed: { value: 25 }, analyzer: { value: false },
        particles: { value: false }, showclock: { value: false },
        lyricssize: { value: 230 }, lyricsy: { value: 80 }
      } : {
        playerscale: { value: 220 }, playery: { value: 41 }, quality: { value: '1' },
        flowspeed: { value: 25 }, // a slow background keeps frame-to-frame changes (and the GIF) small
        particles: { value: false }, showclock: { value: false },
        lyricssize: { value: 190 }, lyricsy: { value: 87 }
      });
    }

    function cover(cols) {
      var c = document.createElement('canvas');
      c.width = c.height = 320;
      var x = c.getContext('2d');
      x.fillStyle = cols[0]; x.fillRect(0, 0, 320, 320);
      x.fillStyle = cols[1]; x.beginPath(); x.arc(205, 130, 92, 0, 6.3); x.fill();
      x.fillStyle = cols[2]; x.beginPath(); x.moveTo(30, 300); x.lineTo(150, 120); x.lineTo(215, 300); x.fill();
      x.fillStyle = cols[3]; x.beginPath(); x.arc(95, 95, 38, 0, 6.3); x.fill();
      return c.toDataURL('image/png');
    }

    function next() {
      idx = (idx + 1) % tracks.length;
      var t = tracks[idx];
      startedAt = performance.now();
      window.__trackIndex = idx;
      // Only the CSS class is toggled here, so the analyzer keeps measuring while hidden
      // and has its tempo and history ready the moment it opens.
      // Open during tracks 0-1; the recorder starts on track 1, so the loop begins fully open.
      if (TOGGLE) body.classList.toggle('hide-analyzer', !(idx === 0 || idx === 1));
      var at = PREVIEW ? 62 : 0;
      onProperties({
        title: (PREVIEW && t.pt) || t.title,
        artist: PREVIEW ? t.artist.replace('데모 아티스트', 'Demo Artist') : t.artist,
        albumTitle: t.album
      });
      onThumbnail({ thumbnail: cover(t.cols) });
      onTimeline({ position: at, duration: t.dur });
      onPlayback({ state: playing ? 1 : 2 });
      // Placeholder lines so the karaoke display can be checked without a real song.
      var demoLines = [];
      for (var n = 0; n < 40; n++) {
        demoLines.push(PREVIEW
          ? { t: at + 0.1 + n * 1.25, text: t.lines[n % 2] }
          : { t: 1.5 + n * 3.5, text: n % 6 === 5 ? '' : 'Demo lyric line ' + (n + 1) + ' — sung in time with the track' });
      }
      window.Lyrics.setLines(demoLines);
    }

    window.addEventListener('keydown', function (e) {
      if (e.code === 'Space') { playing = !playing; onPlayback({ state: playing ? 1 : 2 }); }
      else if (e.code === 'ArrowRight') next();
      else if (e.code === 'KeyI') { onProperties({}); onPlayback({ state: 0 }); }
      else if (e.code === 'KeyM') {
        settings.mood = settings.mood === 'auto' ? 'light' : settings.mood === 'light' ? 'dark' : 'auto';
        applyPalette(false);
      }
    });
    if (!PREVIEW) window.addEventListener('click', function (e) { if (!inPlayer(e)) next(); });

    var fake = new Float32Array(128);
    setTimeout(next, 50);
    return {
      tick: function (now) {
        var t = now / 1000;
        if (!playing || !media.title) return;
        var beat = Math.pow(0.5 + 0.5 * Math.sin(t * 6.283 * 1.9), 6);
        for (var i = 0; i < 64; i++) {
          var v = Math.exp(-i / 20) * (0.25 + 0.75 * beat) * 0.85
            + 0.2 * Math.exp(-i / 45) * (0.5 + 0.5 * Math.sin(t * 5.1 + i * 0.6))
            + 0.1 * Math.random() * Math.exp(-i / 50);
          var pan = 0.25 * Math.sin(t * 0.7 + i * 0.15);
          fake[i] = v * (1 - pan) * DEMO_LEVEL;
          fake[i + 64] = v * (1 + pan) * DEMO_LEVEL;
        }
        onAudio(fake);
        if (now - startedAt > HOLD) next();
      }
    };
  }

  if (!IN_WE && /[?&]char/.test(location.search)) window.wallpaperPropertyListener.applyUserProperties({ bgmode: { value: 'character' } });

  /* ───────── Boot ───────── */
  window.Lyrics.init({ getDuration: function () { return media.dur; } });
  window.TrackInfo.init({ onInfo: onTrackInfo, getDuration: function () { return media.dur; } });
  titleEl.textContent = T.nothing;
  renderStatus();
  applyPalette(true);
  renderClock();

  if (IN_WE) {
    window.wallpaperRegisterAudioListener(onAudio);
    if (window.wallpaperRegisterMediaPropertiesListener) window.wallpaperRegisterMediaPropertiesListener(onProperties);
    if (window.wallpaperRegisterMediaThumbnailListener) window.wallpaperRegisterMediaThumbnailListener(onThumbnail);
    if (window.wallpaperRegisterMediaPlaybackListener) window.wallpaperRegisterMediaPlaybackListener(onPlayback);
    if (window.wallpaperRegisterMediaTimelineListener) window.wallpaperRegisterMediaTimelineListener(onTimeline);
  }

  requestAnimationFrame(loop);
})();
