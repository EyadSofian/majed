/*!
 * Majed «نور» Widget — custom chat widget for Engosoft (Path B)
 * Loads on the Odoo site, talks to the bridge (Railway):
 *   POST {bridge}/widget/session   → { conversationId }
 *   GET  {bridge}/widget/stream    → SSE (bot + agent replies, real-time)
 *   POST {bridge}/widget/message   → send customer message (+ trainee userData)
 *
 * Configure before this script loads:
 *   window.MajedConfig = {
 *     bridgeUrl:       'https://your-bridge.up.railway.app',   // REQUIRED
 *     userContextUrl:  '/ai_webhook/user_context',             // Odoo endpoint (optional)
 *     avatarUrl:       '/ai_user_context_webhook/static/src/img/majed-avatar.png',
 *     waNumber:        '966920016295',
 *     supportEmail:    'aibot@engosoft.com',
 *     theme:           'light',                                // 'light' | 'dark'
 *     greeting:        'أهلاً، أنا ماجد'
 *   };
 */
(function () {
  'use strict';
  if (window.__majedWidgetLoaded) return;
  window.__majedWidgetLoaded = true;

  var CFG = window.MajedConfig || {};
  var BRIDGE = (CFG.bridgeUrl || '').replace(/\/$/, '');
  if (!BRIDGE) { console.error('[Majed] MajedConfig.bridgeUrl is required'); return; }
  var USER_CTX_URL = CFG.userContextUrl || '/ai_webhook/user_context';
  var AVATAR = CFG.avatarUrl || '/ai_user_context_webhook/static/src/img/majed-avatar.png';
  // Fallback avatar served by the bridge itself — guarantees the image never breaks,
  // even if the Odoo static path is unavailable (preview, module not upgraded, etc.).
  var AVATAR_FB = BRIDGE + '/majed-avatar.png';
  var AVA_ERR = ' onerror="this.onerror=null;this.src=\'' + AVATAR_FB + '\'"';
  var WA = String(CFG.waNumber || '966920016295').replace(/[^\d]/g, '');
  var EMAIL = CFG.supportEmail || 'aibot@engosoft.com';
  var THEME = CFG.theme === 'dark' ? 'dark' : 'light';
  var GREETING = CFG.greeting || 'أهلاً، أنا ماجد';

  // ---------- state ----------
  var convId = null, es = null, started = false, userData = {};

  // ---------- styles ----------
  var CSS = [
    '@import url("https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap");',
    '#mjd-root{position:fixed;bottom:22px;left:22px;z-index:2147483000;direction:rtl;font-family:"Tajawal",system-ui,sans-serif}',
    '#mjd-root[data-side="right"]{left:auto;right:22px}',
    '/* launcher */',
    '#mjd-fab{width:64px;height:64px;border-radius:50%;cursor:pointer;border:0;padding:3px;position:relative;',
    'background:linear-gradient(150deg,#fff,#e7e1ff);box-shadow:0 12px 30px rgba(124,92,255,.34),0 4px 16px rgba(6,182,212,.2);',
    'transition:transform .2s cubic-bezier(.2,.9,.2,1)}',
    '#mjd-fab:hover{transform:translateY(-3px) scale(1.05)}#mjd-fab:active{transform:scale(.96)}',
    '#mjd-fab img{width:100%;height:100%;border-radius:50%;object-fit:cover;object-position:50% 28%;display:block}',
    '#mjd-fab .mjd-dot{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#16a34a;border:2.5px solid #fff}',
    '#mjd-root[data-side="right"] #mjd-fab .mjd-dot{left:auto;right:2px}',
    '#mjd-fab .mjd-ring{position:absolute;inset:-6px;border-radius:50%;border:1.5px solid rgba(124,92,255,.3);animation:mjdBreathe 2.8s ease-in-out infinite;pointer-events:none}',
    '@keyframes mjdBreathe{0%,100%{transform:scale(1);opacity:.5}50%{transform:scale(1.07);opacity:.85}}',
    '/* panel */',
    '#mjd-panel{position:absolute;bottom:80px;left:0;width:380px;max-width:calc(100vw - 32px);height:600px;max-height:calc(100vh - 120px);',
    'border-radius:22px;overflow:hidden;display:none;flex-direction:column;box-shadow:0 28px 70px rgba(15,30,66,.28);',
    'opacity:0;transform:translateY(10px) scale(.98);transition:opacity .22s ease,transform .22s ease}',
    '#mjd-root[data-side="right"] #mjd-panel{left:auto;right:0}',
    '#mjd-panel.mjd-open{display:flex;opacity:1;transform:none}',
    '/* theme tokens */',
    '#mjd-panel[data-theme="light"]{--bg:#f7f8fc;--surf:#fff;--surf2:#f3f4fa;--line:#ebedf4;--text:#171b2e;--muted:#6b7280;--soft:#8b90a3;--botbd:#ececf4;--bar:#fff;--pill:#f6f7fb;--pillbd:#e9ebf3;--pilltx:#2d3550;--wa:#1fa855;--wabg:rgba(31,168,85,.1);--wabd:rgba(31,168,85,.28)}',
    '#mjd-panel[data-theme="dark"]{--bg:#0e1326;--surf:rgba(255,255,255,.05);--surf2:rgba(255,255,255,.06);--line:rgba(255,255,255,.09);--text:#e9edf8;--muted:#9aa3bd;--soft:#7e87a3;--botbd:rgba(255,255,255,.1);--bar:rgba(255,255,255,.04);--pill:rgba(255,255,255,.05);--pillbd:rgba(255,255,255,.11);--pilltx:#e9edf8;--wa:#7ff0a8;--wabg:rgba(37,211,102,.16);--wabd:rgba(37,211,102,.4)}',
    '#mjd-panel{background:var(--bg);color:var(--text)}',
    '#mjd-panel[data-theme="dark"]{background:radial-gradient(560px 300px at 86% -8%,rgba(124,92,255,.35),transparent 60%),radial-gradient(520px 300px at 0% 102%,rgba(34,211,238,.2),transparent 60%),#0e1326}',
    '/* header */',
    '.mjd-hd{display:flex;align-items:center;gap:11px;padding:13px 15px;border-bottom:1px solid var(--line)}',
    '.mjd-hd img{width:40px;height:40px;border-radius:13px;object-fit:cover;border:1px solid var(--line)}',
    '.mjd-hd .mjd-nm b{font-size:15.5px;font-weight:800;display:block}',
    '.mjd-hd .mjd-nm s{text-decoration:none;font-size:11.5px;color:#16a34a}',
    '#mjd-panel[data-theme="dark"] .mjd-hd .mjd-nm s{color:#7df3c4}',
    '.mjd-hd .mjd-tools{margin-inline-start:auto;display:flex;gap:6px}',
    '.mjd-ic{width:36px;height:36px;border-radius:10px;border:1px solid var(--line);background:var(--surf);color:var(--muted);cursor:pointer;display:grid;place-items:center}',
    '.mjd-ic:hover{color:var(--text)}.mjd-ic svg{width:18px;height:18px}',
    '/* pinned contact bar */',
    '.mjd-cbar{display:flex;gap:8px;padding:10px 14px;background:var(--bar);border-bottom:1px solid var(--line)}',
    '.mjd-cb{flex:1;display:flex;align-items:center;justify-content:center;gap:7px;height:40px;border-radius:11px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;text-decoration:none;background:var(--pill);border:1px solid var(--pillbd);color:var(--pilltx);transition:transform .14s}',
    '.mjd-cb:hover{transform:translateY(-1px)}.mjd-cb svg{width:16px;height:16px}',
    '.mjd-cb.mjd-wa{background:var(--wabg);border-color:var(--wabd);color:var(--wa)}',
    '.mjd-cb.mjd-vo{opacity:.62}',
    '.mjd-cb .mjd-soon{font-size:9px;font-weight:800;background:#f59e0b;color:#fff;border-radius:999px;padding:1px 6px}',
    '/* body */',
    '.mjd-bd{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:12px}',
    '.mjd-row{display:flex;gap:8px;align-items:flex-end;max-width:88%;animation:mjdRise .3s ease both}',
    '.mjd-row.mjd-bot{align-self:flex-start}.mjd-row.mjd-me{align-self:flex-end}',
    '@keyframes mjdRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
    '.mjd-mini{width:27px;height:27px;border-radius:9px;object-fit:cover;flex-shrink:0;border:1px solid var(--line)}',
    '.mjd-bub{font-size:14px;line-height:1.7;padding:11px 14px;border-radius:16px;white-space:pre-wrap;word-wrap:break-word}',
    '.mjd-bot .mjd-bub{background:var(--surf);border:1px solid var(--botbd);border-bottom-right-radius:6px}',
    '.mjd-me .mjd-bub{background:linear-gradient(135deg,#7c5cff,#06b6d4);color:#fff;border-bottom-left-radius:6px}',
    '.mjd-card{align-self:flex-start;width:86%;background:var(--surf);border:1px solid var(--botbd);border-radius:14px;overflow:hidden}',
    '.mjd-card .mjd-ct{padding:11px 13px}.mjd-card .mjd-ct b{font-size:14px;display:block}.mjd-card .mjd-ct span{font-size:12px;color:var(--muted)}',
    '.mjd-card a,.mjd-card button{display:flex;align-items:center;gap:8px;padding:11px 13px;font:inherit;font-size:13px;font-weight:700;color:#7c5cff;text-decoration:none;cursor:pointer;border:0;background:transparent;border-top:1px solid var(--line);width:100%;text-align:start}',
    '.mjd-card a:hover,.mjd-card button:hover{background:var(--surf2)}',
    '.mjd-typing{align-self:flex-start;display:flex;gap:5px;padding:13px 15px;background:var(--surf);border:1px solid var(--botbd);border-radius:16px;border-bottom-right-radius:6px}',
    '.mjd-typing i{width:7px;height:7px;border-radius:50%;background:var(--soft);animation:mjdBlink 1.3s infinite}',
    '.mjd-typing i:nth-child(2){animation-delay:.2s}.mjd-typing i:nth-child(3){animation-delay:.4s}',
    '@keyframes mjdBlink{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}',
    '/* input */',
    '.mjd-ip{padding:12px 14px;border-top:1px solid var(--line);display:flex;align-items:center;gap:9px;background:var(--bar)}',
    '.mjd-box{flex:1;display:flex;align-items:center;background:var(--surf2);border:1px solid var(--line);border-radius:999px;padding:0 15px;height:46px;transition:border-color .16s,box-shadow .16s}',
    '.mjd-box:focus-within{border-color:#7c5cff;box-shadow:0 0 0 4px rgba(124,92,255,.18)}',
    '.mjd-box input{flex:1;background:transparent;border:0;outline:none;color:var(--text);font:inherit;font-size:13.5px}',
    '.mjd-box input::placeholder{color:var(--soft)}',
    '.mjd-snd{width:42px;height:42px;border-radius:50%;border:0;cursor:pointer;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,#7c5cff,#06b6d4);box-shadow:0 8px 22px rgba(124,92,255,.45);transition:transform .14s}',
    '.mjd-snd:hover{transform:scale(1.06)}.mjd-snd svg{width:18px;height:18px;transform:scaleX(-1)}',
    '.mjd-credit{text-align:center;font-size:10.5px;color:var(--soft);padding:7px 0 10px;background:var(--bar);font-weight:600}',
    '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}'
  ].join('');

  function inject(tag, attrs, html) {
    var el = document.createElement(tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    if (html != null) el.innerHTML = html;
    return el;
  }

  // ---------- icons ----------
  var I = {
    wa: '<svg viewBox="0 0 32 32" fill="currentColor"><path d="M16 2C8.3 2 2 8.3 2 16c0 2.5.7 4.9 1.8 7L2 30l7.3-1.8A14 14 0 1016 2zm6.3 17c-.3-.2-2-1-2.4-1.1-.3-.1-.5-.2-.8.2s-.9 1.1-1.1 1.4c-.2.2-.4.3-.7.1-1.8-.7-3.3-2-4.5-3.8-.2-.4 0-.5.2-.7l.5-.6c.2-.2.2-.4.4-.6.1-.2 0-.5 0-.6l-1-2.5c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-1 1-1.2 2.3-.8 3.7.5 1.6 1.6 3 3 4.3 2 1.7 3.7 2.2 4.4 2.3.7.1 1.6 0 2.1-.6.3-.4.5-.9.4-1.2z"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 6 10 7L22 6"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
  };

  // ---------- build DOM ----------
  var root = inject('div', { id: 'mjd-root', 'data-side': CFG.position === 'left' ? 'left' : 'right' });
  var styleEl = inject('style', {}, CSS);
  document.head.appendChild(styleEl);

  root.appendChild(inject('div', {}, '' +
    '<div id="mjd-panel" data-theme="' + THEME + '" role="dialog" aria-label="محادثة ماجد">' +
      '<div class="mjd-hd">' +
        '<img src="' + AVATAR + '"' + AVA_ERR + ' alt="ماجد"/>' +
        '<div class="mjd-nm"><b>ماجد</b><s>● متاح الآن</s></div>' +
        '<div class="mjd-tools">' +
          '<button class="mjd-ic" id="mjd-theme" aria-label="تبديل الثيم">' + I.moon + '</button>' +
          '<button class="mjd-ic" id="mjd-x" aria-label="إغلاق">' + I.close + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="mjd-cbar">' +
        '<a class="mjd-cb mjd-wa" href="https://wa.me/' + WA + '" target="_blank" rel="noopener">' + I.wa + 'واتساب</a>' +
        '<a class="mjd-cb" href="mailto:' + EMAIL + '">' + I.mail + 'إيميل</a>' +
        '<button class="mjd-cb mjd-vo" id="mjd-voice" type="button">' + I.mic + 'فويس <span class="mjd-soon">قريبًا</span></button>' +
      '</div>' +
      '<div class="mjd-bd" id="mjd-bd"></div>' +
      '<div class="mjd-ip">' +
        '<div class="mjd-box"><input id="mjd-in" type="text" placeholder="اكتب رسالتك لماجد..." aria-label="رسالة"/></div>' +
        '<button class="mjd-snd" id="mjd-send" aria-label="إرسال">' + I.send + '</button>' +
      '</div>' +
      '<div class="mjd-credit">مدعوم بواسطة Engosoft</div>' +
    '</div>' +
    '<button id="mjd-fab" aria-label="تحدّث مع ماجد"><span class="mjd-ring"></span><img src="' + AVATAR + '"' + AVA_ERR + ' alt="ماجد"/><span class="mjd-dot"></span></button>'
  ));
  document.body.appendChild(root);

  var panel = document.getElementById('mjd-panel');
  var bd = document.getElementById('mjd-bd');
  var input = document.getElementById('mjd-in');

  // ---------- rendering ----------
  function scrollDown() { bd.scrollTop = bd.scrollHeight; }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function addBot(html) {
    var row = inject('div', { class: 'mjd-row mjd-bot' },
      '<img class="mjd-mini" src="' + AVATAR + '"' + AVA_ERR + '/><div class="mjd-bub">' + html + '</div>');
    bd.appendChild(row); scrollDown();
  }
  function addMe(text) {
    var row = inject('div', { class: 'mjd-row mjd-me' }, '<div class="mjd-bub">' + esc(text) + '</div>');
    bd.appendChild(row); scrollDown();
  }
  function addCard(attrs) {
    var items = (attrs && attrs.items) || [];
    items.forEach(function (it) {
      var h = '<div class="mjd-ct"><b>' + esc(it.title) + '</b>' + (it.description ? '<span>' + esc(it.description) + '</span>' : '') + '</div>';
      (it.actions || []).forEach(function (a, i) {
        if (a.type === 'link') h += '<a href="' + esc(a.uri) + '" target="_blank" rel="noopener">' + esc(a.text) + '</a>';
        else h += '<button data-pb="' + esc(a.payload || a.text) + '">' + esc(a.text) + '</button>';
      });
      var card = inject('div', { class: 'mjd-card' }, h);
      card.querySelectorAll('button[data-pb]').forEach(function (btn) {
        btn.addEventListener('click', function () { sendMessage(btn.getAttribute('data-pb')); });
      });
      bd.appendChild(card); scrollDown();
    });
  }
  var typingEl = null;
  function showTyping() {
    if (typingEl) return;
    typingEl = inject('div', { class: 'mjd-typing' }, '<i></i><i></i><i></i>');
    bd.appendChild(typingEl); scrollDown();
  }
  function hideTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }

  // ---------- network ----------
  function fetchUserContext() {
    return fetch(USER_CTX_URL, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (ctx) {
        if (!ctx) return {};
        var u = ctx.user || {}, lp = ctx.learning_progress || {};
        return {
          name: u.name || '', email: u.email || '',
          odoo_user_id: String(u.user_id || ''),
          enrolled_courses: String(lp.total_courses_enrolled || 0),
          remaining_lessons: String(lp.total_remaining_lessons || 0),
          progress_percent: String(lp.average_progress || 0),
          courses_json: JSON.stringify(ctx.courses || [])
        };
      })
      .catch(function () { return {}; });
  }

  function openStream() {
    if (!convId || es) return;
    es = new EventSource(BRIDGE + '/widget/stream?conversationId=' + encodeURIComponent(convId));
    es.addEventListener('message', function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      hideTyping();
      if (m.content_type === 'cards' && m.content_attributes) {
        if (m.content) addBot(esc(m.content));
        addCard(m.content_attributes);
      } else if (m.content) {
        addBot(esc(m.content));
      }
    });
    es.onerror = function () { /* EventSource auto-reconnects */ };
  }

  function startSession() {
    if (started) return Promise.resolve();
    started = true;
    return fetchUserContext().then(function (ud) {
      userData = ud || {};
      return fetch(BRIDGE + '/widget/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: userData.name, email: userData.email, userData: userData })
      });
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.conversationId) { convId = d.conversationId; openStream(); }
      else { addBot('تعذّر بدء المحادثة، حاول تاني بعد لحظات.'); started = false; }
    }).catch(function () { addBot('تعذّر الاتصال، حاول تاني.'); started = false; });
  }

  function sendMessage(text) {
    text = (text || '').trim(); if (!text) return;
    addMe(text);
    if (!convId) { startSession().then(function () { if (convId) postMsg(text); }); return; }
    postMsg(text);
  }
  function postMsg(text) {
    showTyping();
    fetch(BRIDGE + '/widget/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: convId, text: text, userData: userData })
    }).catch(function () { hideTyping(); addBot('تعذّر إرسال الرسالة.'); });
  }

  // ---------- interactions ----------
  var fab = document.getElementById('mjd-fab');
  function openPanel() { panel.classList.add('mjd-open'); startSession(); setTimeout(function () { input.focus(); }, 200); }
  function closePanel() { panel.classList.remove('mjd-open'); }
  fab.addEventListener('click', function () { panel.classList.contains('mjd-open') ? closePanel() : openPanel(); });
  document.getElementById('mjd-x').addEventListener('click', closePanel);
  document.getElementById('mjd-send').addEventListener('click', function () { sendMessage(input.value); input.value = ''; });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { sendMessage(input.value); input.value = ''; } });
  document.getElementById('mjd-voice').addEventListener('click', function () {
    addBot('ماجد فويس قريّب جدًا 🎙️ — حاليًا أقدر أساعدك كتابة أو أوصّلك بموظف.');
  });
  document.getElementById('mjd-theme').addEventListener('click', function () {
    panel.setAttribute('data-theme', panel.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
})();
