/* Settings panel for the app edition.
 * A web wallpaper gets its options from Wallpaper Engine's own settings window; an
 * application wallpaper gets nothing from it. So the same options live here instead:
 * a panel opened with the gear button, saved in this browser profile, and applied through
 * the very same function Wallpaper Engine would have called (applyUserProperties). */
(function () {
  'use strict';
  if (!window.__cosmoBridge) return;

  /* Language of the panel itself; follows the "Language" option. */
  function lang() {
    var l = values.language;
    if (l === 'en' || l === 'ko' || l === 'zh') return l;
    var n = (navigator.language || '').toLowerCase();
    return n.indexOf('ko') === 0 ? 'ko' : n.indexOf('zh') === 0 ? 'zh' : 'en';
  }
  var WORDS = {
    en: ['Settings', 'Reset', 'Choose…', 'Clear', 'Update available: '],
    ko: ['설정', '기본값', '선택…', '지우기', '새 버전 있음: '],
    zh: ['设置', '重置', '选择…', '清除', '有新版本：']
  };
  var newVersion = '';        // set when GitHub has a newer release than the running program
  var KEY = 'cosmo.settings.v1';

  // type: b = on/off, s = slider [min, max, step], c = choice [[value, en, ko], ...]
  var SCHEMA = [
    { k: 'bgmode', en: 'Background ✨', ko: '배경 선택 ✨', zh: '选择背景 ✨', t: 'c', d: 'silk',
      o: [['silk', 'Silk (album colors)', '실크 (앨범 색)', '丝绸（专辑颜色）'], ['character', 'Silk (album colors) + Character', '실크 (앨범 색) + 캐릭터', '丝绸（专辑颜色） + 角色']] },
    { k: 'charwind', en: 'Wind on hair and veil (%) — 0 = still', ko: '머리카락·베일 바람 세기 (%) — 0 = 정지', zh: '头发和头纱的风力 (%) — 0 = 静止', t: 's', d: 40, r: [0, 200, 5], u: '%', need: 'bgmode=character' },
    { k: 'charnod', en: 'Nod to the beat (%) — 0 = off', ko: '비트에 맞춰 끄덕임 (%) — 0 = 끔', zh: '随节拍点头 (%) — 0 = 关闭', t: 's', d: 100, r: [0, 200, 5], u: '%', need: 'bgmode=character' },
    { k: 'charblink', en: 'Blinking', ko: '눈 깜빡임', zh: '眨眼', t: 'b', d: true, need: 'bgmode=character' },
    { k: 'charlight', en: 'Beat light strength (%) — 0 = off', ko: '비트 조명(빛 반사) 세기 (%) — 0 = 끔', zh: '节拍光效强度 (%) — 0 = 关闭', t: 's', d: 125, r: [0, 200, 5], u: '%', need: 'bgmode=character' },
    { k: 'chareq', en: 'Headphone equalizer', ko: '헤드폰 이퀄라이저', zh: '耳机均衡器', t: 'b', d: true, need: 'bgmode=character' },
    { k: 'language', en: 'Language', ko: '언어', zh: '语言', t: 'c', d: 'auto',
      o: [['auto', 'Auto', '자동', '自动'], ['en', 'English', 'English', 'English'], ['ko', '한국어', '한국어', '한국어'], ['zh', '中文', '中文', '中文']] },
    { k: 'colormood', en: 'Color mood', ko: '색 분위기', zh: '色彩氛围', t: 'c', d: 'auto',
      o: [['auto', 'Album', '앨범', '专辑'], ['light', 'Light', '밝게', '明亮'], ['dark', 'Dark', '어둡게', '深色']] },
    { k: 'idletheme', en: 'Theme when nothing plays', ko: '재생 없을 때 테마', zh: '无播放时的主题', t: 'c', d: 'dark',
      o: [['light', 'Light', '밝게', '明亮'], ['dark', 'Dark', '어둡게', '深色']] },
    { k: 'bgimage', en: 'Background image', ko: '배경 이미지', zh: '背景图片', t: 'f', d: '' },
    { k: 'bgdim', en: 'Image dimming', ko: '이미지 어둡게', zh: '图片变暗', t: 's', d: 25, r: [0, 90, 1], u: '%', need: 'bgimage' },
    { k: 'bgblur', en: 'Image blur', ko: '이미지 흐림', zh: '图片模糊', t: 's', d: 0, r: [0, 40, 1], u: '', need: 'bgimage' },
    { k: 'quality', en: 'Background quality', ko: '배경 품질', zh: '背景画质', t: 'c', d: '0.5',
      o: [['0.35', 'Low', '낮음', '低'], ['0.5', 'Medium', '중간', '中'], ['0.75', 'High', '높음', '高'], ['1', 'Ultra', '최고', '极高']] },
    { k: 'flowintensity', en: 'Flow intensity', ko: '흐름 강도', zh: '流动强度', t: 's', d: 100, r: [0, 200, 1], u: '%' },
    { k: 'flowspeed', en: 'Flow speed', ko: '흐름 속도', zh: '流动速度', t: 's', d: 100, r: [0, 300, 1], u: '%' },
    { k: 'audioreact', en: 'Audio reactivity', ko: '소리 반응', zh: '音频响应', t: 's', d: 100, r: [0, 200, 1], u: '%' },
    { k: 'autogain', en: 'Auto gain', ko: '자동 음량 보정', zh: '自动增益', t: 'b', d: true },
    { k: 'mouseinteract', en: 'Silk background reacts to the mouse', ko: '실크배경 마우스 반응', zh: '丝绸背景鼠标互动', t: 'b', d: false },
    { k: 'particles', en: 'Floating particles', ko: '떠다니는 입자', zh: '漂浮粒子', t: 'b', d: true },
    { k: 'glassblur', en: 'Glass blur', ko: '유리 흐림 효과', zh: '玻璃模糊', t: 'b', d: false },
    { k: 'playerstyle', en: 'Player style', ko: '플레이어 모양', zh: '播放器样式', t: 'c', d: 'card',
      o: [['card', 'Card (with vinyl deck)', '카드 (바이닐 데크)', '卡片（含黑胶唱片）'], ['compact', 'Compact', '컴팩트', '紧凑']] },
    { k: 'showvinyl', en: 'Vinyl disc', ko: '바이닐 디스크', zh: '黑胶唱片', t: 'b', d: true, need: 'playerstyle=card' },
    { k: 'showspectrum', en: 'Show spectrum', ko: '스펙트럼 표시', zh: '显示频谱', t: 'b', d: true },
    { k: 'spectrumstyle', en: 'Spectrum style', ko: '스펙트럼 모양', zh: '频谱样式', t: 'c', d: 'bars',
      o: [['bars', 'Bars', '막대', '柱状'], ['mirror', 'Mirrored bars', '대칭 막대', '对称柱状'], ['wave', 'Wave', '물결', '波形'], ['dots', 'Dots', '점', '圆点']], need: 'showspectrum' },
    { k: 'fixedaccent', en: 'Fixed accent color', ko: '강조색 고정', zh: '固定强调色', t: 'b', d: false },
    { k: 'accentcolor', en: 'Accent color', ko: '강조색', zh: '强调色', t: 'c', d: '1 0.42 0.62', need: 'fixedaccent',
      o: [['1 0.42 0.62', 'Pink', '분홍', '粉'], ['1 0.55 0.2', 'Orange', '주황', '橙'], ['1 0.84 0.3', 'Gold', '금색', '金'], ['0.35 0.9 0.6', 'Mint', '민트', '薄荷'], ['0.35 0.7 1', 'Blue', '파랑', '蓝'], ['0.72 0.55 1', 'Violet', '보라', '紫']] },
    { k: 'playerscale', en: 'Player size', ko: '플레이어 크기', zh: '播放器大小', t: 's', d: 100, r: [50, 160, 1], u: '%' },
    { k: 'playerx', en: 'Player position X', ko: '플레이어 가로 위치', zh: '播放器水平位置', t: 's', d: 50, r: [0, 100, 1], u: '%' },
    { k: 'playery', en: 'Player position Y', ko: '플레이어 세로 위치', zh: '播放器垂直位置', t: 's', d: 47, r: [0, 100, 1], u: '%' },
    { k: 'showtimeline', en: 'Progress bar', ko: '진행 막대', zh: '进度条', t: 'b', d: true },
    { k: 'hideidle', en: 'Hide when nothing plays', ko: '재생 없으면 숨김', zh: '无播放时隐藏', t: 'b', d: false },
    { k: 'hidepaused', en: 'Also hide while paused', ko: '일시정지 중에도 숨김', zh: '暂停时也隐藏', t: 'b', d: false, need: 'hideidle' },
    { k: 'analyzer', en: 'Analyzer panel', ko: '분석 패널', zh: '分析面板', t: 'b', d: true },
    { k: 'analyzerlayout', en: 'Analyzer layout', ko: '분석 패널 구성', zh: '分析面板布局', t: 'c', d: 'full',
      o: [['full', 'Full', '전체', '完整'], ['simple', 'Simple (spectrum, loudness, tempo, levels)', '간단 (스펙트럼, 음량, 템포, 레벨)', '简洁（频谱、响度、节拍、电平）'], ['spectrum', 'Spectrum only', '스펙트럼만', '仅频谱']], need: 'analyzer' },
    { k: 'trackinfo', en: 'Online track info (year, genre, reference tempo, ReplayGain from iTunes / Deezer)', ko: '온라인 곡 정보 (iTunes / Deezer의 발매 연도, 장르, 기준 템포, 리플레이게인)', zh: '在线曲目信息（来自 iTunes / Deezer 的发行年份、流派、参考节拍、回放增益）', t: 'b', d: true },
    { k: 'hdcover', en: 'HD cover for small video thumbnails', ko: '작은 영상 썸네일을 고화질 커버로 교체', zh: '将小视频缩略图替换为高清封面', t: 'b', d: true, need: 'trackinfo' },
    { k: 'lyrics', en: 'Karaoke lyrics (lrclib.net)', ko: '노래방 가사 (lrclib.net)', zh: '卡拉OK歌词 (lrclib.net)', t: 'b', d: true },
    { k: 'lyricsoffset', en: 'Lyrics timing', ko: '가사 싱크', zh: '歌词时间偏移', t: 's', d: 0, r: [-5, 5, 0.1], u: ' s', need: 'lyrics' },
    { k: 'lyricsy', en: 'Lyrics position Y', ko: '가사 세로 위치', zh: '歌词垂直位置', t: 's', d: 84, r: [0, 100, 1], u: '%', need: 'lyrics' },
    { k: 'lyricssize', en: 'Lyrics size', ko: '가사 크기', zh: '歌词大小', t: 's', d: 100, r: [50, 200, 1], u: '%', need: 'lyrics' },
    { k: 'showclock', en: 'Clock', ko: '시계', zh: '时钟', t: 'b', d: true },
    { k: 'clock24h', en: '24-hour clock', ko: '24시간제', zh: '24小时制', t: 'b', d: true, need: 'showclock' },
    { k: 'clockx', en: 'Clock position X', ko: '시계 가로 위치', zh: '时钟水平位置', t: 's', d: 100, r: [0, 100, 1], u: '%', need: 'showclock' },
    { k: 'clocky', en: 'Clock position Y', ko: '시계 세로 위치', zh: '时钟垂直位置', t: 's', d: 100, r: [0, 100, 1], u: '%', need: 'showclock' },
    { k: 'clocksize', en: 'Clock size', ko: '시계 크기', zh: '时钟大小', t: 's', d: 100, r: [50, 200, 1], u: '%', need: 'showclock' },
    { k: 'clockfont', en: 'Clock font', ko: '시계 글꼴', zh: '时钟字体', t: 'c', d: 'default', need: 'showclock',
      o: [['default', 'Thin', '얇게', '细体'], ['rounded', 'Bold', '굵게', '粗体'], ['condensed', 'Narrow', '좁게', '窄体'], ['mono', 'Mono', '고정폭', '等宽'], ['serif', 'Serif', '세리프', '衬线']] },
    { k: 'updatecheck', en: 'Check for updates (asks github.com)', ko: '업데이트 확인 (github.com 조회)', zh: '检查更新（访问 github.com）', t: 'b', d: true },
    { k: 'clockglass', en: 'Clock glass box', ko: '시계 유리 상자', zh: '时钟玻璃底框', t: 'b', d: false, need: 'showclock' }
  ];

  var values = {};
  /* Is the option an entry depends on switched on? 'key' = that option is on, 'key=value' = it has that value. */
  function met(need) {
    if (!need) return true;
    var p = need.split('=');
    return p.length > 1 ? String(values[p[0]]) === p[1] : !!values[p[0]];
  }
  function load() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
    SCHEMA.forEach(function (s) { values[s.k] = (s.k in saved) ? saved[s.k] : s.d; });
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(values)); } catch (e) { /* profile is read-only */ } }

  function apply(keys) {
    var p = {};
    (keys || SCHEMA.map(function (s) { return s.k; })).forEach(function (k) { p[k] = { value: values[k] }; });
    if (window.wallpaperPropertyListener) window.wallpaperPropertyListener.applyUserProperties(p);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var panel, rows = {};

  function fmt(s, v) { return (s.r[2] < 1 ? Number(v).toFixed(1) : String(Math.round(v))) + (s.u || ''); }

  function refresh() {
    SCHEMA.forEach(function (s) {
      var r = rows[s.k], v = values[s.k];
      if (!r) return;
      r.row.classList.toggle('off', !met(s.need));
      if (s.t === 'b') r.ctl.classList.toggle('on', !!v);
      else if (s.t === 'f') r.ctl.lastChild.style.display = v ? '' : 'none';
      else if (s.t === 'c') Array.prototype.forEach.call(r.ctl.children, function (b) { b.classList.toggle('on', b.dataset.value === String(v)); });
      else {
        r.ctl.style.setProperty('--v', String((v - s.r[0]) / (s.r[1] - s.r[0])));
        r.val.textContent = fmt(s, v);
      }
    });
  }

  function set(k, v) { values[k] = v; save(); apply([k]); refresh(); }

  /* Slider dragging. Returns a function (x, y, end) that follows the pointer.
   * Used both by real mouse input (stand-alone window) and by the host's pointer reports. */
  window.cosmoSliderDrag = function (track, x) {
    var s = SCHEMA.filter(function (q) { return q.k === track.dataset.key; })[0];
    if (!s) return null;
    function move(px) {
      var rc = track.getBoundingClientRect();
      var f = Math.max(0, Math.min(1, (px - rc.left) / rc.width));
      var v = s.r[0] + f * (s.r[1] - s.r[0]);
      v = Math.round(v / s.r[2]) * s.r[2];
      v = Number(v.toFixed(2));
      if (v !== values[s.k]) set(s.k, v);
    }
    move(x);
    return function (px) { move(px); };
  };

  function build() {
    var L = lang();
    rows = {};
    panel = el('div', 'settings');
    panel.id = 'settings';
    var head = el('div', 'st-head');
    head.appendChild(el('span', null, WORDS[L][0]));
    var reset = el('button', 'st-text', WORDS[L][1]);
    reset.dataset.ui = 'reset';
    var close = el('button', 'st-text', '✕');
    close.dataset.ui = 'close';
    if (newVersion) {
      var up = el('button', 'st-text st-update', WORDS[L][4] + newVersion);
      up.dataset.ui = 'update';
      head.appendChild(up);
    }
    head.appendChild(reset);
    head.appendChild(close);
    panel.appendChild(head);
    var list = el('div', 'st-list');
    panel.appendChild(list);

    SCHEMA.forEach(function (s) {
      var row = el('div', 'st-row st-' + s.t);
      row.appendChild(el('span', 'st-label', s[L]));
      var ctl, val = null;
      if (s.t === 'b') {
        ctl = el('button', 'st-toggle');
        ctl.dataset.ui = 'toggle';
        ctl.dataset.key = s.k;
        ctl.appendChild(el('i'));
      } else if (s.t === 'f') {
        // A file: the host program shows the Windows file picker and hands back a URL.
        ctl = el('div', 'st-file');
        var pick = el('button', 'st-text', WORDS[L][2]);
        pick.dataset.ui = 'pick';
        pick.dataset.key = s.k;
        var clear = el('button', 'st-text', WORDS[L][3]);
        clear.dataset.ui = 'clear';
        clear.dataset.key = s.k;
        ctl.appendChild(pick);
        ctl.appendChild(clear);
      } else if (s.t === 'c') {
        ctl = el('div', 'st-seg');
        s.o.forEach(function (o) {
          var b = el('button', null, o[{ en: 1, ko: 2, zh: 3 }[L]]);
          b.dataset.ui = 'choice';
          b.dataset.key = s.k;
          b.dataset.value = o[0];
          ctl.appendChild(b);
        });
      } else {
        val = el('span', 'st-val');
        row.appendChild(val);
        ctl = el('div', 'st-track');
        ctl.dataset.ui = 'slider';
        ctl.dataset.slider = '1';
        ctl.dataset.key = s.k;
        ctl.appendChild(el('i'));
        // Real mouse (stand-alone window).
        ctl.addEventListener('pointerdown', function (e) {
          var follow = window.cosmoSliderDrag(ctl, e.clientX);
          try { ctl.setPointerCapture(e.pointerId); } catch (x) { /* synthetic pointer */ }
          function mv(ev) { follow(ev.clientX); }
          function up() { ctl.removeEventListener('pointermove', mv); ctl.removeEventListener('pointerup', up); }
          ctl.addEventListener('pointermove', mv);
          ctl.addEventListener('pointerup', up);
        });
      }
      row.appendChild(ctl);
      rows[s.k] = { row: row, ctl: ctl, val: val };
      list.appendChild(row);
    });

    panel.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-ui]');
      if (!b) return;
      var ui = b.dataset.ui, k = b.dataset.key;
      if (ui === 'close') toggle(false);
      else if (ui === 'reset') { SCHEMA.forEach(function (s) { values[s.k] = s.d; }); save(); apply(); rebuild(); }
      else if (ui === 'toggle') set(k, !values[k]);
      else if (ui === 'pick') window.chrome.webview.postMessage('pickimage');
      else if (ui === 'update') window.chrome.webview.postMessage('openrelease');
      else if (ui === 'clear') set(k, '');
      else if (ui === 'choice') { set(k, b.dataset.value); if (k === 'language') rebuild(); }
    });
    document.body.appendChild(panel);
  }

  /* The panel's own texts change with the language: make it again, still open. */
  function rebuild() {
    if (panel) panel.remove();
    build();
    panel.classList.add('open');
    refresh();
  }

  function toggle(open) {
    if (!panel) build();
    var on = open == null ? !panel.classList.contains('open') : open;
    panel.classList.toggle('open', on);
    refresh();
  }

  /* The host program calls this after the user picked a picture (empty = cancelled). */
  window.cosmoBackgroundPicked = function (url) { if (url) { set('bgimage', url); } };

  /* Is a newer version out? Compares "1.2.0"-style numbers; anything unexpected means no. */
  function newer(a, b) {
    var x = String(a).replace(/^v/i, '').split('.'), y = String(b).replace(/^v/i, '').split('.');
    for (var i = 0; i < 3; i++) {
      var p = parseInt(x[i], 10) || 0, q = parseInt(y[i], 10) || 0;
      if (p !== q) return p > q;
    }
    return false;
  }
  var checkedAt = 0;
  window.cosmoCheckUpdate = function (force) {
    if (!values.updatecheck || !window.__cosmoVersion || (!force && Date.now() - checkedAt < 6 * 3600 * 1000)) return;
    checkedAt = Date.now();
    fetch('https://api.github.com/repos/cosmolabs-kr/Wallpaper/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var tag = j && j.tag_name;
        if (!tag || !newer(tag, window.__cosmoVersion)) return;
        newVersion = String(tag);
        var gear = document.querySelector('[data-ui="settings"]');
        if (gear) gear.classList.add('has-update');
        if (panel) { var open = panel.classList.contains('open'); panel.remove(); build(); panel.classList.toggle('open', open); refresh(); }
      })
      .catch(function () { /* offline: try again next time */ });
  };
  setInterval(function () { window.cosmoCheckUpdate(); }, 3600 * 1000);

  load();
  document.addEventListener('DOMContentLoaded', function () {
    apply();
    var gear = document.querySelector('[data-ui="settings"]');
    if (gear) gear.addEventListener('click', function () { toggle(); });
  });
})();
