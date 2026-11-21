/* Karaoke-style synced lyrics.
 * Wallpaper Engine has no lyrics API, so line-synced lyrics (LRC) are looked up on
 * LRCLIB (https://lrclib.net), a free public lyrics database. Only the track title and
 * artist are sent. Lines advance with the playback position; the sweep inside a line is
 * interpolated between two line timestamps (LRCLIB data is line-synced, not word-synced). */
window.Lyrics = (function () {
  'use strict';

  var API = 'https://lrclib.net/api/search';
  var box = document.getElementById('lyrics');
  var curEl = document.getElementById('lyCur');
  var nextEl = document.getElementById('lyNext');

  var enabled = true;
  var offset = 0;            // seconds; positive = lyrics appear earlier
  var getDuration = function () { return 0; };

  var lines = null;          // [{ t, text }]
  var idx = -2;
  var key = '';
  var cache = {};
  var timer = 0, reqId = 0, swapTimer = 0;

  function parse(lrc) {
    var out = [];
    String(lrc || '').split(/\r?\n/).forEach(function (row) {
      var re = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g, m, times = [], last = 0;
      while ((m = re.exec(row))) {
        times.push(parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.')));
        last = re.lastIndex;
      }
      if (!times.length) return;
      var text = row.slice(last).replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();
      times.forEach(function (t) { out.push({ t: t, text: text }); });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out.length >= 3 ? out : null;
  }

  function simplify(s) {
    return s
      .replace(/\s*[\(\[][^\)\]]*(feat|ft\.|with |remaster|version|edit|live|bonus|deluxe|mix|from )[^\)\]]*[\)\]]/ig, '')
      .replace(/\s+-\s+[^-]*(remaster|version|edit|single|live|mix)[^-]*$/i, '')
      .trim();
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }

  function pick(items, title, dur) {
    var want = norm(title), best = null, bestScore = -1e9;
    (items || []).forEach(function (it) {
      if (!it || !it.syncedLyrics) return;
      var score = 0;
      var name = norm(it.trackName);
      if (name === want) score += 50; else if (name.indexOf(want) >= 0 || want.indexOf(name) >= 0) score += 20;
      if (dur > 0 && it.duration > 0) {
        var d = Math.abs(it.duration - dur);
        if (d > 12) return;           // a different cut: its timing would be wrong
        score -= d * 4;
      }
      if (score > bestScore) { bestScore = score; best = it; }
    });
    return best;
  }

  function query(title, artist, cb) {
    var url = API + '?track_name=' + encodeURIComponent(title) + '&artist_name=' + encodeURIComponent(artist);
    fetch(url).then(function (r) { return r.ok ? r.json() : []; }).then(cb).catch(function () { cb([]); });
  }

  function lookup(title, artist, myReq, myKey) {
    var dur = getDuration();
    function done(found) {
      if (myReq !== reqId) return;
      cache[myKey] = found;
      apply(found);
    }
    query(title, artist, function (items) {
      if (myReq !== reqId) return;
      var hit = pick(items, title, dur);
      if (hit) return done(parse(hit.syncedLyrics));
      var t2 = simplify(title);
      if (t2 && t2 !== title) {
        query(t2, artist, function (items2) {
          var hit2 = pick(items2, t2, dur);
          done(hit2 ? parse(hit2.syncedLyrics) : null);
        });
      } else done(null);
    });
  }

  function apply(found) {
    lines = found || null;
    idx = -2;
    if (!lines) hide();
  }

  function hide() {
    box.classList.remove('on');
  }

  function clear() {
    clearTimeout(timer);
    reqId++;
    lines = null;
    idx = -2;
    hide();
  }

  function setTrack(title, artist) {
    var k = (title || '') + '\n' + (artist || '');
    if (k === key) return;
    key = k;
    clear();
    if (!enabled || !title) return;
    if (cache.hasOwnProperty(k)) { apply(cache[k]); return; }
    var myReq = reqId;
    // Short delay: skips tracks the user flips past and lets the duration arrive first.
    timer = setTimeout(function () { lookup(title, artist, myReq, k); }, 900);
  }

  /* Direct injection (demo mode / tests). lineList: [{ t, text }] */
  function setLines(lineList) {
    clearTimeout(timer);
    reqId++;
    apply(lineList);
  }

  function nextText(i) {
    for (var j = i + 1; j < lines.length; j++) if (lines[j].text) return lines[j].text;
    return '';
  }

  function show(i) {
    var text = i >= 0 ? lines[i].text : '';
    clearTimeout(swapTimer);
    curEl.classList.add('swap');
    swapTimer = setTimeout(function () {
      curEl.textContent = text || '♪';
      curEl.style.setProperty('--p', '0%');
      nextEl.textContent = nextText(i);
      curEl.classList.remove('swap');
    }, 200);
    box.classList.add('on');
  }

  function frame(pos) {
    if (!enabled || !lines) return;
    var t = pos + offset;
    var i = idx < -1 ? -1 : idx;
    if (i >= 0 && lines[i].t > t) i = -1;                 // seek backwards
    while (i + 1 < lines.length && lines[i + 1].t <= t) i++;
    if (i !== idx) { idx = i; show(i); }

    if (i >= 0 && lines[i].text && !curEl.classList.contains('swap')) {
      var end = i + 1 < lines.length ? lines[i + 1].t : lines[i].t + 5;
      // Sing the line over its own span, capped so a long instrumental gap does not slow the sweep.
      var span = Math.min(end - lines[i].t, Math.max(2.5, lines[i].text.length * 0.22));
      var p = Math.max(0, Math.min(1, (t - lines[i].t) / (span * 0.92)));
      curEl.style.setProperty('--p', (p * 103 - 3).toFixed(1) + '%');
    }
    // Past the last line for a while: fade out.
    if (i === lines.length - 1 && t - lines[i].t > 12) hide();
  }

  function setEnabled(on) {
    on = !!on;
    if (on === enabled) return;
    enabled = on;
    var k = key;
    key = '';
    clear();
    if (on && k) { var parts = k.split('\n'); setTrack(parts[0], parts[1]); }
  }

  return {
    setTrack: setTrack, setLines: setLines, frame: frame, setEnabled: setEnabled,
    setOffset: function (s) { offset = Number(s) || 0; },
    init: function (o) { if (o && o.getDuration) getDuration = o.getDuration; }
  };
})();
