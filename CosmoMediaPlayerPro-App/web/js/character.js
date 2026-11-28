/* Character background.
 *
 * The picture (img/character.webp, with transparency) is prepared offline: the original
 * illustration was extended to the left with its own image model (tools/outpaint) and cut
 * out with a segmentation model plus alpha matting (tools/matting). It is drawn as it is,
 * as tall as the screen, on the right edge, over the silk background.
 *
 * Wind. Hair and veil sway as if in a breeze; hands, arm, face, clothes and headset never
 * move. The picture is sampled at slightly shifted positions, and img/motion.png (made by
 * tools/motion) says where and how: for every pixel a sway vector that is exactly zero on
 * the rigid parts (cut out by a segmentation model) and fades in around them, and the
 * distance from the head along the hair. Waves of three sizes travel outward along that
 * distance, across the strands, with slow gusts and lock-to-lock differences from noise,
 * so the motion never repeats exactly. The shift near a rigid part is always smaller than
 * the distance to it, so the body's outline is never smeared.
 *
 * Listening. While music plays she closes her eyes for long stretches (12 to 22 s) and only
 * then nods to the beat; in between the eyes open for a few seconds and the head is still.
 * With music playing the eyes are closed for more than 80 % of the time.
 *
 * Nod. On the beat the head tips forward a little and settles back, as if listening along.
 * The picture is in two layers for this: img/character_arm.webp (hand, bracelet, arm) is
 * drawn last and never moves; img/character.webp is the picture without the arm, so the
 * head can turn underneath the hand. How much each pixel follows the head is the head
 * weight in the motion map: 1 on the head, 0 on the body, a smooth blend through the neck
 * and the hair near the head. The head turns about a point in the upper neck.
 *
 * Blink. While the eyes are open, every few seconds the eye closes and opens. The closed eye is its own small picture
 * (img/character_eye.png), painted by the illustration's model and color-matched to the skin;
 * the lid comes down as a soft line sweeping over the eye, in about a quarter of a second.
 *
 * Two music effects are added on top, both tinted with the album color:
 *
 * 1. Beat light. On every beat the picture's own highlights flare and throw a soft glow.
 *    Where the light lands is decided by the picture's brightness alone (veil, sleeves,
 *    hair shine), never by hand-drawn regions, so it cannot light "half a sleeve" or put
 *    a patch on skin: dark areas simply stay as they are.
 *
 * 2. Headphone equalizer. The ear cup's inner disc is plain dark in the picture (its emblem
 *    was removed for this). A small bar display is drawn there, tilted with the headset,
 *    and its light is picked up by the glossy rim around it. */
