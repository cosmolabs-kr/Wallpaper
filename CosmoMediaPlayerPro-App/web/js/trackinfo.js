/* Track details from public music catalogs, looked up by title and artist only.
 *  - iTunes Search API: release date, genre, track number, explicit flag and a 1000x1000 cover.
 *  - Deezer API: reference tempo (when Deezer has one), ReplayGain, ISRC, credits, label, release type.
 * Neither API allows cross-origin fetch, but both answer JSONP, which works from a
 * local wallpaper page. A result is only used when title and artist both match, so a
 * wrong song is very unlikely to be shown; when unsure, nothing is shown. */
window.TrackInfo = (function () {
  'use strict';

  var enabled = true;
  var onInfo = function () {};
  var getDuration = function () { return 0; };
  var cache = {};
  var reqId = 0, timer = 0, jp = 0;

  function jsonp(url, cbParam, cb) {
    var name = '__cosmoJp' + (++jp), done = false;
    var s = document.createElement('script');
    function finish(data) {
      if (done) return;
      done = true;
      clearTimeout(t);
      try { delete window[name]; } catch (e) { window[name] = undefined; }
      if (s.parentNode) s.parentNode.removeChild(s);
      cb(data || null);
    }
    var t = setTimeout(function () { finish(null); }, 8000);
    window[name] = finish;
    s.onerror = function () { finish(null); };
    s.src = url + (url.indexOf('?') < 0 ? '?' : '&') + cbParam + '=' + name;
    document.head.appendChild(s);
  }

  /* Drop decorations that catalogs do not have: (feat. ...), (Official Video), [MV], ... */
  function strip(s) {
    return String(s || '')
      .replace(/\s*[\(\[\{【][^\)\]\}】]*[\)\]\}】]/g, ' ')
      .replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, '')
      .replace(/\s+-\s+(official|lyric|lyrics|audio|video|mv|m\/v|remaster).*$/i, '')
      .replace(/\s+/g, ' ').trim();
  }
  function cleanArtist(s) {
    return strip(s).replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '').replace(/\s*official$/i, '').trim();
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }
  function close(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    var lo = Math.min(a.length, b.length), hi = Math.max(a.length, b.length);
    return lo / hi >= 0.6 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0);
  }
  function artistMatch(want, got) {
    var a = norm(want), b = norm(got);
    if (!a || !b) return false;
    // Catalog artist fields list everyone ("A & B"); the player may give only one.
    return a === b || b.indexOf(a) >= 0 || a.indexOf(b) >= 0;
  }

  /* Best candidate whose title and artist match; the length breaks ties. */
  function choose(items, title, artist, dur, getT, getA, getD) {
    var t = norm(strip(title)), best = null, bestScore = -1e9;
    (items || []).forEach(function (it) {
      var name = norm(strip(getT(it)));
      if (!close(name, t) || !artistMatch(artist, getA(it))) return;
      var score = name === t ? 20 : 0;
      var d = getD(it);
      if (dur > 0 && d > 0) {
        var diff = Math.abs(d - dur);
        // A very different length is another cut (radio edit, album version, video):
        // still the same song, so it is accepted only on an exact title, and loses
        // to any candidate of the right length.
        if (diff > 20) { if (name !== t) return; score -= 100; }
        else score -= diff;
      }
      if (score > bestScore) { bestScore = score; best = it; }
    });
    return best;
  }

  function country() {
    var m = /-([a-z]{2})$/i.exec(navigator.language || '');
    return m ? m[1].toUpperCase() : 'US';
  }

  function itunes(title, artist, dur, cb) {
    var term = encodeURIComponent(cleanArtist(artist) + ' ' + strip(title));
    var stores = [country()];
    if (stores[0] !== 'US') stores.push('US');
    (function next(i) {
      if (i >= stores.length) return cb(null);
      jsonp('https://itunes.apple.com/search?entity=song&limit=15&country=' + stores[i] + '&term=' + term, 'callback', function (d) {
        var hit = d && choose(d.results, title, cleanArtist(artist), dur,
          function (r) { return r.trackName; }, function (r) { return r.artistName; },
          function (r) { return (r.trackTimeMillis || 0) / 1000; });
        if (hit) return cb(hit);
        next(i + 1);
      });
    })(0);
  }

  function deezer(title, artist, dur, cb) {
    var a = cleanArtist(artist), t = strip(title);
    // The field search is precise but finds nothing for some names (an apostrophe, for
    // one), so a plain search follows when it comes back empty.
    var queries = ['artist:"' + a + '" track:"' + t + '"', a + ' ' + t];
    (function next(i) {
      if (i >= queries.length) return cb(null);
      jsonp('https://api.deezer.com/search?output=jsonp&limit=10&q=' + encodeURIComponent(queries[i]), 'callback', function (d) {
        var hit = d && choose(d.data, title, a, dur,
          function (r) { return r.title; }, function (r) { return r.artist && r.artist.name; },
          function (r) { return r.duration || 0; });
        if (!hit) return next(i + 1);
        // Tempo and gain are only in the full track record.
        jsonp('https://api.deezer.com/track/' + hit.id + '?output=jsonp', 'callback', function (tr) { cb(tr && !tr.error ? tr : null); });
      });
    })(0);
  }

  function lookup(title, artist, myReq, key) {
    var dur = getDuration();
    var info = null;
    function set(k, v) { if (v !== undefined && v !== null && v !== '') (info = info || {})[k] = v; }
    // Video titles are often "Artist - Title" with the channel as the artist, so the
    // title split that way is tried as a second reading.
    var tries = [[title, artist]];
    var cut = title.indexOf(' - ');
    if (cut > 0) tries.push([title.slice(cut + 3), title.slice(0, cut)]);

    function deezerFrom(list, i) {
      if (i >= list.length) return finish();
      deezer(list[i][0], list[i][1], dur, function (d) {
        if (myReq !== reqId) return;
        if (!d) return deezerFrom(list, i + 1);
        if (d.bpm > 0) set('bpm', d.bpm);
        if (typeof d.gain === 'number' && d.gain !== 0) set('gain', d.gain);
        set('isrc', d.isrc);
        if (!info || !info.date) set('date', d.release_date);
        if (d.explicit_lyrics && !(info && info.explicit)) set('explicit', true);
        // Everyone credited except the main artist(s) already on the card.
        var main = norm(d.artist && d.artist.name), seen = {};
        var feat = (d.contributors || []).map(function (c) { return c && c.name; }).filter(function (n) {
          var k = norm(n);
          if (!k || k === main || seen[k]) return false;
          seen[k] = 1;
          return true;
        });
        if (feat.length) set('feat', feat.join(', '));
        if (!d.album || !d.album.id) return finish();
        // Label and release type live in the album record.
        jsonp('https://api.deezer.com/album/' + d.album.id + '?output=jsonp', 'callback', function (al) {
          if (myReq !== reqId) return;
          if (al && !al.error) {
            set('label', al.label);
            // Only when it is the same edition iTunes found (a single vs. the album).
            if (!info || !info.tracks || al.nb_tracks === info.tracks) set('type', al.record_type);
            if (!info || !info.genre) set('genre', al.genres && al.genres.data && al.genres.data[0] && al.genres.data[0].name);
            if (!info || !info.tracks) set('tracks', al.nb_tracks);
          }
          finish();
        });
      });
    }
    function itunesFrom(i) {
      if (i >= tries.length) return deezerFrom(tries, 0);
      itunes(tries[i][0], tries[i][1], dur, function (r) {
        if (myReq !== reqId) return;
        if (!r) return itunesFrom(i + 1);
        if (r.artworkUrl100) set('cover', r.artworkUrl100.replace(/\/\d+x\d+bb\./, '/1000x1000bb.'));
        if (r.releaseDate) set('date', String(r.releaseDate).slice(0, 10));
        set('genre', r.primaryGenreName);
        set('album', r.collectionName);
        if (r.trackNumber && r.trackCount) { set('track', r.trackNumber); set('tracks', r.trackCount); }
        if (r.trackExplicitness === 'explicit') set('explicit', true);
        // Ask Deezer with the reading that matched, using the catalog's own spelling.
        deezerFrom([[r.trackName, r.artistName], tries[i]], 0);
      });
    }
    function finish() { cache[key] = info; onInfo(info, 'done'); }
    itunesFrom(0);
  }

  /* onInfo(info, state): state is 'loading', 'done' (info null = not found), 'off' or 'idle'. */
  function setTrack(title, artist) {
    clearTimeout(timer);
    var my = ++reqId;
    if (!enabled) return onInfo(null, 'off');
    if (!title) return onInfo(null, 'idle');
    var key = norm(title) + '|' + norm(artist);
    if (cache.hasOwnProperty(key)) return onInfo(cache[key], 'done');
    onInfo(null, 'loading');
    // Wait a moment: the duration arrives just after the title, and skipping through
    // tracks quickly should not send a request for each one.
    timer = setTimeout(function () { lookup(title, artist || '', my, key); }, 900);
  }

  return {
    init: function (o) { onInfo = o.onInfo || onInfo; getDuration = o.getDuration || getDuration; },
    setTrack: setTrack,
    setEnabled: function (on) { enabled = !!on; }
  };
})();
