/*!
 * Majed «نور» Widget — custom chat widget for Engosoft (Path B)
 * Loads on the Odoo site, talks to the bridge (Railway):
 *   POST {bridge}/widget/session        → { conversationId }
 *   GET  {bridge}/widget/stream         → SSE (bot + agent replies, real-time)
 *   POST {bridge}/widget/message        → send customer message (+ trainee userData)
 *   POST {bridge}/widget/upload         → send customer attachment (multipart)
 *   GET  {bridge}/widget/messages       → conversation transcript (restore/history)
 *   GET  {bridge}/widget/conversations  → summaries for the history list
 *
 * Configure before this script loads:
 *   window.MajedConfig = {
 *     bridgeUrl:       'https://your-bridge.up.railway.app',   // REQUIRED
 *     userContextUrl:  '/ai_webhook/user_context',             // Odoo endpoint (optional)
 *     avatarUrl:       '/ai_user_context_webhook/static/src/img/majed-avatar.png',
 *     waNumber:        '966920016295',
 *     supportEmail:    'aibot@engosoft.com',
 *     theme:           'light',                                // 'light' | 'dark'
 *     greeting:        'أهلاً، أنا ماجد',
 *     courseUrl:       'https://engosoft.com/shop/the-freelance-masterclass-2056',
 *     promoCode:       'free100',    // كود عرض الزوار (دورة مجانية)
 *     discountCode:    'engo20',     // كود خصم المسجّلين (20% على أي دورة)
 *     teaserDelay:     3500,      // ms before the attention bubble appears
 *     teaserRotate:    9000,      // ms between teaser messages
 *     teasers:         [{ html, link, linkText, code, codeLabel, botMessage, botMessageLabel, showOn, showOnSelector, guestOnly, loggedInOnly }]
 *       // guestOnly:     يظهر للزوار قبل اللوجين فقط.
 *       // loggedInOnly:  يظهر للعملاء المسجّلين (بعد اللوجين) فقط.
 *       // showOn:   string | string[] — يظهر التيزر فقط لما يطابق الـ URL أحد الأنماط (substring),
 *       //           مثال: showOn:'/shop'  أو  showOn:['engosoft.com/shop','/course'] . بدونها يظهر في كل الصفحات.
 *       // showOnSelector: CSS selector — يظهر التيزر لو العنصر ده موجود في الصفحة (بديل/إضافة لـ showOn).
 *       // ملاحظة: لو في تيزر مستهدَف مطابق للصفحة، بيظهر لوحده وبتختفي التيزرات العامة (زي الترحيب).
 *       // botMessage / botMessageLabel: زرار يفتح الشات ويبعت رسالة جاهزة للبوت (يشغّل فلو المبيعات).
 *       // {{course}} داخل html أو botMessage يتحوّل تلقائيًا لاسم الكورس المقروء من الصفحة الحالية.
 *     courseNameSelector: 'h1[itemprop="name"]',   // (اختياري) من فين يقرأ اسم الكورس — الافتراضي يغطي صفحات Odoo
 *   };
 *
 *   // بديل بدون تعديل الصفحة: التحكم من البريدج (Railway env vars) عبر window.MajedServerConfig
 *   // اللي البريدج بيحقنها في أول الملف. الأولوية: MajedConfig > MajedServerConfig > الافتراضي المدمج.
 *   // أمثلة env: MAJED_PROMO_CODE, MAJED_COURSE_TEASER_HTML/_MSG/_LABEL, MAJED_COURSE_SHOWON, MAJED_TEASERS_JSON.
 */