window.Character = (function () {
  'use strict';

  var IMG_W = 1748, IMG_H = 2000;     // the illustration, extended 380 px to the left
  // Inner disc of the ear cup, measured in the picture (center, radius in picture pixels),
  // and how far the headset leans (the band leaves the cup toward the upper right).
  var EQ_X = 1165.5, EQ_Y = 397.0, EQ_R = 55.0, EQ_TILT = 0.52;
  var NB = 7;                          // bars
  // Motion map (img/motion.png): one panel's size, the scale of its distance values, and
  // how far free hair sways at full strength (picture px; the picture is 2000 px tall).
  var MAP_W = 874, MAP_H = 1000, U_MAX = 2200, WIND_AMP = 20;
  // Nod: the point the head turns about (upper neck, picture px) and the largest angle (radians).
  var NOD_PIVOT = [1210, 700], NOD_MAX = 0.026;
  // Blink: where the closed-eye patch sits in the picture (x, y, w, h).
  var EYE_BOX = [1358, 482, 136, 176];
  // Which analyzer bands (of 64) feed each bar: narrow at the bass end, wide at the top.
  var EDGES = [0, 2, 4, 7, 11, 17, 26, 40];

  var VERT = '#version 300 es\nin vec2 aPos;\nvoid main(){ gl_Position = vec4(aPos, 0.0, 1.0); }\n';
  var FRAG = [
    '#version 300 es',
    'precision highp float;',
    'uniform vec2 uRes;',
    'uniform vec4 uRect;',          // picture on screen: x, y (top-left), w, h in pixels
    'uniform sampler2D uTex;',      // premultiplied alpha
    'uniform vec3 uAccent;',        // album color, 0..1
    'uniform float uPulse;',        // beat light, 0..1
    'uniform float uLight;',        // beat light on/off (0 or 1, eased)
    'uniform float uEq;',           // equalizer on/off (0 or 1, eased)
    'uniform float uEnergy;',       // overall level, 0..1
    'uniform float uBars[' + NB + '];',
    'uniform sampler2D uMap;',      // motion map: two panels side by side (see tools/motion/build_map.py)
    'uniform float uTime;',         // seconds
    'uniform float uWind;',         // wind strength, 0 = still
    'uniform sampler2D uArm;',      // hand and arm layer, premultiplied alpha, never moved
    'uniform float uNod;',          // head angle in radians, positive = face down
    'uniform sampler2D uEye;',      // the closed eye (straight alpha: where it replaces the picture)
    'uniform float uBlink;',        // 0 = open, 1 = closed
    'const vec4 EYE = vec4(' + EYE_BOX.map(function (v) { return v.toFixed(1); }).join(', ') + ');',   // x, y, w, h in picture px
    'const vec2 PIV = vec2(' + NOD_PIVOT[0].toFixed(1) + ', ' + NOD_PIVOT[1].toFixed(1) + ');',
    'const ivec2 MAP = ivec2(' + MAP_W + ', ' + MAP_H + ');',
    'const float UMAX = ' + U_MAX.toFixed(1) + ';',
    'const float AMP = ' + WIND_AMP.toFixed(1) + ';',   // sway of free hair at full strength, picture px
    'float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'float vnoise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);',
    '}',
    // One map texel: sway vector (xy), veil amount (z), distance from the head in picture px (w).
    'vec4 mapTexel(ivec2 c){',
    '  c = clamp(c, ivec2(0), MAP - 1);',
    '  vec3 a = texelFetch(uMap, c, 0).rgb;',
    '  vec3 b = texelFetch(uMap, c + ivec2(MAP.x, 0), 0).rgb;',
    '  return vec4((round(a.rg * 255.0) - 128.0) / 127.0, a.b, (round(b.r * 255.0) * 256.0 + round(b.g * 255.0)) / 65535.0 * UMAX);',
    '}',
    // Head weight (blue of the right panel), smooth lookup.
    'float headAt(ivec2 c){ c = clamp(c, ivec2(0), MAP - 1); return texelFetch(uMap, c + ivec2(MAP.x, 0), 0).b; }',
    'float headW(vec2 uv){',
    '  vec2 p = uv * vec2(MAP) - 0.5; vec2 i = floor(p), f = p - i; ivec2 c = ivec2(i);',
    '  return mix(mix(headAt(c), headAt(c + ivec2(1, 0)), f.x), mix(headAt(c + ivec2(0, 1)), headAt(c + ivec2(1, 1)), f.x), f.y);',
    '}',
    // Smooth lookup done by hand: the distance is a 16-bit number split over two channels,
    // which the GPU's own filtering would blend wrongly.
    'vec4 mapAt(vec2 uv){',
    '  vec2 p = uv * vec2(MAP) - 0.5; vec2 i = floor(p), f = p - i; ivec2 c = ivec2(i);',
    '  return mix(mix(mapTexel(c), mapTexel(c + ivec2(1, 0)), f.x), mix(mapTexel(c + ivec2(0, 1)), mapTexel(c + ivec2(1, 1)), f.x), f.y);',
    '}',
    'out vec4 outColor;',
    'const vec3 LUM = vec3(0.299, 0.587, 0.114);',
    'const vec2 IMG = vec2(' + IMG_W + '.0, ' + IMG_H + '.0);',
    'const vec2 EQC = vec2(' + EQ_X.toFixed(1) + ', ' + EQ_Y.toFixed(1) + ');',
    'const float EQR = ' + EQ_R.toFixed(1) + ';',
    'const float TILT = ' + EQ_TILT.toFixed(3) + ';',
    'const float NBF = ' + NB + '.0;',
    'void main(){',
    '  vec2 fc = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);',   // top-left origin
    '  vec2 uv = (fc - uRect.xy) / uRect.zw;',
    '  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { outColor = vec4(0.0); return; }',
    '  vec2 uv0 = uv;',
    '  if (abs(uNod) > 1e-5) {',
    '    float a = -uNod * headW(uv);',
    '    vec2 d = uv * IMG - PIV; float ca = cos(a), sa = sin(a);',
    '    uv = (PIV + vec2(d.x * ca - d.y * sa, d.x * sa + d.y * ca)) / IMG;',
    '  }',
    '  if (uWind > 0.001) {',
    '    vec4 m = mapAt(uv);',
    '    if (dot(m.xy, m.xy) > 0.0) {',
    '      vec2 ip = uv * IMG; float u = m.w, t = uTime;',
    '      float gust = 0.50 + 0.50 * vnoise(vec2(u * 0.0015 - t * 0.21, ip.y * 0.0011 + t * 0.045));',
    '      float ph = vnoise(ip * 0.0034 + vec2(0.0, t * 0.06)) * 6.2832;',
    '      float w1 = sin(6.2832 * (u / 560.0 - t / 3.6) + ph * 0.55);',
    '      float w2 = sin(6.2832 * (u / 235.0 - t / 2.0) + ph * 1.00 + 1.7);',
    '      float w3 = sin(6.2832 * (u / 100.0 - t / 0.95) + ph * 1.60);',
    '      float sway = (w1 + 0.40 * w2 + (0.07 + 0.16 * m.z) * w3) * gust;',
    '      uv -= m.xy * sway * AMP * uWind / IMG;',
    '    }',
    '  }',
    '  vec4 c = texture(uTex, uv);',
    '  if (uBlink > 0.002) {',
    '    vec2 e = (uv * IMG - EYE.xy) / EYE.zw;',
    '    if (e.x > 0.0 && e.x < 1.0 && e.y > 0.0 && e.y < 1.0) {',
    '      vec4 ce = texture(uEye, e);',
    '      float lid = EYE.y + 10.0 + uBlink * (EYE.w - 10.0);',
    '      float wipe = uBlink > 0.995 ? 1.0 : 1.0 - clamp((uv.y * IMG.y - lid) / 12.0 + 0.5, 0.0, 1.0);',
    '      c.rgb = mix(c.rgb, ce.rgb * c.a, ce.a * wipe);',
    '    }',
    '  }',
    '  vec4 arm = texture(uArm, uv0);',
    '  c = c * (1.0 - arm.a) + arm;',
    '  vec3 col = c.rgb;',
    '  float lum = dot(col, LUM);',
    '  vec3 tint = mix(vec3(1.0), uAccent, 0.7);',

    // Beat light: highlights flare in place, and a blurred copy of them glows around.
    '  float hi = smoothstep(0.28, 0.80, lum);',
    '  float flare = (0.08 + 0.72 * uPulse) * uLight;',
    '  col += c.rgb * tint * hi * flare * (1.0 - 0.35 * lum);',
    '  col += uAccent * hi * lum * flare * 0.30;',
    '  vec3 soft = textureLod(uTex, uv, 5.0).rgb * 0.6 + textureLod(uTex, uv, 6.5).rgb * 0.4;',
    '  float sl = max(dot(soft, LUM) - 0.20, 0.0);',
    '  col += tint * sl * (0.05 + 0.40 * uPulse) * (0.25 + 0.75 * c.a) * uLight;',

    // Equalizer in the ear cup.
    '  vec2 q = uv * IMG - EQC;',
    '  float cs = cos(TILT), sn = sin(TILT);',
    '  q = vec2(q.x * cs + q.y * sn, -q.x * sn + q.y * cs) / EQR;',     // disc = unit circle, bars upright in the headset
    '  float rr = length(q);',
    '  if (uEq > 0.001 && rr < 1.9) {',
    '    float aa = fwidth(q.x) * 1.2 + 1e-4;',
    '    float span = 1.26, slot = span / NBF;',
    '    float idx = clamp(floor((q.x + span * 0.5) / slot), 0.0, NBF - 1.0);',
    '    float xc = (idx + 0.5) * slot - span * 0.5;',
    '    float v = uBars[int(idx)];',
    '    float hw = slot * 0.30;',
    '    float room = sqrt(max(0.74 * 0.74 - xc * xc, 0.0));',          // bars stay inside the disc
    '    float hh = hw + (room - hw) * v;',                              // silent = a dot
    '    vec2 d = vec2(abs(q.x - xc), abs(q.y)) - vec2(0.0, hh - hw);',
    '    float sd = length(max(d, 0.0)) - hw;',                          // rounded bar
    '    float core = 1.0 - smoothstep(-aa, aa, sd);',
    '    float halo = exp(-max(sd, 0.0) * 7.0);',
    '    float disc = 1.0 - smoothstep(0.84, 0.96, rr);',
    '    vec3 led = mix(uAccent, vec3(1.0), 0.22);',
    '    col += (led * core * (0.55 + 0.55 * v) + uAccent * halo * (0.10 + 0.45 * v)) * disc * uEq;',
    // Its light on the glossy rim and the cup around the disc: follows the picture's own shine.
    '    float rim = smoothstep(0.80, 1.0, rr) * (1.0 - smoothstep(1.0, 1.9, rr));',
    '    col += uAccent * (lum * 2.2 + 0.015) * rim * (0.15 + 0.85 * uEnergy) * uEq * c.a;',
    '  }',
    '  outColor = vec4(col, c.a);',
    '}'
  ].join('\n');

  var gl, prog, U = {}, tex, ready = false, baseReady = false, canvas, w = 0, h = 0;
  var accentTo = [1, 0.45, 0.7], accent = [1, 0.45, 0.7];
  // Defaults match project.json: beat light 125 %, wind 40 %.
  var opt = { light: 1.25, eq: true, wind: 0.4, nod: 1, blink: true }, lightK = 1.25, eqK = 1;
  var pulse = 0, lowAvg = 0, energy = 0;
  var bars = new Float32Array(NB);
  var hold = null;
  var mapTex = null, armTex = null, eyeTex = null, time = 0, windK = 0.4;
  var blink = 0, blinkT = -1, nextBlink = 2.5, blinkTwice = false, quick = 0;
  // Listening: 'open' or 'closed', seconds left in that phase, the lid held shut (0..1),
  // how much the head follows the beat (0..1), and how long music has been playing / silent.
  var phase = 'open', phaseT = 1.5, lid = 0, groove = 0, musicT = 0, quietT = 0;
  var nod = 0, nodVel = 0, nodK = 1, lastNodAt = -10, prevKick = 0, prevPhase = 0, skipBeat = false;

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function init(cv) {
    canvas = cv;
    gl = cv.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true });
    if (!gl) return false;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) { console.error('character shader', e); return false; }
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    ['uRes', 'uRect', 'uTex', 'uAccent', 'uPulse', 'uLight', 'uEq', 'uEnergy', 'uBars', 'uMap', 'uTime', 'uWind', 'uArm', 'uNod', 'uEye', 'uBlink'].forEach(function (n) {
      U[n] = gl.getUniformLocation(prog, n);
    });

    var img = new Image();
    img.onload = function () {
      tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // Premultiplied on upload, so filtering and mipmaps never drag color in from fully
      // transparent pixels (the usual cause of dark or light fringes).
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.generateMipmap(gl.TEXTURE_2D);
      baseReady = true;
    };
    img.src = 'img/character.webp';

    var ei = new Image();
    ei.onload = function () {
      var t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ei);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.activeTexture(gl.TEXTURE0);
      eyeTex = t;
    };
    ei.src = 'img/character_eye.png';

    var ai = new Image();
    ai.onload = function () {
      var t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ai);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.activeTexture(gl.TEXTURE0);
      armTex = t;
    };
    ai.src = 'img/character_arm.webp';

    // The motion map holds numbers, not colors: no premultiplying, no color conversion, no filtering.
    var mp = new Image();
    mp.onload = function () {
      var t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, mp);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
      gl.activeTexture(gl.TEXTURE0);
      mapTex = t;
    };
    mp.src = 'img/motion.png';
    return true;
  }

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    var cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
    if (cw !== w || ch !== h) { canvas.width = w = cw; canvas.height = h = ch; gl.viewport(0, 0, w, h); }
  }

  function clamp01(v) { return v > 1 ? 1 : (v > 0 ? v : 0); }

  /* Music inputs, eased here so the picture never flickers:
     - pulse: a kick in the low bands (the level jumping above its own recent average), or
       the analyzer's onset when it is running; fast up, slow down.
     - bars: seven groups of the 64 spectrum bands, lifted toward the treble like the
       spectrum display so the right-hand bars are not always flat. */
  function update(dt, audio, beat, bands) {
    var i, j, low = 0;
    if (bands) {
      for (i = 0; i < 6; i++) low += bands[i];
      low /= 6;
      for (i = 0; i < NB; i++) {
        var s = 0;
        for (j = EDGES[i]; j < EDGES[i + 1]; j++) s += bands[j];
        var mid = (EDGES[i] + EDGES[i + 1]) / 2;
        var v = Math.pow(clamp01(s / (EDGES[i + 1] - EDGES[i]) * (1 + mid / 64 * 1.6) * 0.95), 0.82);
        bars[i] += (v - bars[i]) * (1 - Math.exp(-dt * (v > bars[i] ? 30 : 9)));
      }
    }
    var kick = clamp01((low - lowAvg) * 3.5);
    lowAvg += (low - lowAvg) * (1 - Math.exp(-dt * 2.5));
    var onset = beat && beat.onset ? beat.onset * 0.8 * clamp01(low * 3 + 0.25) : 0;
    var target = Math.max(kick, onset);

    // Nod: every beat gives the head a push; a damped spring carries it down and back, so it
    // dips quickly and settles smoothly. With a steady tempo the analyzer's beat clock sets
    // the moment (every second beat above about 190 BPM); otherwise each kick does.
    var push = 0, e0 = audio ? clamp01((audio.bass * 0.6 + audio.mid * 0.5) * 2.5) : 0;
    var steady = !!(beat && beat.locked && beat.bpm > 40);
    if (steady) {
      if (beat.phase < prevPhase - 0.5) {
        var fast = 60 / beat.bpm < 0.31;      // above about 190 BPM: every second beat
        skipBeat = fast ? !skipBeat : false;
        if (!skipBeat) push = 0.75 + 0.25 * clamp01(target * 1.5);
      }
      prevPhase = beat.phase;
    } else if (target > 0.42 && prevKick <= 0.42 && time - lastNodAt > 0.30) {
      push = 0.55 + 0.45 * clamp01(target);
    }
    prevKick = target;
    if (push > 0) { nodVel += 21 * push * e0 * groove; lastNodAt = time; }
    // Is music playing? (a level held for more than a second; a second and a half of quiet ends it)
    if (audio && audio.bass * 0.6 + audio.mid * 0.5 > 0.05) { musicT += dt; quietT = 0; }
    else { quietT += dt; if (quietT > 1.5) musicT = 0; }
    var listening = opt.blink && opt.nod > 0.01 && musicT > 1.2;

    // Listening phases: eyes closed for 12 to 22 s with the head following the beat, then open
    // for 2.5 to 4 s with the head still. The head only starts once the eye is fully shut, and
    // the eye only opens again once the head has come to rest.
    phaseT -= dt;
    if (phase === 'open') {
      if (listening && phaseT <= 0 && blinkT < 0) { phase = 'closed'; phaseT = 12 + Math.random() * 10; }
    } else if (!listening || phaseT <= 0) {
      phase = 'open'; phaseT = 2.5 + Math.random() * 1.5;
      nextBlink = time + 1.2 + Math.random() * 1.5;
    }
    var shut = phase === 'closed' || (groove > 0.12 && opt.blink && lid > 0);
    lid = clamp01(lid + (shut ? dt / 0.24 : -dt / 0.34));
    var gTarget = !opt.blink ? 1 : (phase === 'closed' && lid >= 1 ? 1 : 0);
    groove += (gTarget - groove) * (1 - Math.exp(-dt * (gTarget > groove ? 2.5 : 5)));

    // Ordinary blinks while the eyes are open: closes in 70 ms, shut 50 ms, opens in 150 ms,
    // every 2.6 to 6.8 s, now and then twice in quick succession.
    if (!opt.blink || phase === 'closed' || lid > 0) { quick = 0; blinkT = -1; if (nextBlink < time + 0.8) nextBlink = time + 0.8 + Math.random() * 2; }
    else if (blinkT < 0) { if (time >= nextBlink) blinkT = 0; }
    else {
      blinkT += dt;
      var bt = blinkT, bv;
      if (bt < 0.07) bv = bt / 0.07;
      else if (bt < 0.12) bv = 1;
      else if (bt < 0.27) bv = 1 - (bt - 0.12) / 0.15;
      else { bv = 0; blinkT = -1; nextBlink = time + (blinkTwice ? 0.09 : 2.6 + Math.random() * 4.2); blinkTwice = !blinkTwice && Math.random() < 0.18; }
      quick = bv * bv * (3 - 2 * bv);
    }
    blink = opt.blink ? Math.max(quick, lid * lid * (3 - 2 * lid)) : 0;
    for (var st = Math.max(1, Math.ceil(dt * 120)), hstep = dt / st, n = 0; n < st; n++) {
      nodVel += (-144 * nod - 13.2 * nodVel) * hstep;
      nod += nodVel * hstep;
    }
    pulse += (target - pulse) * (1 - Math.exp(-dt * (target > pulse ? 45 : 5.5)));
    var e = audio ? clamp01(audio.bass * 0.6 + audio.mid * 0.5) : 0;
    energy += (e - energy) * (1 - Math.exp(-dt * 4));
    var k = 1 - Math.exp(-dt * 3);
    for (i = 0; i < 3; i++) accent[i] += (accentTo[i] - accent[i]) * k;
    lightK += (opt.light - lightK) * k;
    nodK += (opt.nod - nodK) * k;
    eqK += ((opt.eq ? 1 : 0) - eqK) * k;
    windK += (opt.wind - windK) * k;
    time += dt;
    if (hold) {                      // fixed inputs, for looking at one state in the browser
      if (hold.pulse != null) pulse = hold.pulse;
      if (hold.time != null) time = hold.time;
      if (hold.wind != null) windK = hold.wind;
      if (hold.light != null) lightK = hold.light;
      if (hold.nod != null) { nod = hold.nod; nodVel = 0; nodK = 1; }
      if (hold.blink != null) blink = hold.blink;
      if (hold.eq != null) eqK = hold.eq;
      if (hold.energy != null) energy = hold.energy;
      if (hold.bars) for (i = 0; i < NB; i++) bars[i] = hold.bars[i];
    }
  }

  function frame(dt, audio, beat, o) {
    ready = baseReady && !!armTex;
    if (!ready) return;
    resize();
    update(dt || 0.016, audio, beat, o && o.bands);
    // The whole picture, as tall as the screen, on the right edge.
    var ph = h, pw = ph * IMG_W / IMG_H;
    var x0 = w - pw, y0 = 0;
    gl.useProgram(prog);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(U.uRes, w, h);
    gl.uniform4f(U.uRect, x0, y0, pw, ph);
    gl.uniform3f(U.uAccent, accent[0], accent[1], accent[2]);
    gl.uniform1f(U.uPulse, pulse);
    gl.uniform1f(U.uLight, lightK);
    gl.uniform1f(U.uEq, eqK);
    gl.uniform1f(U.uEnergy, energy);
    gl.uniform1fv(U.uBars, bars);
    gl.uniform1f(U.uTime, time);
    gl.uniform1f(U.uWind, mapTex ? windK : 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mapTex);
    gl.uniform1i(U.uMap, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, armTex);
    gl.uniform1i(U.uArm, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, eyeTex);
    gl.uniform1i(U.uEye, 3);
    gl.uniform1f(U.uBlink, eyeTex ? blink : 0);
    gl.uniform1f(U.uNod, mapTex ? Math.max(-0.5, Math.min(1.3, nod)) * NOD_MAX * nodK : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(U.uTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    init: init,
    frame: frame,
    isReady: function () { return ready; },
    setAccent: function (rgb) { if (rgb && rgb.length >= 3) accentTo = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255]; },
    setOptions: function (o) {
      if ('light' in o) opt.light = o.light === true ? 1 : Math.max(0, Math.min(2.5, +o.light || 0));
      if ('nod' in o) opt.nod = Math.max(0, Math.min(2.5, +o.nod || 0));
      if ('blink' in o) opt.blink = !!o.blink;
      if ('eq' in o) opt.eq = !!o.eq;
      if ('wind' in o) opt.wind = Math.max(0, Math.min(2.5, +o.wind || 0));
    },
    setBackdrop: function () {},
    // For checking in the browser: current inputs, and a way to hold them at fixed values.
    _hold: function (o) { hold = o || null; },
    // For recordings: put the listening state where a scene needs it (eyes shut and nodding, or open).
    _listen: function (on, seconds, grooveNow) {
      phase = on ? 'closed' : 'open'; phaseT = seconds || 60; musicT = on ? 5 : 0; quietT = 0;
      if (grooveNow != null) groove = grooveNow;
      if (!on) { nextBlink = time + (seconds || 60); }
    },
    _step: function (dt, audio, beat, bands) { update(dt, audio, beat, bands); },
    _state: function () { return { nod: nod, blink: blink, phase: phase, groove: groove, pulse: pulse, bars: Array.prototype.slice.call(bars), accent: accent.slice(), energy: energy }; }
  };
})();
