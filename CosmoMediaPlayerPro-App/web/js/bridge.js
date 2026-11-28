/* Bridge between the host program (CosmoPlayer.exe) and the wallpaper UI.
 * Injected before the page's own scripts. It provides the same functions Wallpaper
 * Engine gives web wallpapers, so app.js runs unchanged - the data just comes from the
 * host program instead - and adds what a web wallpaper cannot do: media commands. */
(function () {
  'use strict';
  if (window.__cosmoBridge || !window.chrome || !window.chrome.webview) return;
  window.__cosmoBridge = true;

  var listeners = {};
  var last = {};           // latest message of each kind, replayed to late listeners

  function register(kind) {
    return function (fn) {
      listeners[kind] = fn;
      if (last[kind]) { try { fn(last[kind]); } catch (e) { console.error(e); } }
    };
  }

  window.wallpaperRegisterAudioListener = function (fn) { listeners.audio = fn; };
  window.wallpaperRegisterMediaStatusListener = register('status');
  window.wallpaperRegisterMediaPropertiesListener = register('properties');
  window.wallpaperRegisterMediaThumbnailListener = register('thumbnail');
  window.wallpaperRegisterMediaPlaybackListener = register('playback');
  window.wallpaperRegisterMediaTimelineListener = register('timeline');
  window.wallpaperMediaIntegration = { PLAYBACK_STOPPED: 0, PLAYBACK_PLAYING: 1, PLAYBACK_PAUSED: 2 };

  var controls = null, device = null, domReady = false;

  function applyControls() {
    if (!domReady || !controls) return;
    ['playpause', 'next', 'prev'].forEach(function (c) {
      var b = document.querySelector('[data-cmd="' + c + '"]');
      if (b) b.disabled = !controls[c];
    });
  }

  function applyDevice() {
    var el = domReady && document.getElementById('anDevice');
    if (!el || !device) return;
    el.textContent = device.rate
      ? [device.name, (device.rate / 1000) + ' kHz', device.bits + '-bit', device.channels + ' ch'].filter(Boolean).join('  ·  ')
      : device.name;
  }

  window.chrome.webview.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || !m.t) return;
    if (m.t === 'audio') { if (listeners.audio) listeners.audio(m.d); return; }
    if (m.t === 'log') { window.__cosmoLog = (window.__cosmoLog || []).concat(m.m); console.warn(m.m); return; }
    if (m.t === 'controls') { controls = m; applyControls(); return; }
    if (m.t === 'device') { device = m; applyDevice(); return; }
    if (m.t === 'version') { window.__cosmoVersion = m.v; if (window.cosmoCheckUpdate) window.cosmoCheckUpdate(); return; }
    if (m.t === 'bgimage') { if (window.cosmoBackgroundPicked) window.cosmoBackgroundPicked(m.url); return; }
    last[m.t] = m;
    if (listeners[m.t]) { try { listeners[m.t](m); } catch (e) { console.error(e); } }
  });

  /* Media commands: 'playpause' | 'next' | 'prev' */
  window.cosmoMedia = function (cmd) { window.chrome.webview.postMessage(String(cmd)); };

  /* Pointer reports from the host program. A wallpaper lies under the desktop icons and
   * gets no mouse input from Windows, so the host watches the mouse and tells us where it
   * is (fractions of the page) and when it is pressed or clicked. */
  var hot = null, drag = null;
  function setHot(b, pressed) {
    if (hot && hot !== b) hot.classList.remove('hover', 'press');
    hot = b;
    if (hot) { hot.classList.add('hover'); hot.classList.toggle('press', !!pressed); }
  }
  /* type: 'move' | 'down' | 'up' (release after a drag) | 'click' (press and release in place) | 'leave' */
  window.__cosmoPointer = function (fx, fy, type) {
    if (type === 'leave') { setHot(null); drag = null; return; }
    var x = fx * window.innerWidth, y = fy * window.innerHeight;
    // Lets the background react to the pointer, as it does with a real mouse.
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
    if (drag) {
      drag(x, y);
      if (type === 'up' || type === 'click') drag = null;
      return;
    }
    var el = document.elementFromPoint(x, y);
    var b = el && el.closest ? el.closest('[data-cmd],[data-ui]') : null;
    if (b && b.disabled) b = null;
    setHot(b, type === 'down');
    if (!b) {
      // Not a button: the page still hears the click (the track info panel opens with the "i" on the
      // card and closes with a click on the card, both found by position).
      if (type === 'click') window.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y }));
      return;
    }
    if (type === 'down' && b.hasAttribute('data-slider') && window.cosmoSliderDrag) drag = window.cosmoSliderDrag(b, x);
    if (type === 'click') {
      if (b.hasAttribute('data-cmd')) window.cosmoMedia(b.getAttribute('data-cmd'));
      else b.click();
    }
  };

  /* Tell the host where the clickable things are (as fractions of the page), so that it
   * can keep presses on them from also reaching the desktop underneath (which would select
   * icons or start a selection rectangle). */
  var lastHits = '';
  function reportHits() {
    var w = window.innerWidth, h = window.innerHeight, out = [];
    if (!w || !h) return;
    var panel = document.querySelector('.settings.open');
    var list = Array.prototype.slice.call(document.querySelectorAll('[data-cmd]:not([disabled]),.controls [data-ui],#infoBtn.ready'));
    if (panel) list.push(panel);
    list.forEach(function (e) {
      var r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      out.push((r.left / w).toFixed(4), (r.top / h).toFixed(4), (r.right / w).toFixed(4), (r.bottom / h).toFixed(4));
    });
    var s = 'hit:' + out.join(',');
    if (s !== lastHits) { lastHits = s; window.chrome.webview.postMessage(s); }
  }
  setInterval(reportHits, 400);

  document.addEventListener('DOMContentLoaded', function () {
    domReady = true;
    document.body.classList.add('app');
    // Messages sent before the page existed are lost: ask the host to send its state again.
    window.chrome.webview.postMessage('ready');
    applyControls();
    applyDevice();
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-cmd]');
      if (b && !b.disabled) window.cosmoMedia(b.getAttribute('data-cmd'));
    });
  });
})();
