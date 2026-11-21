/* Palette extraction from an album cover.
 * Colors are [r, g, b] in 0..255. Returns { bg, accents[4] }. */
window.Palette = (function () {
  'use strict';

  var SIZE = 40;
  var K = 6;
  var canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });

  var DEFAULT = {
    bg: [236, 234, 229],
    accents: [[28, 34, 48], [118, 160, 204], [240, 176, 134], [196, 202, 214]]
  };

  function lum(c) { return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
  function chroma(c) { return (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) / 255; }
  function dist(a, b) {
    var dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db) / 765; // 0..1
  }
  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function shade(c, amount) { // amount -1..1 : toward black / white
    return amount >= 0 ? mix(c, [255, 255, 255], amount) : mix(c, [0, 0, 0], -amount);
  }

  function cluster(px) {
    var n = px.length, i, j, k;
    // Deterministic farthest-point initialisation.
    var mean = [0, 0, 0];
    for (i = 0; i < n; i++) { mean[0] += px[i][0]; mean[1] += px[i][1]; mean[2] += px[i][2]; }
    mean = [mean[0] / n, mean[1] / n, mean[2] / n];
    var cents = [mean];
    var minD = new Float32Array(n);
    for (i = 0; i < n; i++) minD[i] = dist(px[i], mean);
    while (cents.length < K) {
      var best = 0, bestD = -1;
      for (i = 0; i < n; i++) if (minD[i] > bestD) { bestD = minD[i]; best = i; }
      if (bestD < 0.02) break;
      var c = px[best].slice();
      cents.push(c);
      for (i = 0; i < n; i++) { var d = dist(px[i], c); if (d < minD[i]) minD[i] = d; }
    }

    var counts = [];
    for (var iter = 0; iter < 10; iter++) {
      var sums = [];
      for (k = 0; k < cents.length; k++) { sums.push([0, 0, 0]); counts[k] = 0; }
      for (i = 0; i < n; i++) {
        var bi = 0, bd = 9;
        for (k = 0; k < cents.length; k++) {
          var dd = dist(px[i], cents[k]);
          if (dd < bd) { bd = dd; bi = k; }
        }
        sums[bi][0] += px[i][0]; sums[bi][1] += px[i][1]; sums[bi][2] += px[i][2];
        counts[bi]++;
      }
      for (k = 0; k < cents.length; k++) {
        if (counts[k]) cents[k] = [sums[k][0] / counts[k], sums[k][1] / counts[k], sums[k][2] / counts[k]];
      }
    }

    var out = [];
    for (k = 0; k < cents.length; k++) if (counts[k]) out.push({ c: cents[k], n: counts[k] });

    // Merge near-duplicates.
    for (i = 0; i < out.length; i++) {
      for (j = out.length - 1; j > i; j--) {
        if (dist(out[i].c, out[j].c) < 0.07) {
          var t = out[j].n / (out[i].n + out[j].n);
          out[i].c = mix(out[i].c, out[j].c, t);
          out[i].n += out[j].n;
          out.splice(j, 1);
        }
      }
    }
    out.sort(function (a, b) { return b.n - a.n; });
    return out;
  }

  function build(clusters, total) {
    var bg = clusters[0].c;
    var cands = [];
    for (var i = 1; i < clusters.length; i++) {
      var d = dist(bg, clusters[i].c);
      if (d < 0.1) continue;
      var share = clusters[i].n / total;
      cands.push({
        c: clusters[i].c,
        s: Math.sqrt(share) * (0.35 + chroma(clusters[i].c) * 1.6) * Math.min(1, d / 0.25)
      });
    }
    cands.sort(function (a, b) { return b.s - a.s; });
    var accents = cands.slice(0, 4).map(function (x) { return x.c; });

    var light = lum(bg) > 0.5;
    if (accents.length === 0) {
      // Monochrome cover: build tonal ribbons from the background itself.
      var dir = light ? -1 : 1;
      accents = [shade(bg, dir * 0.55), shade(bg, dir * 0.28), shade(bg, -dir * 0.3), shade(bg, dir * 0.8)];
    } else {
      var base = accents.slice();
      var steps = [0.3, -0.3, 0.5];
      var si = 0;
      while (accents.length < 4) {
        var src = base[accents.length % base.length];
        var v = shade(src, steps[si++ % steps.length]);
        if (dist(v, bg) < 0.1) v = shade(src, light ? -0.35 : 0.35);
        accents.push(v);
      }
    }
    return { bg: bg, accents: accents };
  }

  function extract(img) {
    try {
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      var data = ctx.getImageData(0, 0, SIZE, SIZE).data;
      var px = [];
      for (var i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        px.push([data[i], data[i + 1], data[i + 2]]);
      }
      if (px.length < 16) return DEFAULT;
      return build(cluster(px), px.length);
    } catch (e) {
      return DEFAULT;
    }
  }

  return { extract: extract, DEFAULT: DEFAULT, lum: lum, chroma: chroma, dist: dist, mix: mix, shade: shade };
})();
