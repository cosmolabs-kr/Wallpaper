/* Silk-flow background: a domain-warped noise field rendered as flowing ribbons,
 * colored from the current palette, reacting to audio and the mouse. */
window.Flow = (function () {
  'use strict';

  var VERT = '#version 300 es\n' +
    'in vec2 aPos;\n' +
    'void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }\n';

  var FRAG = [
    '#version 300 es',
    'precision highp float;',
    'uniform vec2 uRes;',
    'uniform float uTime;',
    'uniform vec3 uBg, uC1, uC2, uC3, uC4;',
    'uniform float uBass, uHigh, uWarp, uGrain;',
    'uniform vec3 uMouse;',      // xy: position (aspect units), z: force
    'uniform vec2 uMVel;',
    'out vec4 outColor;',

    'float hash1(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'vec2 hash2(vec2 p){',
    '  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));',
    '  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);',
    '}',
    'float gnoise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);',
    '  return mix(mix(dot(hash2(i), f), dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),',
    '             mix(dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x), u.y);',
    '}',
    'float fbm(vec2 p){',
    '  float a = 0.5, s = 0.0;',
    '  mat2 m = mat2(0.8, -0.6, 0.6, 0.8);',
    '  for (int i = 0; i < 4; i++) { s += a * gnoise(p); p = m * p * 2.03 + 11.7; a *= 0.5; }',
    '  return s;',
    '}',
    'float band(float x, float sharp){ return pow(0.5 + 0.5 * sin(x), sharp); }',

    'void main(){',
    '  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;',
    '  vec2 d = p - uMouse.xy;',
    '  float g = exp(-dot(d, d) * 7.0) * uMouse.z;',
    '  p += vec2(-d.y, d.x) * g * 0.9 + uMVel * g * 0.35;',

    '  float t = uTime;',
    '  float cs = cos(-0.5), sn = sin(-0.5);',
    '  vec2 s = mat2(cs, -sn, sn, cs) * p;',
    '  s *= vec2(0.26, 0.9);',                        // stretch into long silk strands
    '  float amp = uWarp * (1.0 + 0.45 * uBass);',

    '  vec2 q = vec2(fbm(s * 1.1 + vec2(0.0, t * 0.11)), fbm(s * 1.1 + vec2(4.7, 1.9 - t * 0.09)));',
    '  vec2 sr = s * 1.2 + q * 1.5 * amp;',
    '  vec2 r = vec2(fbm(sr + vec2(1.7, 9.2) + t * 0.06), fbm(sr + vec2(8.3, 2.8) - t * 0.05));',
    '  float f = fbm(s * 1.0 + r * 1.7 * amp + vec2(t * 0.03, 0.0));',
    '  float ph = f * 1.5 + r.x * 0.8 + q.y * 0.4;',

    '  float m1 = smoothstep(-0.04, 0.22, q.x);',
    '  float m2 = smoothstep(-0.02, 0.24, q.y);',
    '  float m3 = smoothstep(-0.02, 0.22, r.y);',
    '  float m4 = smoothstep(0.00, 0.26, -q.x + r.x);',
    '  float swell = 0.86 + 0.28 * uBass;',

    '  vec3 col = uBg;',
    '  col = mix(col, uC1, band(ph * 6.0, 4.0) * m1 * 0.92 * swell);',
    '  col = mix(col, uC2, band(ph * 5.0 + 2.1, 5.0) * m2 * 0.85 * swell);',
    '  col = mix(col, uC3, band(ph * 9.0 + 4.0, 8.0) * m3 * 0.80 * swell);',
    '  col = mix(col, uC4, band(ph * 15.0 + 1.0, 18.0) * m4 * 0.90);',

    // Silk sheen from the field gradient.
    '  vec2 gr = vec2(dFdx(ph), dFdy(ph)) * uRes.y * 0.045;',
    '  vec3 n = normalize(vec3(-gr, 1.0));',
    '  float lit = dot(n, normalize(vec3(0.35, 0.55, 0.76)));',
    '  col *= 0.895 + 0.14 * lit;',
    '  float spec = pow(max(dot(n, normalize(vec3(0.2, 0.4, 0.9))), 0.0), 40.0);',
    '  col += spec * 0.05 * (1.0 + uHigh * 1.5);',

    '  vec2 vc = gl_FragCoord.xy / uRes - 0.5;',
    '  col *= 1.0 - 0.22 * dot(vc, vc);',
    '  col += uGrain * (hash1(gl_FragCoord.xy + fract(t) * 91.7) - 0.5) / 128.0;',  // dither against banding
    '  outColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var canvas, gl, prog, uni = {};
  var ready = false;
  var quality = 0.5;
  var fadeSecs = 2.2;
  var flowTime = Math.random() * 100;

  var pal = {
    from: null,
    to: null,
    cur: { bg: [0.92, 0.91, 0.89], c: [[0.1, 0.13, 0.19], [0.46, 0.63, 0.8], [0.94, 0.69, 0.53], [0.77, 0.79, 0.84]] },
    t: 1
  };

  var mouse = { tx: 0, ty: 0, x: 0, y: 0, vx: 0, vy: 0, force: 0, enabled: true };

  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('Shader error:', gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }

  function init(cv) {
    canvas = cv;
    gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) return false;
    var vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;
    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Link error:', gl.getProgramInfoLog(prog));
      return false;
    }
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    ['uRes', 'uTime', 'uBg', 'uC1', 'uC2', 'uC3', 'uC4', 'uBass', 'uHigh', 'uWarp', 'uGrain', 'uMouse', 'uMVel']
      .forEach(function (n) { uni[n] = gl.getUniformLocation(prog, n); });

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', function (e) {
      var h = window.innerHeight || 1;
      mouse.tx = (e.clientX - window.innerWidth / 2) / h;
      mouse.ty = -(e.clientY - window.innerHeight / 2) / h;
    });
    resize();
    ready = true;
    return true;
  }

  function resize() {
    if (!canvas) return;
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(64, Math.round(window.innerWidth * dpr * quality));
    var h = Math.max(64, Math.round(window.innerHeight * dpr * quality));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (gl) gl.viewport(0, 0, w, h);
  }

  function setQuality(q) {
    quality = Math.min(1, Math.max(0.2, q || 0.5));
    resize();
  }

  function to01(c) { return [c[0] / 255, c[1] / 255, c[2] / 255]; }
  function copyPal(p) { return { bg: p.bg.slice(), c: p.c.map(function (x) { return x.slice(); }) }; }

  /* bg and accents are [r,g,b] 0..255. Crossfades from whatever is on screen now. */
  function setPalette(bg, accents, instant) {
    pal.from = copyPal(pal.cur);
    pal.to = { bg: to01(bg), c: accents.slice(0, 4).map(to01) };
    pal.t = instant ? 1 : 0;
    if (instant) pal.cur = copyPal(pal.to);
  }

  function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

  /* state: { bass, mid, high, energy } all 0..1 ; opts: { intensity, speed, mouse } */
  function frame(dt, state, opts) {
    if (!ready) return;

    if (pal.t < 1 && pal.to) {
      pal.t = Math.min(1, pal.t + dt / fadeSecs);
      var e = pal.t * pal.t * (3 - 2 * pal.t);
      pal.cur.bg = lerp3(pal.from.bg, pal.to.bg, e);
      for (var i = 0; i < 4; i++) pal.cur.c[i] = lerp3(pal.from.c[i], pal.to.c[i], e);
    }

    flowTime += dt * opts.speed * (0.75 + 0.9 * state.energy);

    // Mouse: follow with lag; force rises with movement and decays at rest.
    var k = 1 - Math.exp(-dt * 5);
    var dx = mouse.tx - mouse.x, dy = mouse.ty - mouse.y;
    mouse.x += dx * k;
    mouse.y += dy * k;
    mouse.vx += (dx - mouse.vx) * k;
    mouse.vy += (dy - mouse.vy) * k;
    var targetForce = opts.mouse ? Math.min(1, Math.sqrt(dx * dx + dy * dy) * 6) : 0;
    mouse.force += (targetForce - mouse.force) * (1 - Math.exp(-dt * (targetForce > mouse.force ? 8 : 1.2)));

    gl.uniform2f(uni.uRes, canvas.width, canvas.height);
    gl.uniform1f(uni.uTime, flowTime);
    gl.uniform3fv(uni.uBg, pal.cur.bg);
    gl.uniform3fv(uni.uC1, pal.cur.c[0]);
    gl.uniform3fv(uni.uC2, pal.cur.c[1]);
    gl.uniform3fv(uni.uC3, pal.cur.c[2]);
    gl.uniform3fv(uni.uC4, pal.cur.c[3]);
    gl.uniform1f(uni.uBass, state.bass);
    gl.uniform1f(uni.uHigh, state.high);
    gl.uniform1f(uni.uWarp, opts.intensity);
    gl.uniform1f(uni.uGrain, opts.grain === 0 ? 0 : 1);
    gl.uniform3f(uni.uMouse, mouse.x, mouse.y, mouse.force);
    gl.uniform2f(uni.uMVel, mouse.vx, mouse.vy);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    init: init, frame: frame, setPalette: setPalette, setQuality: setQuality,
    setFade: function (s) { fadeSecs = Math.max(0.05, s); }
  };
})();