(function () {
  'use strict';
  if (window.__majedWidgetLoaded) return;
  window.__majedWidgetLoaded = true;

  // bump on every release; AVATAR_VERSION = sha256[0:16] of public/majed-avatar.png
  var WIDGET_VERSION = '4.6.0';
  var AVATAR_VERSION = 'a73382e0227f2703';
  var ODOO_AVATAR_PATH = '/ai_user_context_webhook/static/src/img/majed-avatar.png';

  var CFG = window.MajedConfig || {};
  // إعدادات جاية من البريدج (Railway env vars) — أولوية أقل من MajedConfig وأعلى من الافتراضي المدمج.
  // بتتحقن في أول الملف المقدَّم من /majed-widget.js (شوف integration/bridge/index.js).
  var SCFG = window.MajedServerConfig || {};
  var BRIDGE = (CFG.bridgeUrl || '').replace(/\/$/, '');
  if (!BRIDGE) { console.error('[Majed] MajedConfig.bridgeUrl is required'); return; }
  var USER_CTX_URL = CFG.userContextUrl || '/ai_webhook/user_context';

  // Canonical avatar = the bridge copy (Railway) with a content-hash query → immutable
  // cache, updates the moment a new image is deployed. The Odoo static path (legacy
  // default) and empty values resolve to the canonical URL; a genuinely custom URL
  // (e.g. company CDN) is respected. Whatever is primary, the other is the onerror
  // fallback, so the picture can never break.
  var AVATAR_CANON = BRIDGE + '/majed-avatar.png?v=' + AVATAR_VERSION;
  var cfgAvatar = String(CFG.avatarUrl || '').trim();
  var avatarIsCustom = cfgAvatar &&
    cfgAvatar.indexOf(ODOO_AVATAR_PATH) === -1 &&
    cfgAvatar.replace(/\?.*$/, '') !== BRIDGE + '/majed-avatar.png';
  var AVATAR = avatarIsCustom ? cfgAvatar : AVATAR_CANON;
  var AVATAR_FB = avatarIsCustom ? AVATAR_CANON : ODOO_AVATAR_PATH;
  var AVA_ERR = ' onerror="this.onerror=null;this.src=\'' + AVATAR_FB + '\'"';
  // واتساب + إيميل: أولوية Railway (SCFG) لو متحطّة، وإلا إعداد صفحة Odoo (CFG)، وإلا الافتراضي.
  // كده تقدر تتحكم فيهم من Railway env (WA_NUMBER / SUPPORT_EMAIL) من غير ما تلمس Odoo.
  var WA = String(SCFG.waNumber || CFG.waNumber || '966920016295').replace(/[^\d]/g, '');
  var EMAIL = SCFG.supportEmail || CFG.supportEmail || 'aibot@engosoft.com';
  var THEME = CFG.theme === 'dark' ? 'dark' : 'light';
  var GREETING = CFG.greeting || 'أهلاً، أنا ماجد';
  var COURSE_URL = CFG.courseUrl || SCFG.courseUrl || 'https://engosoft.com/shop/the-freelance-masterclass-2056';
  var PROMO_CODE = CFG.promoCode || SCFG.promoCode || 'free100';
  // كود خصم العملاء المسجّلين (20% على أي دورة) — قابل للتخصيص من الصفحة أو Railway env
  var DISCOUNT_CODE = CFG.discountCode || SCFG.discountCode || 'engo20';
  var TZ_DELAY = Number(CFG.teaserDelay) > 0 ? Number(CFG.teaserDelay) : 3500;
  var TZ_ROTATE = Number(CFG.teaserRotate) > 2000 ? Number(CFG.teaserRotate) : 9000;
  var MAX_FILE_MB = 10;
  var STORE_PREFIX = 'majed:conversation:' + BRIDGE + ':';
  var LIST_PREFIX = 'majed:convlist:' + BRIDGE + ':';

  // تيزر صفحة الكورس — قابل للتخصيص بالكامل من Railway env vars (عبر SCFG.courseTeaser)
  var ct = SCFG.courseTeaser || {};
  var COURSE_TEASER = {
    showOn: ct.showOn || ['/shop', '/course'],
    showOnSelector: ct.showOnSelector || null,
    html: ct.html || '🛒 محتاج مساعدة في شراء «{{course}}»؟<br/>أو عايز تعرف لو في عرض حاليًا؟',
    botMessage: ct.botMessage || 'محتاج مساعدة في شراء كورس «{{course}}»، وممكن تقوللي لو في عرض؟',
    botMessageLabel: ct.botMessageLabel || '💬 ساعدني في الشراء',
    code: ct.code || PROMO_CODE,
    codeLabel: ct.codeLabel || 'كود الخصم'
  };
  // تيزر صفحة الكورس للعملاء المسجّلين — نفس فكرة «مساعدة الشراء» + خصم 20% بكود engo20.
  // بيظهر بعد اللوجين فقط وعلى صفحات الكورس فقط (نفس استهداف COURSE_TEASER).
  var cti = SCFG.courseTeaserLoggedIn || {};
  var COURSE_TEASER_IN = {
    loggedInOnly: true,
    showOn: cti.showOn || COURSE_TEASER.showOn,
    showOnSelector: cti.showOnSelector || COURSE_TEASER.showOnSelector,
    html: cti.html || '🛒 محتاج مساعدة في شراء «{{course}}»؟<br/>معاك خصم <b>20%</b> على الدورة دي بالكود 👇',
    botMessage: cti.botMessage || 'محتاج مساعدة في شراء كورس «{{course}}»، ومعايا كود خصم ' + DISCOUNT_CODE + '.',
    botMessageLabel: cti.botMessageLabel || '💬 ساعدني في الشراء',
    code: cti.code || DISCOUNT_CODE,
    codeLabel: cti.codeLabel || 'كود الخصم ' + DISCOUNT_CODE
  };
  // الرسالة اللي بتلفت انتباه العميل.
  // الأولوية: MajedConfig.teasers (الصفحة) ← MajedServerConfig.teasers (Railway) ← الافتراضي المدمج.
  var TEASERS = (CFG.teasers && CFG.teasers.length) ? CFG.teasers
    : (SCFG.teasers && SCFG.teasers.length) ? SCFG.teasers
    : [
      { html: 'أهلاً! أنا <b>ماجد</b>، مستشارك التعليمي 👋<br/>اسألني عن أي كورس أو خطّتك التعليمية' },
      {
        // عرض الكورس المجاني — يظهر قبل اللوجين فقط (للزوار)
        guestOnly: true,
        html: '🎁 دورة <b>احتراف العمل الحر - Freelance</b><br/><b>مجاناً</b> 🎉<br/>أنشئ حسابك واحصل على هديتك 👇',
        link: COURSE_URL, linkText: 'رابط الدورة', code: PROMO_CODE, codeLabel: 'كود الخصم'
      },
      {
        // خصم 20% على أي دورة — يظهر بعد اللوجين فقط (للعملاء المسجّلين)
        loggedInOnly: true,
        html: '🎉 خصم <b>20%</b> على <b>أي دورة</b>!<br/>استخدم الكود ده عند الشراء 👇',
        link: COURSE_URL, linkText: 'تصفّح الدورات', code: DISCOUNT_CODE, codeLabel: 'كود الخصم ' + DISCOUNT_CODE
      },
      COURSE_TEASER,
      COURSE_TEASER_IN
    ];

  // ---------- state ----------
  var convId = null, es = null, started = false, userData = {};
  var ctxPromise = null;          // user-context fetch (once)
  var seenIds = {};               // message-id de-dup between transcript + SSE
  var loadingTranscript = false;  // buffer SSE renders while a transcript loads
  var pendingEvents = [];
  var pendingFile = null;         // file picked but not sent yet
  var pendingThumb = '';          // objectURL of the pending image preview
  var uploading = false;
  var forceNew = false;           // «محادثة جديدة»: skip the stored conversation id
  var live = false;               // customer actually chatting → glass header
  var tzTimer = null, tzRotateTimer = null, tzIndex = 0, tzVisible = false;

  // ---------- styles ----------
  var CSS = [
    '@import url("https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap");',
    '#mjd-root{position:fixed;bottom:22px;left:22px;z-index:2147483000;direction:rtl;font-family:"Tajawal",system-ui,sans-serif}',
    '#mjd-root[data-side="right"]{left:auto;right:22px}',
    '/* launcher */',
    '#mjd-fab{width:64px;height:64px;border-radius:50%;cursor:pointer;border:0;padding:3px;position:relative;touch-action:none;',
    'background:linear-gradient(150deg,#fff,#e7e1ff);box-shadow:0 12px 30px rgba(124,92,255,.34),0 4px 16px rgba(6,182,212,.2);',
    'transition:transform .2s cubic-bezier(.2,.9,.2,1),opacity .25s ease}',
    '#mjd-fab:hover{transform:translateY(-3px) scale(1.05)}#mjd-fab:active{transform:scale(.96)}',
    '#mjd-fab img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}',
    '#mjd-fab .mjd-dot{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#16a34a;border:2.5px solid #fff}',
    '#mjd-root[data-side="right"] #mjd-fab .mjd-dot{left:auto;right:2px}',
    '#mjd-fab .mjd-ring{position:absolute;inset:-6px;border-radius:50%;border:1.5px solid rgba(124,92,255,.3);animation:mjdBreathe 2.8s ease-in-out infinite;pointer-events:none}',
    '@keyframes mjdBreathe{0%,100%{transform:scale(1);opacity:.5}50%{transform:scale(1.07);opacity:.85}}',
    '/* teaser (attention bubble) */',
    '#mjd-tz{position:absolute;bottom:84px;left:0;width:min(305px,calc(100vw - 104px));cursor:pointer;display:none;',
    'background:rgba(255,255,255,.94);backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);',
    'border:1px solid rgba(124,92,255,.16);border-radius:18px;border-bottom-left-radius:6px;padding:12px 13px;',
    'box-shadow:0 18px 44px rgba(15,30,66,.18),0 4px 14px rgba(124,92,255,.12)}',
    '#mjd-root[data-side="right"] #mjd-tz{left:auto;right:0;border-bottom-left-radius:18px;border-bottom-right-radius:6px}',
    '#mjd-tz.mjd-on{display:block;animation:mjdTzIn .38s cubic-bezier(.2,.9,.3,1.2) both}',
    '@keyframes mjdTzIn{from{opacity:0;transform:translateY(10px) scale(.95)}to{opacity:1;transform:none}}',
    '#mjd-tz .mjd-tz-in{display:flex;gap:10px;align-items:flex-start;transition:opacity .25s ease,transform .25s ease}',
    '#mjd-tz.mjd-swap .mjd-tz-in{opacity:0;transform:translateY(7px)}',
    '#mjd-tz img{width:38px;height:38px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1.5px solid rgba(124,92,255,.25)}',
    '#mjd-tz .mjd-tz-tx{font-size:13px;line-height:1.65;color:#171b2e;font-weight:500}',
    '#mjd-tz .mjd-tz-tx b{font-weight:800}',
    '#mjd-tz .mjd-tz-act{display:flex;gap:7px;margin-top:9px;flex-wrap:wrap}',
    '#mjd-tz .mjd-tz-go{display:inline-flex;align-items:center;gap:5px;background:linear-gradient(135deg,#7c5cff,#06b6d4);color:#fff;',
    'font:inherit;font-size:12px;font-weight:800;border:0;border-radius:999px;padding:7px 13px;cursor:pointer;text-decoration:none}',
    '#mjd-tz .mjd-tz-code{display:inline-flex;align-items:center;gap:5px;border:1.5px dashed rgba(124,92,255,.55);color:#7c5cff;',
    'font-size:12px;font-weight:800;border-radius:999px;padding:6px 12px;cursor:pointer;background:rgba(124,92,255,.06);font-family:inherit}',
    '#mjd-tz .mjd-tz-x{position:absolute;top:-9px;left:-9px;width:22px;height:22px;border-radius:50%;border:0;cursor:pointer;',
    'background:#171b2e;color:#fff;font-size:12px;line-height:1;display:grid;place-items:center;box-shadow:0 4px 10px rgba(15,30,66,.3)}',
    '#mjd-root[data-side="right"] #mjd-tz .mjd-tz-x{left:auto;right:-9px}',
    '/* panel */',
    '#mjd-panel{position:absolute;bottom:80px;left:0;width:380px;max-width:calc(100vw - 44px);height:600px;max-height:calc(100vh - 120px);',
    'border-radius:22px;overflow:hidden;display:none;flex-direction:column;box-shadow:0 28px 70px rgba(15,30,66,.28);',
    'opacity:0;transform:translateY(10px) scale(.98);transition:opacity .22s ease,transform .22s ease}',
    '#mjd-root[data-side="right"] #mjd-panel{left:auto;right:0}',
    '#mjd-panel.mjd-open{display:flex;opacity:1;transform:none}',
    '/* theme tokens */',
    '#mjd-panel[data-theme="light"]{--bg:#f7f8fc;--surf:#fff;--surf2:#f3f4fa;--line:#ebedf4;--text:#171b2e;--muted:#6b7280;--soft:#8b90a3;--botbd:#ececf4;--bar:#fff;--pill:#f6f7fb;--pillbd:#e9ebf3;--pilltx:#2d3550;--wa:#1fa855;--wabg:rgba(31,168,85,.1);--wabd:rgba(31,168,85,.28);--glass:rgba(255,255,255,.62);--glassbd:rgba(23,27,46,.07)}',
    '#mjd-panel[data-theme="dark"]{--bg:#0e1326;--surf:rgba(255,255,255,.05);--surf2:rgba(255,255,255,.06);--line:rgba(255,255,255,.09);--text:#e9edf8;--muted:#9aa3bd;--soft:#7e87a3;--botbd:rgba(255,255,255,.1);--bar:rgba(255,255,255,.04);--pill:rgba(255,255,255,.05);--pillbd:rgba(255,255,255,.11);--pilltx:#e9edf8;--wa:#7ff0a8;--wabg:rgba(37,211,102,.16);--wabd:rgba(37,211,102,.4);--glass:rgba(14,19,38,.55);--glassbd:rgba(255,255,255,.09)}',
    '#mjd-panel{background:var(--bg);color:var(--text)}',
    '#mjd-panel[data-theme="dark"]{background:radial-gradient(560px 300px at 86% -8%,rgba(124,92,255,.35),transparent 60%),radial-gradient(520px 300px at 0% 102%,rgba(34,211,238,.2),transparent 60%),#0e1326}',
    '/* header */',
    '.mjd-hd{display:flex;align-items:center;gap:11px;padding:13px 15px;border-bottom:1px solid var(--line);transition:padding .25s ease;',
    'cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}',
    '.mjd-hd img{width:40px;height:40px;border-radius:13px;object-fit:cover;border:1px solid var(--line);transition:width .25s ease,height .25s ease}',
    '.mjd-hd .mjd-nm b{font-size:15.5px;font-weight:800;display:block}',
    '.mjd-hd .mjd-nm s{text-decoration:none;font-size:11.5px;color:#16a34a}',
    '#mjd-panel[data-theme="dark"] .mjd-hd .mjd-nm s{color:#7df3c4}',
    '.mjd-hd .mjd-tools{margin-inline-start:auto;display:flex;gap:6px}',
    '.mjd-ic{width:36px;height:36px;border-radius:10px;border:1px solid var(--line);background:var(--surf);color:var(--muted);cursor:pointer;display:grid;place-items:center;text-decoration:none}',
    '.mjd-ic:hover{color:var(--text)}.mjd-ic svg{width:18px;height:18px}',
    '.mjd-live-ic{display:none!important}',
    '/* «وضع المحادثة»: هيدر زجاجي مدمج + إخفاء شريط التواصل = مساحة شات أكبر */',
    '#mjd-panel.mjd-live .mjd-hd{position:absolute;top:0;left:0;right:0;z-index:6;border-bottom:1px solid var(--glassbd);',
    'background:var(--glass);backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);padding:8px 12px}',
    '#mjd-panel.mjd-live .mjd-hd img{width:32px;height:32px;border-radius:10px}',
    '#mjd-panel.mjd-live .mjd-hd .mjd-nm b{font-size:13.5px}',
    '#mjd-panel.mjd-live .mjd-hd .mjd-nm s{font-size:10.5px}',
    '#mjd-panel.mjd-live .mjd-ic{width:32px;height:32px;border-radius:9px;background:transparent;border-color:transparent}',
    '#mjd-panel.mjd-live .mjd-ic:hover{background:var(--surf2)}',
    '#mjd-panel.mjd-live .mjd-live-ic{display:grid!important}',
    '#mjd-panel.mjd-live .mjd-cbar{display:none}',
    '#mjd-panel.mjd-live .mjd-bd{padding-top:64px}',
    '/* pinned contact bar */',
    '.mjd-cbar{display:flex;gap:8px;padding:10px 14px;background:var(--bar);border-bottom:1px solid var(--line)}',
    '.mjd-cb{flex:1;display:flex;align-items:center;justify-content:center;gap:7px;height:40px;border-radius:11px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;text-decoration:none;background:var(--pill);border:1px solid var(--pillbd);color:var(--pilltx);transition:transform .14s}',
    '.mjd-cb:hover{transform:translateY(-1px)}.mjd-cb svg{width:16px;height:16px}',
    '.mjd-cb.mjd-wa{background:var(--wabg);border-color:var(--wabd);color:var(--wa)}',
    '.mjd-cb.mjd-vo{opacity:.62}',
    '.mjd-cb .mjd-soon{font-size:9px;font-weight:800;background:#f59e0b;color:#fff;border-radius:999px;padding:1px 6px}',
    '/* body */',
    '.mjd-bd{flex:1;overflow-y:auto;overflow-x:hidden;padding:16px 14px;display:flex;flex-direction:column;gap:12px;transition:padding-top .25s ease}',
    '/* فقاعات الشات داخل column flex لازم flex-shrink:0 — غيره فقاعات الصور بتنهرس لارتفاع صفر أول ما المحادثة تطول */',
    '.mjd-bd>*{flex-shrink:0}',
    '.mjd-row{display:flex;gap:8px;align-items:flex-end;max-width:88%;min-width:0;animation:mjdRise .3s ease both}',
    '.mjd-row.mjd-bot{align-self:flex-start}.mjd-row.mjd-me{align-self:flex-end}',
    '@keyframes mjdRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
    '.mjd-mini{width:27px;height:27px;border-radius:9px;object-fit:cover;flex-shrink:0;border:1px solid var(--line)}',
    '.mjd-bub{font-size:14px;line-height:1.7;padding:11px 14px;border-radius:16px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;word-break:break-word;max-width:100%;min-width:0}',
    '.mjd-bot .mjd-bub{background:var(--surf);border:1px solid var(--botbd);border-bottom-right-radius:6px}',
    '.mjd-bub a{color:#7c5cff;text-decoration:underline;font-weight:500;word-break:break-all}',
    '.mjd-me .mjd-bub a{color:#fff}',
    '.mjd-me .mjd-bub{background:linear-gradient(135deg,#7c5cff,#06b6d4);color:#fff;border-bottom-left-radius:6px}',
    '.mjd-card{align-self:flex-start;width:86%;background:var(--surf);border:1px solid var(--botbd);border-radius:14px;overflow:hidden;animation:mjdRise .3s ease both}',
    '.mjd-card img{width:100%;max-height:160px;object-fit:cover;display:block;background:var(--surf2)}',
    '.mjd-card .mjd-ct{padding:11px 13px}.mjd-card .mjd-ct b{font-size:14px;display:block}.mjd-card .mjd-ct span{font-size:12px;color:var(--muted)}',
    '.mjd-card a,.mjd-card button{display:flex;align-items:center;gap:8px;padding:11px 13px;font:inherit;font-size:13px;font-weight:700;color:#7c5cff;text-decoration:none;cursor:pointer;border:0;background:transparent;border-top:1px solid var(--line);width:100%;text-align:start}',
    '.mjd-card a:hover,.mjd-card button:hover{background:var(--surf2)}',
    '.mjd-options{align-self:flex-start;display:flex;flex-wrap:wrap;gap:8px;max-width:88%;animation:mjdRise .3s ease both}',
    '.mjd-opt{border:1px solid rgba(124,92,255,.28);background:var(--surf);color:#7c5cff;border-radius:999px;padding:9px 12px;font:inherit;font-size:12.5px;font-weight:800;cursor:pointer}',
    '.mjd-opt:hover{background:var(--surf2)}',
    '.mjd-media{align-self:flex-start;max-width:88%;min-width:0;background:var(--surf);border:1px solid var(--botbd);border-radius:14px;overflow:hidden;animation:mjdRise .3s ease both}',
    '.mjd-media.mjd-mine{align-self:flex-end}',
    '/* صورة الرسالة: بعرض الفقاعة وبنسبتها الأصلية كاملة — ممنوع القص أو السكرول الأفقي */',
    '.mjd-media.mjd-haspic{width:88%}',
    '.mjd-media .mjd-pic{display:block;position:relative;line-height:0;background:var(--surf2);cursor:zoom-in;-webkit-tap-highlight-color:transparent}',
    '.mjd-media img{width:100%;height:auto;max-height:none;object-fit:contain;display:block;border:0}',
    '.mjd-media.mjd-imgloading .mjd-pic{min-height:130px;background:linear-gradient(90deg,var(--surf2),var(--surf),var(--surf2));background-size:200% 100%;animation:mjdShimmer 1.2s linear infinite}',
    '.mjd-media.mjd-imgloading img{opacity:0}',
    '/* الصور الطويلة جدًا فقط: سقف ارتفاع + contain (إطار بدون قص) + زر الحجم الكامل */',
    '.mjd-media.mjd-tall img{max-height:340px}',
    '.mjd-media .mjd-full{position:absolute;bottom:8px;inset-inline-start:8px;display:none;align-items:center;gap:5px;border:0;cursor:pointer;',
    'background:rgba(15,23,42,.72);color:#fff;font:inherit;font-size:11px;font-weight:800;border-radius:999px;padding:6px 11px;line-height:1}',
    '.mjd-media.mjd-tall .mjd-full{display:inline-flex}',
    '.mjd-media video{width:100%;max-height:300px;display:block;background:#000}',
    '.mjd-media audio{width:260px;max-width:100%;display:block;margin:10px}',
    '.mjd-media a:not(.mjd-pic){display:block;padding:11px 13px;color:#7c5cff;text-decoration:none;font-weight:800;word-break:break-word;font-size:13px}',
    '.mjd-media .mjd-pic+a{padding-top:9px}',
    '.mjd-media .mjd-imgerr{display:flex;align-items:center;gap:9px;padding:11px 13px;color:var(--muted);font-size:12.5px;line-height:1.6}',
    '.mjd-media .mjd-imgerr a:not(.mjd-pic){display:inline;padding:0;font-size:12.5px}',
    '.mjd-file{display:flex;align-items:center;gap:9px;padding:10px 13px;text-decoration:none;color:inherit}',
    '.mjd-file .mjd-fi{width:36px;height:36px;border-radius:10px;background:rgba(124,92,255,.12);color:#7c5cff;display:grid;place-items:center;flex-shrink:0}',
    '.mjd-file .mjd-fi svg{width:18px;height:18px}',
    '.mjd-file b{font-size:12.5px;display:block;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mjd-file span{font-size:11px;color:var(--muted)}',
    '.mjd-typing{align-self:flex-start;display:flex;gap:5px;padding:13px 15px;background:var(--surf);border:1px solid var(--botbd);border-radius:16px;border-bottom-right-radius:6px}',
    '.mjd-typing i{width:7px;height:7px;border-radius:50%;background:var(--soft);animation:mjdBlink 1.3s infinite}',
    '.mjd-typing i:nth-child(2){animation-delay:.2s}.mjd-typing i:nth-child(3){animation-delay:.4s}',
    '@keyframes mjdBlink{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}',
    '/* pending attachment chip */',
    '.mjd-attbar{display:none;align-items:center;gap:9px;margin:0 14px;padding:8px 10px;background:var(--surf2);border:1px dashed var(--pillbd);border-radius:13px}',
    '.mjd-attbar.mjd-on{display:flex}',
    '.mjd-attbar img{width:38px;height:38px;border-radius:9px;object-fit:cover}',
    '.mjd-attbar .mjd-fi{width:38px;height:38px;border-radius:9px;background:rgba(124,92,255,.12);color:#7c5cff;display:grid;place-items:center}',
    '.mjd-attbar .mjd-fi svg{width:18px;height:18px}',
    '.mjd-attbar b{font-size:12px;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}',
    '.mjd-attbar span{font-size:10.5px;color:var(--muted)}',
    '.mjd-attbar .mjd-att-x{margin-inline-start:auto;width:26px;height:26px;border-radius:8px;border:0;background:transparent;color:var(--muted);cursor:pointer;font-size:14px}',
    '.mjd-attbar .mjd-att-x:hover{color:#ef4444}',
    '/* input */',
    '.mjd-ip{padding:12px 14px;border-top:1px solid var(--line);display:flex;align-items:center;gap:9px;background:var(--bar)}',
    '.mjd-box{flex:1;display:flex;align-items:center;gap:4px;background:var(--surf2);border:1px solid var(--line);border-radius:999px;padding:0 6px 0 15px;height:46px;transition:border-color .16s,box-shadow .16s}',
    '.mjd-box:focus-within{border-color:#7c5cff;box-shadow:0 0 0 4px rgba(124,92,255,.18)}',
    '.mjd-box input{flex:1;background:transparent;border:0;outline:none;color:var(--text);font:inherit;font-size:13.5px}',
    '.mjd-box input::placeholder{color:var(--soft)}',
    '.mjd-att-btn{width:34px;height:34px;border-radius:50%;border:0;background:transparent;color:var(--soft);cursor:pointer;display:grid;place-items:center;flex-shrink:0}',
    '.mjd-att-btn:hover{color:#7c5cff;background:rgba(124,92,255,.1)}.mjd-att-btn svg{width:18px;height:18px}',
    '.mjd-snd{width:42px;height:42px;border-radius:50%;border:0;cursor:pointer;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,#7c5cff,#06b6d4);box-shadow:0 8px 22px rgba(124,92,255,.45);transition:transform .14s}',
    '.mjd-snd:hover{transform:scale(1.06)}.mjd-snd svg{width:18px;height:18px;transform:scaleX(-1)}',
    '.mjd-snd[disabled]{opacity:.55;cursor:default;transform:none}',
    '.mjd-credit{text-align:center;font-size:10.5px;color:var(--soft);padding:7px 0 10px;background:var(--bar);font-weight:600}',
    '/* history overlay */',
    '.mjd-hist{position:absolute;inset:0;z-index:9;background:var(--bg);display:none;flex-direction:column}',
    '.mjd-hist.mjd-on{display:flex;animation:mjdHistIn .25s ease both}',
    '@keyframes mjdHistIn{from{opacity:0;transform:translateX(-14px)}to{opacity:1;transform:none}}',
    '.mjd-hist-hd{display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid var(--line);background:var(--bar)}',
    '.mjd-hist-hd b{font-size:15px;font-weight:800}',
    '.mjd-hist-hd .mjd-ic{margin-inline-start:auto}',
    '.mjd-hist-ls{flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
    '.mjd-hrow{display:flex;align-items:center;gap:10px;width:100%;text-align:start;padding:11px 12px;border-radius:14px;border:1px solid var(--line);background:var(--surf);cursor:pointer;font:inherit;color:var(--text)}',
    '.mjd-hrow:hover{border-color:rgba(124,92,255,.4)}',
    '.mjd-hrow.mjd-cur{border-color:#7c5cff;box-shadow:0 0 0 3px rgba(124,92,255,.14)}',
    '.mjd-hrow img{width:34px;height:34px;border-radius:11px;object-fit:cover;flex-shrink:0}',
    '.mjd-hrow .mjd-hx{flex:1;min-width:0}',
    '.mjd-hrow .mjd-hx b{display:block;font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mjd-hrow .mjd-hx span{font-size:11px;color:var(--muted)}',
    '.mjd-hrow .mjd-st{width:8px;height:8px;border-radius:50%;flex-shrink:0}',
    '.mjd-hrow .mjd-st[data-st="open"]{background:#f59e0b}.mjd-hrow .mjd-st[data-st="pending"]{background:#7c5cff}.mjd-hrow .mjd-st[data-st="resolved"]{background:#9ca3af}',
    '.mjd-hist-empty{text-align:center;color:var(--muted);font-size:13px;padding:40px 16px}',
    '.mjd-skel{height:58px;border-radius:14px;background:linear-gradient(90deg,var(--surf2),var(--surf),var(--surf2));background-size:200% 100%;animation:mjdShimmer 1.2s linear infinite}',
    '@keyframes mjdShimmer{from{background-position:200% 0}to{background-position:-200% 0}}',
    '.mjd-hist-new{margin:10px 14px 14px;height:44px;border-radius:13px;border:0;cursor:pointer;font:inherit;font-size:13.5px;font-weight:800;color:#fff;',
    'background:linear-gradient(135deg,#7c5cff,#06b6d4);box-shadow:0 10px 24px rgba(124,92,255,.35);display:flex;align-items:center;justify-content:center;gap:8px}',
    '.mjd-hist-new svg{width:16px;height:16px}',
    '/* ===== Liquid Glass — fallback تلقائي: المتصفح غير الداعم يبقى على الخلفية الصلبة ===== */',
    '@supports ((backdrop-filter:blur(20px)) or (-webkit-backdrop-filter:blur(20px))){',
    '#mjd-panel{-webkit-backdrop-filter:blur(20px) saturate(160%);backdrop-filter:blur(20px) saturate(160%)}',
    '#mjd-panel[data-theme="light"]{background:rgba(247,248,252,.78);box-shadow:0 28px 70px rgba(15,30,66,.3),inset 0 0 0 1px rgba(255,255,255,.55)}',
    '#mjd-panel[data-theme="dark"]{background:radial-gradient(560px 300px at 86% -8%,rgba(124,92,255,.3),transparent 60%),radial-gradient(520px 300px at 0% 102%,rgba(34,211,238,.16),transparent 60%),rgba(14,19,38,.74);box-shadow:0 28px 70px rgba(2,6,23,.5),inset 0 0 0 1px rgba(255,255,255,.1)}',
    '}',
    '/* أثناء تمرير الصفحة تقل الوضوح بدرجة بسيطة فقط — وترجع بعد توقف التمرير (200ms) */',
    '#mjd-tz{transition:opacity .25s ease}',
    '#mjd-root.mjd-page-scrolling #mjd-panel.mjd-open{opacity:.86}',
    '#mjd-root.mjd-page-scrolling #mjd-fab{opacity:.8}',
    '#mjd-root.mjd-page-scrolling #mjd-tz.mjd-on{opacity:.82}',
    '/* أثناء السحب */',
    '#mjd-root.mjd-dragging .mjd-hd,#mjd-root.mjd-dragging #mjd-fab{cursor:grabbing}',
    '#mjd-root.mjd-dragging,#mjd-root.mjd-dragging *{user-select:none!important;-webkit-user-select:none!important}',
    '#mjd-root.mjd-dragging #mjd-panel,#mjd-root.mjd-dragging #mjd-tz{transition:none}',
    '/* الإخفاء المؤقت + مقبض الحافة للاسترجاع */',
    '#mjd-root.mjd-hidden #mjd-fab,#mjd-root.mjd-hidden #mjd-panel,#mjd-root.mjd-hidden #mjd-tz{display:none!important}',
    '#mjd-edge{position:fixed;bottom:30px;width:34px;height:58px;z-index:2147483000;display:none;align-items:center;justify-content:center;',
    'border:1px solid rgba(124,92,255,.3);background:rgba(255,255,255,.88);-webkit-backdrop-filter:blur(12px) saturate(1.4);backdrop-filter:blur(12px) saturate(1.4);',
    'cursor:pointer;box-shadow:0 10px 26px rgba(15,30,66,.22);padding:0}',
    '#mjd-edge.mjd-on{display:flex}',
    '#mjd-edge[data-side="right"]{right:0;left:auto;border-radius:14px 0 0 14px;border-right:0}',
    '#mjd-edge[data-side="left"]{left:0;right:auto;border-radius:0 14px 14px 0;border-left:0}',
    '#mjd-edge img{width:26px;height:26px;border-radius:50%;object-fit:cover;display:block}',
    '/* وصولية: حلقة تركيز واضحة لعناصر التفاعل */',
    '#mjd-fab:focus-visible,#mjd-edge:focus-visible,.mjd-ic:focus-visible,.mjd-opt:focus-visible,.mjd-snd:focus-visible,.mjd-att-btn:focus-visible,.mjd-full:focus-visible,.mjd-hrow:focus-visible{outline:2px solid #7c5cff;outline-offset:2px}',
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
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
    hist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 3"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    hide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'
  };

  // ---------- build DOM ----------
  var root = inject('div', { id: 'mjd-root', 'data-side': CFG.position === 'left' ? 'left' : 'right' });
  var styleEl = inject('style', {}, CSS);
  document.head.appendChild(styleEl);

  root.appendChild(inject('div', {}, '' +
    '<div id="mjd-panel" data-theme="' + THEME + '" role="dialog" aria-label="محادثة ماجد">' +
      '<div class="mjd-hd" aria-label="اسحب لتحريك نافذة المحادثة" title="اسحب لتغيير المكان · دبل-كليك لإعادة الضبط">' +
        '<img src="' + AVATAR + '"' + AVA_ERR + ' alt="ماجد"/>' +
        '<div class="mjd-nm"><b>ماجد</b><s>● متاح الآن</s></div>' +
        '<div class="mjd-tools">' +
          '<a class="mjd-ic mjd-live-ic" href="https://wa.me/' + WA + '" target="_blank" rel="noopener" aria-label="واتساب" style="color:#1fa855">' + I.wa + '</a>' +
          '<a class="mjd-ic mjd-live-ic" href="mailto:' + EMAIL + '" aria-label="إيميل">' + I.mail + '</a>' +
          '<button class="mjd-ic" id="mjd-hist-btn" aria-label="المحادثات السابقة">' + I.hist + '</button>' +
          '<button class="mjd-ic" id="mjd-theme" aria-label="تبديل الثيم">' + I.moon + '</button>' +
          '<button class="mjd-ic" id="mjd-hide" aria-label="إخفاء مؤقتًا" title="إخفاء مؤقتًا — يرجع ماجد من مقبض على حافة الشاشة">' + I.hide + '</button>' +
          '<button class="mjd-ic" id="mjd-x" aria-label="إغلاق المحادثة والرجوع للزر العائم" title="إغلاق">' + I.close + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="mjd-cbar">' +
        '<a class="mjd-cb mjd-wa" href="https://wa.me/' + WA + '" target="_blank" rel="noopener">' + I.wa + 'واتساب</a>' +
        '<a class="mjd-cb" href="mailto:' + EMAIL + '">' + I.mail + 'إيميل</a>' +
        '<button class="mjd-cb mjd-vo" id="mjd-voice" type="button">' + I.mic + 'فويس <span class="mjd-soon">قريبًا</span></button>' +
      '</div>' +
      '<div class="mjd-bd" id="mjd-bd"></div>' +
      '<div class="mjd-attbar" id="mjd-attbar"></div>' +
      '<div class="mjd-ip">' +
        '<div class="mjd-box">' +
          '<input id="mjd-in" type="text" placeholder="اكتب رسالتك لماجد..." aria-label="رسالة"/>' +
          '<button class="mjd-att-btn" id="mjd-att-btn" type="button" aria-label="إرفاق ملف">' + I.clip + '</button>' +
        '</div>' +
        '<button class="mjd-snd" id="mjd-send" aria-label="إرسال">' + I.send + '</button>' +
      '</div>' +
      '<div class="mjd-credit">مدعوم بواسطة Engosoft</div>' +
      '<input type="file" id="mjd-file" hidden accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"/>' +
      '<div class="mjd-hist" id="mjd-hist" role="dialog" aria-label="المحادثات السابقة">' +
        '<div class="mjd-hist-hd"><b>المحادثات</b><button class="mjd-ic" id="mjd-hist-x" aria-label="رجوع">' + I.close + '</button></div>' +
        '<div class="mjd-hist-ls" id="mjd-hist-ls"></div>' +
        '<button class="mjd-hist-new" id="mjd-new">' + I.pen + ' محادثة جديدة</button>' +
      '</div>' +
    '</div>' +
    '<div id="mjd-tz" role="button" aria-label="رسالة من ماجد"><button class="mjd-tz-x" aria-label="إخفاء">✕</button><div class="mjd-tz-in" id="mjd-tz-in"></div></div>' +
    '<button id="mjd-fab" aria-label="تحدّث مع ماجد" title="اضغط للمحادثة · اسحب لتغيير المكان"><span class="mjd-ring"></span><img src="' + AVATAR + '"' + AVA_ERR + ' alt="ماجد"/><span class="mjd-dot"></span></button>' +
    '<button id="mjd-edge" data-side="right" aria-label="إظهار مساعد ماجد" title="إظهار ماجد"><img src="' + AVATAR + '"' + AVA_ERR + ' alt=""/></button>'
  ));
  document.body.appendChild(root);

  var panel = document.getElementById('mjd-panel');
  var bd = document.getElementById('mjd-bd');
  var input = document.getElementById('mjd-in');
  var sendBtn = document.getElementById('mjd-send');
  var attBar = document.getElementById('mjd-attbar');
  var fileIn = document.getElementById('mjd-file');
  var tz = document.getElementById('mjd-tz');
  var tzIn = document.getElementById('mjd-tz-in');
  var hist = document.getElementById('mjd-hist');
  var histLs = document.getElementById('mjd-hist-ls');

  // ---------- rendering ----------
  function scrollDown() { bd.scrollTop = bd.scrollHeight; }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  // escape first (XSS-safe), then turn bare http(s) URLs into clickable links
  function linkify(s) {
    return esc(s).replace(/https?:\/\/[^\s<>"']+/g, function (u) {
      var tail = '';
      var m = u.match(/[)\].,!?؟،;:]+$/);   // don't swallow trailing punctuation
      if (m) { tail = m[0]; u = u.slice(0, u.length - tail.length); }
      return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>' + tail;
    });
  }
  function fmtSize(b) {
    b = Number(b) || 0;
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return Math.round(b / 1024) + ' KB';
    return b + ' B';
  }
  function fmtRel(ts) {
    if (!ts) return '';
    var ms = ts > 1e12 ? ts : ts * 1000;
    var d = Date.now() - ms;
    if (d < 90e3) return 'الآن';
    if (d < 3600e3) return 'من ' + Math.round(d / 60e3) + ' دقيقة';
    if (d < 86400e3) return 'من ' + Math.round(d / 3600e3) + ' ساعة';
    if (d < 7 * 86400e3) return 'من ' + Math.round(d / 86400e3) + ' يوم';
    try { return new Date(ms).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' }); } catch (e) { return ''; }
  }
  function cleanUrl(raw) {
    var url = String(raw || '').trim();
    while (/[)\]}>.,;!?،؛]/.test(url.slice(-1))) url = url.slice(0, -1);
    return url;
  }
  // «#mjd-media=image»: وسم البريدج المخزن في نص Chatwoot عشان نوع الميديا
  // ميتحولش لرابط نصي بعد إعادة فتح المحادثة (الـ fragment مبيوصلش للسيرفر أصلًا)
  var MJD_MEDIA_TAG = /#mjd-media=(image|video|audio|voice|file)\b/i;
  function stripMediaTag(url) {
    return String(url || '').replace(MJD_MEDIA_TAG, '').replace(/#$/, '');
  }
  function mediaKindFromUrl(url) {
    var tagged = String(url || '').match(MJD_MEDIA_TAG);
    if (tagged) {
      var k = tagged[1].toLowerCase();
      return k === 'voice' ? 'audio' : k;
    }
    var base = String(url || '').split(/[?#]/)[0].toLowerCase();
    if (/\.(png|jpe?g|webp|gif|svg)$/.test(base)) return 'image';
    if (/\.(mp4|webm|mov|m4v)$/.test(base)) return 'video';
    if (/\.(mp3|m4a|aac|ogg|oga|wav|webm)$/.test(base)) return 'audio';
    if (/\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip)$/.test(base)) return 'file';
    // روابط Botpress CDN غالبًا بدون امتداد — جرّبها كصورة (في fallback للخطأ)
    if (/^https?:\/\/[^\/]*\bbpcontent\.cloud\//i.test(base) || /^https?:\/\/files\.botpress\.cloud\//i.test(base)) return 'image';
    return '';
  }
  function mediaTitleFromUrl(url, kind) {
    try {
      var path = new URL(url).pathname.split('/').pop() || '';
      return decodeURIComponent(path) || kind || 'file';
    } catch (e) {
      return kind || 'file';
    }
  }
  function detectMediaInText(text) {
    var body = String(text || '');
    var urls = body.match(/https?:\/\/[^\s<>"']+/g) || [];
    for (var i = 0; i < urls.length; i++) {
      var raw = urls[i];
      var url = cleanUrl(raw);
      var kind = mediaKindFromUrl(url);
      if (!kind) continue;
      var caption = body.replace(raw, '').replace(url, '').trim()
        .replace(/!\[[^\]]*]\(\s*\)/g, '')
        .replace(/\[[^\]]*]\(\s*\)/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      var captionAsTitle = caption && caption.length <= 80 && caption.indexOf('\n') < 0;
      var cleanedUrl = stripMediaTag(url);
      return {
        kind: kind,
        url: cleanedUrl,
        caption: captionAsTitle ? '' : caption,
        title: captionAsTitle ? caption : mediaTitleFromUrl(cleanedUrl, kind)
      };
    }
    return null;
  }
  function objectAttrs(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
      try {
        var parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (e) {}
    }
    return {};
  }

  // وضع المحادثة: أول ما العميل يبدأ يتكلم — الهيدر يبقى زجاجي مدمج والشات ياخد مساحة أكبر
  function setLive(on) {
    live = !!on;
    panel.classList.toggle('mjd-live', live);
  }

  function addBot(html) {
    var row = inject('div', { class: 'mjd-row mjd-bot' },
      '<img class="mjd-mini" src="' + AVATAR + '"' + AVA_ERR + '/><div class="mjd-bub">' + html + '</div>');
    bd.appendChild(row); scrollDown();
  }
  function addMe(text) {
    var row = inject('div', { class: 'mjd-row mjd-me' }, '<div class="mjd-bub">' + esc(text) + '</div>');
    bd.appendChild(row); scrollDown();
  }
  function fileChipHtml(name, size, url) {
    return '<a class="mjd-file"' + (url ? ' href="' + esc(url) + '" target="_blank" rel="noopener"' : '') + '>' +
      '<span class="mjd-fi">' + I.file + '</span>' +
      '<span><b>' + esc(name || 'ملف') + '</b><span>' + fmtSize(size) + '</span></span></a>';
  }
  // فقاعة صورة موحّدة: skeleton أثناء التحميل، الصورة كاملة بنسبتها الأصلية (بدون قص)،
  // سقف ارتفاع للصور الطويلة جدًا + زر «الحجم الكامل»، وfallback برابط لو فشل التحميل.
  function buildImageMedia(el, url, title) {
    var openUrl = stripMediaTag(url);
    el.classList.add('mjd-haspic', 'mjd-imgloading');
    var pic = inject('a', {
      class: 'mjd-pic', href: openUrl, target: '_blank', rel: 'noopener',
      'aria-label': 'افتح الصورة بالحجم الكامل'
    }, '');
    var img = new Image();
    img.alt = title || 'صورة';
    // eager عمدًا: lazy جوة panel مقفول (display:none) عمره ما يحمّل → skeleton للأبد
    img.decoding = 'async';
    img.onload = function () {
      el.classList.remove('mjd-imgloading');
      // بورتريه طويل (الارتفاع > 1.5× العرض): سقف 340px مع contain — إطار بدون قص
      if (img.naturalHeight > img.naturalWidth * 1.5) {
        el.classList.add('mjd-tall');
        var full = inject('button', { class: 'mjd-full', type: 'button', 'aria-label': 'عرض الصورة بالحجم الكامل' },
          I.expand + '<span>الحجم الكامل</span>');
        full.addEventListener('click', function (ev) {
          ev.preventDefault(); ev.stopPropagation();
          window.open(openUrl, '_blank', 'noopener');
        });
        pic.appendChild(full);
      }
      scrollDown();
    };
    img.onerror = function () {
      el.classList.remove('mjd-imgloading', 'mjd-haspic', 'mjd-tall');
      pic.remove();
      el.insertBefore(inject('div', { class: 'mjd-imgerr' },
        '🖼️ تعذّر تحميل الصورة — <a href="' + esc(openUrl) + '" target="_blank" rel="noopener">افتحها من هنا</a>'),
        el.firstChild);
      scrollDown();
    };
    img.src = openUrl;
    pic.appendChild(img);
    el.appendChild(pic);
  }
  // attachment bubble (image/video/audio preview, otherwise a file chip)
  function addAttachment(att, mine) {
    var kind = att.file_type || att.kind || 'file';
    var url = att.data_url || att.url || '';
    var el = inject('div', { class: 'mjd-media' + (mine ? ' mjd-mine' : '') }, '');
    if (kind === 'image' && url) buildImageMedia(el, url, att.name || 'صورة');
    else if (kind === 'video' && url) el.innerHTML = '<video src="' + esc(url) + '" controls></video>';
    else if (kind === 'audio' && url) el.innerHTML = '<audio src="' + esc(url) + '" controls></audio>';
    else el.innerHTML = fileChipHtml(att.name, att.file_size || att.size, url);
    bd.appendChild(el); scrollDown();
  }
  function addCard(attrs) {
    var items = (attrs && attrs.items) || [];
    items.forEach(function (it) {
      var h = (it.media_url || it.image_url ? '<img src="' + esc(it.media_url || it.image_url) + '" alt=""/>' : '') +
        '<div class="mjd-ct"><b>' + esc(it.title) + '</b>' + (it.description ? '<span>' + esc(it.description) + '</span>' : '') + '</div>';
      (it.actions || []).forEach(function (a) {
        if (a.type === 'link') h += '<a href="' + esc(a.uri) + '" target="_blank" rel="noopener">' + esc(a.text) + '</a>';
        else h += '<button data-pb="' + esc(a.payload || a.text) + '">' + esc(a.text) + '</button>';
      });
      var card = inject('div', { class: 'mjd-card' }, h);
      card.querySelectorAll('button[data-pb]').forEach(function (btn) {
        // send the postback value to the bot, but show the human label in the bubble
        btn.addEventListener('click', function () { sendMessage(btn.getAttribute('data-pb'), btn.textContent); });
      });
      bd.appendChild(card); scrollDown();
    });
  }
  function addOptions(attrs, content) {
    var items = (attrs && attrs.items) || [];
    if (content) addBot(esc(content));
    var wrap = inject('div', { class: 'mjd-options' }, '');
    items.forEach(function (it) {
      var b = inject('button', { class: 'mjd-opt', type: 'button', 'data-val': it.value || it.title || '' }, esc(it.title || it.value || 'اختيار'));
      // the customer sees the label they clicked; the bot receives the option value
      b.addEventListener('click', function () { sendMessage(b.getAttribute('data-val'), b.textContent); });
      wrap.appendChild(b);
    });
    if (items.length) { bd.appendChild(wrap); scrollDown(); }
  }
  function addMedia(attrs, content) {
    attrs = attrs || {};
    var url = stripMediaTag(attrs.url || '');
    var kind = attrs.media_type || 'file';
    var title = attrs.title || mediaTitleFromUrl(url, kind) || url || 'ملف';
    var caption = String(content || '').trim();
    if (caption && caption !== title && caption !== url) addBot(esc(caption));
    var el = inject('div', { class: 'mjd-media' }, '');
    if (url && kind === 'image') {
      buildImageMedia(el, url, title);
      el.appendChild(inject('a', { href: url, target: '_blank', rel: 'noopener' }, esc(title)));
    } else if (url && kind === 'video') {
      el.innerHTML = '<video src="' + esc(url) + '" controls></video>' +
        '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(title) + '</a>';
    } else if (url && (kind === 'audio' || kind === 'voice')) {
      el.innerHTML = '<audio src="' + esc(url) + '" controls></audio>' +
        '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(title) + '</a>';
    } else if (url) {
      el.innerHTML = '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(title) + '</a>';
    } else {
      el.innerHTML = '<a>' + esc(title) + '</a>';
    }
    bd.appendChild(el); scrollDown();
  }
  var typingEl = null;
  function showTyping() {
    if (typingEl) return;
    typingEl = inject('div', { class: 'mjd-typing' }, '<i></i><i></i><i></i>');
    bd.appendChild(typingEl); scrollDown();
  }
  function hideTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }

  // one agent/bot message (from SSE or transcript) → the right bubble type
  function renderAgentMessage(m) {
    m = m || {};
    m.content_attributes = objectAttrs(m.content_attributes);
    var inlineMedia = (!m.content_type || m.content_type === 'text') && m.content ? detectMediaInText(m.content) : null;
    if (inlineMedia) {
      if (inlineMedia.caption) addBot(linkify(inlineMedia.caption));
      addMedia({ media_type: inlineMedia.kind, url: inlineMedia.url, title: inlineMedia.title }, '');
    } else if (m.content_type === 'cards' && m.content_attributes && (m.content_attributes.items || []).length) {
      if (m.content) addBot(linkify(m.content));
      addCard(m.content_attributes);
    } else if (m.content_type === 'input_select' && m.content_attributes) {
      addOptions(m.content_attributes, m.content);
    } else if (m.content_type === 'media' && m.content_attributes) {
      addMedia(m.content_attributes, m.content);
    } else if (m.content) {
      addBot(linkify(m.content));
    }
    (m.attachments || []).forEach(function (a) { addAttachment(a, false); });
  }

  // ---------- network ----------
  function fetchUserContext() {
    return fetch(USER_CTX_URL, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (ctx) {
        if (!ctx) {
          console.info('[Majed] user context: فارغ — زائر غير مسجّل أو /ai_webhook/user_context غير متاح');
          return {};
        }
        var u = ctx.user || {}, lp = ctx.learning_progress || {};
        var out = {
          name: u.name || '', email: u.email || '',
          odoo_user_id: String(u.user_id || ''),
          enrolled_courses: String(lp.total_courses_enrolled || 0),
          remaining_lessons: String(lp.total_remaining_lessons || 0),
          progress_percent: String(lp.average_progress || 0),
          courses_json: JSON.stringify(ctx.courses || [])
        };
        if (!out.name && !out.email) console.info('[Majed] user context: بدون اسم/إيميل — هيتعامل كزائر');
        else console.info('[Majed] user context: ' + out.name + ' · كورسات=' + out.enrolled_courses);
        return out;
      })
      .catch(function () {
        console.info('[Majed] user context fetch فشل — هيتعامل كزائر');
        return {};
      });
  }
  function ensureCtx() {
    if (!ctxPromise) ctxPromise = fetchUserContext().then(function (ud) { userData = ud || {}; return userData; });
    return ctxPromise;
  }

  function uid() { return userData.odoo_user_id || userData.email || 'anon'; }
  function isLoggedIn() { return !!(userData && (userData.email || userData.odoo_user_id)); }
  function storageKey() { return STORE_PREFIX + uid(); }
  function listKey() { return LIST_PREFIX + uid(); }

  function loadStoredConv() {
    try {
      var raw = localStorage.getItem(storageKey());
      if (!raw) return '';
      var d = JSON.parse(raw);
      if (!d || !d.conversationId) return '';
      if (Date.now() - (d.ts || 0) > 14 * 24 * 60 * 60 * 1000) return '';
      return String(d.conversationId);
    } catch (e) { return ''; }
  }
  function saveStoredConv(id) {
    try { localStorage.setItem(storageKey(), JSON.stringify({ conversationId: id, ts: Date.now() })); } catch (e) {}
  }
  // history list (newest first, max 10) — the widget remembers its own conversations
  function listConvs() {
    try {
      var arr = JSON.parse(localStorage.getItem(listKey()) || '[]');
      if (!(arr instanceof Array)) arr = [];
      var legacy = loadStoredConv();
      if (legacy && !arr.some(function (e) { return String(e.id) === legacy; })) arr.push({ id: legacy, ts: Date.now() });
      return arr;
    } catch (e) { return []; }
  }
  function rememberConv(id) {
    if (!id) return;
    try {
      var arr = listConvs().filter(function (e) { return String(e.id) !== String(id); });
      arr.unshift({ id: String(id), ts: Date.now() });
      localStorage.setItem(listKey(), JSON.stringify(arr.slice(0, 10)));
    } catch (e) {}
  }

  function closeStream() { if (es) { try { es.close(); } catch (e) {} es = null; } }

  function openStream() {
    if (!convId || es) return;
    es = new EventSource(BRIDGE + '/widget/stream?conversationId=' + encodeURIComponent(convId));
    es.addEventListener('message', function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (loadingTranscript) { pendingEvents.push(m); return; }
      renderStreamMessage(m);
    });
    es.onerror = function () { /* EventSource auto-reconnects */ };
  }
  function renderStreamMessage(m) {
    if (m.id != null) {
      if (seenIds[m.id]) return;
      seenIds[m.id] = 1;
    }
    hideTyping();
    renderAgentMessage(m);
  }

  // transcript restore (reopen / switch from history)
  function loadMessages(id) {
    loadingTranscript = true;
    return fetch(BRIDGE + '/widget/messages?conversationId=' + encodeURIComponent(id))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var msgs = (d && d.messages) || [];
        if (!msgs.length) return;
        bd.innerHTML = ''; typingEl = null;
        var anyMine = false;
        msgs.forEach(function (m) {
          if (m.id != null) seenIds[m.id] = 1;
          if (m.sender === 'contact') {
            anyMine = true;
            if (m.content) addMe(m.content);
            (m.attachments || []).forEach(function (a) { addAttachment(a, true); });
          } else {
            renderAgentMessage(m);
          }
        });
        if (anyMine) setLive(true);
        scrollDown();
      })
      .catch(function () {})
      .then(function () {
        loadingTranscript = false;
        var q = pendingEvents.splice(0);
        q.forEach(renderStreamMessage);
      });
  }

  function startSession() {
    if (started) return Promise.resolve();
    started = true;
    return ensureCtx().then(function () {
      var existingConversationId = forceNew ? '' : loadStoredConv();
      return fetch(BRIDGE + '/widget/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: userData.name, email: userData.email, userData: userData, existingConversationId: existingConversationId })
      });
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.conversationId) {
        convId = d.conversationId;
        forceNew = false;
        saveStoredConv(convId);
        rememberConv(convId);
        var p = d.reused ? loadMessages(convId) : Promise.resolve();
        return p.then ? p.then(function () { openStream(); }) : openStream();
      }
      addBot('تعذّر بدء المحادثة، حاول تاني بعد لحظات.'); started = false;
    }).catch(function () { addBot('تعذّر الاتصال، حاول تاني.'); started = false; });
  }

  // text = what is sent to the bridge/bot; display = what the customer sees in their bubble
  // (for choice/postback clicks display is the button label, not the raw value).
  function sendMessage(text, display) {
    text = (text || '').trim();
    // a picked file goes out with the typed text as caption (button clicks don't consume it)
    if (pendingFile && display == null) { sendAttachment(text); return; }
    if (!text) return;
    addMe((display || text).trim() || text);
    setLive(true);
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

  // ---------- attachments («اضافة ملفات») ----------
  function clearPendingFile() {
    pendingFile = null;
    if (pendingThumb) { try { URL.revokeObjectURL(pendingThumb); } catch (e) {} pendingThumb = ''; }
    attBar.classList.remove('mjd-on');
    attBar.innerHTML = '';
    fileIn.value = '';
  }
  function setPendingFile(f) {
    if (!f) return;
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      addBot('الملف أكبر من ' + MAX_FILE_MB + 'MB — ابعت ملف أصغر 🙏');
      fileIn.value = '';
      return;
    }
    clearPendingFile();
    pendingFile = f;
    var isImg = /^image\//.test(f.type);
    var head = '';
    if (isImg) { pendingThumb = URL.createObjectURL(f); head = '<img src="' + pendingThumb + '" alt=""/>'; }
    else head = '<span class="mjd-fi">' + I.file + '</span>';
    attBar.innerHTML = head + '<span><b>' + esc(f.name) + '</b><span>' + fmtSize(f.size) + '</span></span>' +
      '<button class="mjd-att-x" type="button" aria-label="إزالة">✕</button>';
    attBar.querySelector('.mjd-att-x').addEventListener('click', clearPendingFile);
    attBar.classList.add('mjd-on');
    input.focus();
  }
  function sendAttachment(caption) {
    if (!pendingFile || uploading) return;
    var f = pendingFile;
    var thumb = pendingThumb;
    pendingThumb = '';            // bubble keeps the objectURL alive
    clearPendingFile();
    input.value = '';

    // optimistic local bubbles
    var isImg = /^image\//.test(f.type);
    addAttachment(isImg && thumb ? { file_type: 'image', data_url: thumb } : { file_type: 'file', name: f.name, size: f.size }, true);
    if (caption) addMe(caption);
    setLive(true);
    uploading = true;
    sendBtn.setAttribute('disabled', 'disabled');
    showTyping();

    var doUpload = function () {
      if (!convId) { fail('تعذّر بدء المحادثة، حاول تاني.'); return; }
      var fd = new FormData();
      fd.append('file', f, f.name);
      fd.append('conversationId', convId);
      if (caption) fd.append('caption', caption);
      try { fd.append('userData', JSON.stringify(userData)); } catch (e) {}
      fetch(BRIDGE + '/widget/upload', { method: 'POST', body: fd })
        .then(function (r) {
          if (r.ok) return r.json();
          if (r.status === 413) throw new Error('الملف أكبر من ' + MAX_FILE_MB + 'MB — ابعت ملف أصغر 🙏');
          if (r.status === 415) throw new Error('نوع الملف ده مش مدعوم.');
          throw new Error('تعذّر رفع الملف، حاول تاني.');
        })
        .then(function () { done(); })
        .catch(function (e) { fail(e && e.message ? e.message : 'تعذّر رفع الملف، حاول تاني.'); });
    };
    var done = function () { uploading = false; sendBtn.removeAttribute('disabled'); };
    var fail = function (msg) { uploading = false; sendBtn.removeAttribute('disabled'); hideTyping(); addBot(esc(msg)); };

    if (!convId) startSession().then(doUpload);
    else doUpload();
  }

  // ---------- conversation history («المحادثات السابقة») ----------
  function openHistory() {
    hist.classList.add('mjd-on');
    histLs.innerHTML = '<div class="mjd-skel"></div><div class="mjd-skel"></div><div class="mjd-skel"></div>';
    ensureCtx().then(function () {
      var entries = listConvs();
      if (!entries.length) {
        histLs.innerHTML = '<div class="mjd-hist-empty">لسه مفيش محادثات سابقة —<br/>ابدأ أول محادثة مع ماجد 👇</div>';
        return;
      }
      var ids = entries.map(function (e) { return e.id; }).join(',');
      fetch(BRIDGE + '/widget/conversations?ids=' + encodeURIComponent(ids))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var list = (d && d.conversations) || [];
          if (!list.length) {
            histLs.innerHTML = '<div class="mjd-hist-empty">لسه مفيش محادثات سابقة —<br/>ابدأ أول محادثة مع ماجد 👇</div>';
            return;
          }
          // keep widget order (newest first per local list)
          var byId = {};
          list.forEach(function (c) { byId[String(c.id)] = c; });
          histLs.innerHTML = '';
          entries.forEach(function (e) {
            var c = byId[String(e.id)];
            if (!c) return;
            var row = inject('button', { class: 'mjd-hrow' + (String(c.id) === String(convId) ? ' mjd-cur' : ''), type: 'button' },
              '<img src="' + AVATAR + '"' + AVA_ERR + '/>' +
              '<span class="mjd-hx"><b>' + esc(c.last_message || 'محادثة مع ماجد') + '</b>' +
              '<span>' + fmtRel(c.last_at) + '</span></span>' +
              '<span class="mjd-st" data-st="' + esc(c.status || 'pending') + '"></span>');
            row.addEventListener('click', function () { switchConv(String(c.id)); });
            histLs.appendChild(row);
          });
        })
        .catch(function () {
          histLs.innerHTML = '<div class="mjd-hist-empty">تعذّر تحميل المحادثات، حاول تاني.</div>';
        });
    });
  }
  function closeHistory() { hist.classList.remove('mjd-on'); }

  function switchConv(id) {
    closeHistory();
    if (String(id) === String(convId)) return;
    closeStream();
    convId = String(id);
    started = true;
    forceNew = false;
    saveStoredConv(convId);
    rememberConv(convId);
    seenIds = {};
    bd.innerHTML = ''; typingEl = null;
    setLive(false);
    loadMessages(convId).then(function () { openStream(); input.focus(); });
  }

  function newConversation() {
    closeHistory();
    closeStream();
    convId = null;
    started = false;
    forceNew = true;
    seenIds = {};
    bd.innerHTML = ''; typingEl = null;
    clearPendingFile();
    setLive(false);
    startSession().then(function () { input.focus(); });
  }

  // ---------- teaser (رسالة لفت الانتباه — بتتبدل) ----------
  function tzDismissed() { try { return sessionStorage.getItem('majed:tz:off') === '1'; } catch (e) { return false; } }
  function tzDismiss() { try { sessionStorage.setItem('majed:tz:off', '1'); } catch (e) {} }

  // تيزر «مستهدَف» = مربوط بصفحة معيّنة (showOn و/أو showOnSelector)
  function tzIsTargeted(t) { return !!(t && (t.showOn != null || t.showOnSelector != null)); }

  // هل التيزر مسموح يظهر على الصفحة الحالية؟
  //  - showOn: substring أو مصفوفة في الـ URL (host+path+query)
  //  - showOnSelector: يظهر لو عنصر بالـ selector ده موجود في الصفحة (مفيد لصفحات الكورس/المنتج)
  //  - من غير أي منهم → يظهر في كل صفحة
  function tzMatchesPage(t) {
    if (!t) return false;
    if (!tzIsTargeted(t)) return true;
    if (t.showOnSelector) {
      try { if (document.querySelector(t.showOnSelector)) return true; } catch (e) {}
    }
    if (t.showOn != null) {
      var pats = Array.isArray(t.showOn) ? t.showOn : [t.showOn];
      var here = '';
      try { here = (location.host + location.pathname + location.search).toLowerCase(); } catch (e) { here = ''; }
      for (var i = 0; i < pats.length; i++) {
        var p = String(pats[i] || '').trim().toLowerCase();
        if (p && here.indexOf(p) !== -1) return true;
      }
    }
    return false;
  }

  // اسم الكورس من صفحة المتجر الحالية — عشان البوت يعرف العميل بيسأل عن أي كورس.
  // مصدر الاسم قابل للتخصيص: CFG.courseNameSelector (صفحة Odoo) أو SCFG.courseNameSelector
  // (Railway: MAJED_COURSE_NAME_SELECTOR). لو محدّد → أعلى ثقة. غير كده: عنوان الصفحة، ثم عناصر شائعة.
  var COURSE_NAME_SELECTOR = CFG.courseNameSelector || SCFG.courseNameSelector || '';
  function pickText(sel) {
    if (!sel) return '';
    try {
      var el = document.querySelector(sel);
      var name = el && (el.textContent || '').trim();
      if (name) return name.replace(/\s+/g, ' ').slice(0, 80);
    } catch (e) {}
    return '';
  }
  function pageCourseName() {
    // 1) selector صريح من الإعداد (لو محدّد)
    var explicit = pickText(COURSE_NAME_SELECTOR);
    if (explicit) return explicit;
    // 2) عنوان الصفحة من غير اسم الموقع — أوثق مصدر افتراضي على أغلب صفحات الدورات
    var t = (document.title || '').split(/\s[|\-–—•·]\s/)[0].trim();
    if (t && t.length > 2) return t.slice(0, 80);
    // 3) عناصر شائعة كحل أخير (من غير #wrap h1 العام عشان ميمسكش بلوك غلط)
    return pickText('h1[itemprop="name"], #product_details h1, .oe_website_sale h1, main h1');
  }
  // يستبدل {{course}} باسم الكورس الحالي (escapeName=true لما يتحقن في HTML)
  function resolveCourse(s, escapeName) {
    if (!s || s.indexOf('{{course}}') === -1) return s;
    var name = pageCourseName() || 'الكورس ده';
    if (escapeName) name = esc(name);
    return s.replace(/\{\{course\}\}/g, name);
  }

  // التيزرات المعروضة دلوقتي:
  //  1) فلترة حسب الصفحة (showOn / showOnSelector).
  //  2) لو فيه تيزر مخصّص للصفحة دي → اعرض المخصّصة لوحدها وخفي العامة (عشان صفحة الكورس متطلعش الترحيب).
  //  3) حسب حالة اللوجين: guestOnly للزوار فقط، loggedInOnly للمسجّلين فقط، والباقي للكل.
  function visibleTeasers() {
    var base = TEASERS.filter(tzMatchesPage);
    var targeted = base.filter(tzIsTargeted);
    if (targeted.length) base = targeted;
    var logged = isLoggedIn();
    var only = base.filter(function (t) {
      if (t.guestOnly) return !logged;      // عروض الزوار — تختفي بعد اللوجين
      if (t.loggedInOnly) return logged;    // عروض المسجّلين — تظهر بعد اللوجين فقط
      return true;
    });
    return only.length ? only : base;
  }
  function renderTeaser() {
    var list = visibleTeasers();
    var t = list[tzIndex % list.length] || {};
    var h = '<img src="' + AVATAR + '"' + AVA_ERR + ' alt="ماجد"/>' +
      '<div><div class="mjd-tz-tx">' + resolveCourse(t.html || '', true) + '</div>';
    if (t.link || t.code || t.botMessage) {
      h += '<div class="mjd-tz-act">';
      if (t.botMessage) h += '<button class="mjd-tz-go mjd-tz-ask" type="button" data-msg="' + esc(t.botMessage) + '">' + esc(t.botMessageLabel || 'كلّمني 💬') + '</button>';
      if (t.link) h += '<a class="mjd-tz-go" href="' + esc(t.link) + '" target="_blank" rel="noopener">' + esc(t.linkText || 'افتح الرابط') + ' ↗</a>';
      if (t.code) h += '<button class="mjd-tz-code" type="button" data-code="' + esc(t.code) + '" data-label="' + esc(t.codeLabel || t.code) + '">🏷️ ' + esc(t.codeLabel || t.code) + '</button>';
      h += '</div>';
    }
    h += '</div>';
    tzIn.innerHTML = h;
    var codeBtn = tzIn.querySelector('.mjd-tz-code');
    if (codeBtn) codeBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var code = codeBtn.getAttribute('data-code') || '';
      var label = codeBtn.getAttribute('data-label') || code;
      // after copying show the actual code briefly so the customer sees what landed in the clipboard
      var ok = function () { codeBtn.textContent = '✓ اتنسخ: ' + code; setTimeout(function () { codeBtn.textContent = '🏷️ ' + label; }, 2200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(ok, ok);
      else ok();
    });
    var ask = tzIn.querySelector('.mjd-tz-ask');
    if (ask) ask.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var msg = resolveCourse(ask.getAttribute('data-msg') || '', false);
      if (msg) openPanelAndSend(msg);
    });
    var go = tzIn.querySelector('.mjd-tz-go:not(.mjd-tz-ask)');
    if (go) go.addEventListener('click', function (ev) { ev.stopPropagation(); });
  }
  function rotateTeaser() {
    if (!tzVisible || visibleTeasers().length < 2) return;
    tz.classList.add('mjd-swap');
    setTimeout(function () {
      tzIndex++;
      renderTeaser();
      tz.classList.remove('mjd-swap');
    }, 260);
  }
  function showTeaser(delay) {
    if (tzDismissed() || tzVisible || panel.classList.contains('mjd-open') || live) return;
    if (!visibleTeasers().length) return; // مفيش تيزر مناسب للصفحة دي
    clearTimeout(tzTimer);
    tzTimer = setTimeout(function () {
      if (panel.classList.contains('mjd-open') || tzDismissed() || live || !visibleTeasers().length) return;
      renderTeaser();
      tz.classList.add('mjd-on');
      tzVisible = true;
      clearInterval(tzRotateTimer);
      tzRotateTimer = setInterval(rotateTeaser, TZ_ROTATE);
    }, delay == null ? TZ_DELAY : delay);
  }
  function hideTeaser() {
    clearTimeout(tzTimer);
    clearInterval(tzRotateTimer);
    tz.classList.remove('mjd-on');
    tzVisible = false;
  }
  tz.addEventListener('click', function () { hideTeaser(); openPanel(); });
  tz.querySelector('.mjd-tz-x').addEventListener('click', function (ev) {
    ev.stopPropagation();
    hideTeaser();
    tzDismiss();
  });

  // ---------- interactions ----------
  var fab = document.getElementById('mjd-fab');
  var edge = document.getElementById('mjd-edge');

  // ===== مكان الويدجت: سحب + snap لليمين/اليسار + حفظ واسترجاع =====
  var POS_KEY = 'majed:pos:' + BRIDGE;     // localStorage (مكان دائم لكل bridge)
  var HIDE_KEY = 'majed:hidden:' + BRIDGE; // sessionStorage فقط — يرجع تلقائيًا في الزيارة الجاية
  var EDGE_GAP = 22, VP_MARGIN = 8;
  var side = CFG.position === 'left' ? 'left' : 'right';
  var bottomPx = 22;
  var suppressClick = false; // سحبة خلصت لسه — متعملش click

  function loadPos() {
    try {
      var p = JSON.parse(localStorage.getItem(POS_KEY) || '');
      if (p && (p.side === 'left' || p.side === 'right') && isFinite(Number(p.bottom))) {
        side = p.side;
        bottomPx = Number(p.bottom);
      }
    } catch (e) {}
  }
  function savePos() {
    try { localStorage.setItem(POS_KEY, JSON.stringify({ side: side, bottom: Math.round(bottomPx) })); } catch (e) {}
  }
  // أقصى مسافة من تحت بحيث الويدجت كله (بما فيه النافذة المفتوحة فوق الزر) يفضل جوة الشاشة
  function maxBottom() {
    var limit = window.innerHeight - (fab.offsetHeight || 64) - VP_MARGIN;
    if (panel.classList.contains('mjd-open')) {
      var ph = panel.offsetHeight || 600;
      limit = Math.min(limit, window.innerHeight - ph - 80 - VP_MARGIN); // النافذة مثبتة 80px فوق قاع الـ root
    }
    return Math.max(VP_MARGIN, limit);
  }
  function applyPos() {
    bottomPx = Math.min(Math.max(VP_MARGIN, bottomPx), maxBottom());
    root.setAttribute('data-side', side);
    root.style.bottom = bottomPx + 'px';
    if (side === 'left') { root.style.left = EDGE_GAP + 'px'; root.style.right = 'auto'; }
    else { root.style.right = EDGE_GAP + 'px'; root.style.left = 'auto'; }
    root.style.transform = '';
  }
  // FLIP خفيف: من نقطة الإفلات لمكان الـ snap بحركة قصيرة (transform بس — مفيش تقطيع)
  function snapToEdge() {
    var from = root.getBoundingClientRect();
    applyPos();
    var to = root.getBoundingClientRect();
    var dx = from.left - to.left, dy = from.top - to.top;
    if (dx || dy) {
      root.style.transition = 'none';
      root.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0)';
      requestAnimationFrame(function () {
        root.style.transition = 'transform .18s ease';
        root.style.transform = '';
        setTimeout(function () { root.style.transition = ''; }, 240);
      });
    }
    savePos();
  }
  function resetPos() {
    side = CFG.position === 'left' ? 'left' : 'right';
    bottomPx = 22;
    snapToEdge();
  }

  // سحب بـ Pointer Events (ماوس + لمس + قلم): يبدأ بعد عتبة 6px عشان الضغطة العادية تفضل ضغطة
  function makeDraggable(handle, enabled) {
    var sx = 0, sy = 0, pid = null, dragging = false;
    function onMove(e) {
      if (pid == null || e.pointerId !== pid) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!dragging) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return; // movement threshold
        dragging = true;
        root.classList.add('mjd-dragging');
        hideTeaser();
      }
      if (e.cancelable) e.preventDefault();
      root.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0)';
    }
    function onEnd(e) {
      if (pid == null || e.pointerId !== pid) return;
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      try { handle.releasePointerCapture(pid); } catch (err) {}
      pid = null;
      if (!dragging) return;
      dragging = false;
      root.classList.remove('mjd-dragging');
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);
      var r = root.getBoundingClientRect();
      side = (r.left + r.width / 2) < window.innerWidth / 2 ? 'left' : 'right';
      bottomPx = Math.round(window.innerHeight - r.bottom);
      snapToEdge();
    }
    handle.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;       // الزر الأساسي بس
      if (enabled && !enabled(e)) return;
      sx = e.clientX; sy = e.clientY; pid = e.pointerId; dragging = false;
      // الالتقاط فورًا = الأحداث تفضل واصلة حتى لو المؤشر خرج عن المقبض (مش بيمنع الـ click)
      try { handle.setPointerCapture(pid); } catch (err) {}
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
    });
  }
  root.addEventListener('dragstart', function (e) { e.preventDefault(); }); // منع سحب الصور الأصلي
  var hd = panel.querySelector('.mjd-hd');
  // النافذة المفتوحة: تتسحب من الهيدر بس (مش من الأزرار اللي جواه)
  makeDraggable(hd, function (e) {
    return panel.classList.contains('mjd-open') && !(e.target && e.target.closest && e.target.closest('button,a,input'));
  });
  // الزر العائم: يتسحب وهو مقفول
  makeDraggable(fab, function () { return !panel.classList.contains('mjd-open'); });
  hd.addEventListener('dblclick', function (e) {
    if (e.target && e.target.closest && e.target.closest('button,a,input')) return;
    resetPos(); // دبل-كليك على الهيدر = إعادة الضبط للمكان الافتراضي
  });
  // الشاشة اتغيّر مقاسها/اتجاهها؟ رجّع الويدجت جوة الحدود
  var resizeRaf = 0;
  function onViewportChange() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(function () { resizeRaf = 0; applyPos(); });
  }
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);

  // ===== شفافية أثناء تمرير الصفحة (Liquid Glass) =====
  var scrollTimer = null;
  window.addEventListener('scroll', function () {
    // أثناء الكتابة/التركيز جوة الويدجت: مفيش تخفيف وضوح إطلاقًا
    if (panel.contains(document.activeElement)) return;
    root.classList.add('mjd-page-scrolling');
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function () { root.classList.remove('mjd-page-scrolling'); }, 200);
  }, { passive: true });
  input.addEventListener('focus', function () {
    clearTimeout(scrollTimer);
    root.classList.remove('mjd-page-scrolling');
  });

  // ===== فتح/إغلاق/إخفاء =====
  function openPanel() {
    hideTeaser();
    panel.classList.add('mjd-open');
    requestAnimationFrame(applyPos); // النافذة دلوقتي ليها ارتفاع حقيقي → نضمن إنها جوة الشاشة
    startSession();
    setTimeout(function () { input.focus(); }, 200);
  }
  // يفتح الشات ويبعت رسالة جاهزة للبوت (مستخدَم من زرار التيزر «ساعدني في الشراء»).
  // بنبدأ الجلسة الأول وننتظرها عشان convId يبقى جاهز قبل الإرسال (نتفادى سباق startSession).
  function openPanelAndSend(text, label) {
    hideTeaser();
    panel.classList.add('mjd-open');
    requestAnimationFrame(applyPos);
    setTimeout(function () { input.focus(); }, 200);
    startSession().then(function () { sendMessage(text, label || text); });
  }

  // X = قفل النافذة ورجوع الزر العائم فقط — المحادثة وSSE فاضلين شغالين بالظبط
  function closePanel() {
    panel.classList.remove('mjd-open');
    if (!live) showTeaser(1500); // رجّع التيزر بعد قفل النافذة
  }
  fab.addEventListener('click', function () {
    if (suppressClick) return; // دي نهاية سحبة مش ضغطة
    panel.classList.contains('mjd-open') ? closePanel() : openPanel();
  });
  document.getElementById('mjd-x').addEventListener('click', closePanel);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel.classList.contains('mjd-open')) closePanel();
  });

  // «إخفاء مؤقتًا»: يخفي الزر العائم ويسيب مقبض صغير على حافة الشاشة فيه صورة ماجد.
  // الحالة في sessionStorage فقط — ماجد بيرجع طبيعي في الزيارة الجاية.
  function setHidden(on) {
    root.classList.toggle('mjd-hidden', on);
    edge.classList.toggle('mjd-on', on);
    if (on) {
      edge.setAttribute('data-side', side);
      edge.style.bottom = Math.max(VP_MARGIN, Math.min(bottomPx, window.innerHeight - 70)) + 'px';
      hideTeaser();
    }
    try {
      if (on) sessionStorage.setItem(HIDE_KEY, '1');
      else sessionStorage.removeItem(HIDE_KEY);
    } catch (e) {}
  }
  document.getElementById('mjd-hide').addEventListener('click', function () {
    closePanel();
    setHidden(true);
  });
  edge.addEventListener('click', function () { setHidden(false); });

  // استرجاع المكان وحالة الإخفاء عند تحميل الصفحة (لو المكان المحفوظ بقى برة الشاشة → ينضبط تلقائي)
  loadPos();
  applyPos();
  try { if (sessionStorage.getItem(HIDE_KEY) === '1') setHidden(true); } catch (e) {}
  sendBtn.addEventListener('click', function () { sendMessage(input.value); input.value = ''; });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { sendMessage(input.value); input.value = ''; } });
  document.getElementById('mjd-voice').addEventListener('click', function () {
    addBot('ماجد فويس قريّب جدًا 🎙️ — حاليًا أقدر أساعدك كتابة أو أوصّلك بموظف.');
  });
  document.getElementById('mjd-theme').addEventListener('click', function () {
    panel.setAttribute('data-theme', panel.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  document.getElementById('mjd-att-btn').addEventListener('click', function () { fileIn.click(); });
  fileIn.addEventListener('change', function () { setPendingFile(fileIn.files && fileIn.files[0]); });
  document.getElementById('mjd-hist-btn').addEventListener('click', function () {
    hist.classList.contains('mjd-on') ? closeHistory() : openHistory();
  });
  document.getElementById('mjd-hist-x').addEventListener('click', closeHistory);
  document.getElementById('mjd-new').addEventListener('click', newConversation);

  // أول ظهور — التيزر بيظهر للكل (الترحيب)، وعرض الكورس بس للزوار قبل اللوجين
  ensureCtx().then(function () { showTeaser(); });
})();
