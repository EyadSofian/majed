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
 *       // excludeOn: string | string[] — يخفي التيزر لو الـ URL طابق أحد الأنماط دي (يكسب على showOn).
 *       //            مفيد لمنع تيزر المتجر/الكورس من الظهور على '/shop/cart' و'/shop/payment'.
 *       // excludeOnSelector: CSS selector — يخفي التيزر لو العنصر ده موجود في الصفحة.
 *       // ملاحظة: لو في تيزر مستهدَف مطابق للصفحة، بيظهر لوحده وبتختفي التيزرات العامة (زي الترحيب).
 *       // botMessage / botMessageLabel: زرار يفتح الشات ويبعت رسالة جاهزة للبوت (يشغّل فلو المبيعات).
 *       // {{course}} داخل html أو botMessage يتحوّل تلقائيًا لاسم الكورس المقروء من الصفحة الحالية.
 *       // en: { html, botMessage, botMessageLabel, linkText, codeLabel } — النص الإنجليزي.
 *       //     يظهر تلقائيًا لما تكون لغة الصفحة إنجليزي (من <html lang> أو بادئة /en/). بدونه يظهر العربي.
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
  var WIDGET_VERSION = '5.2.2';
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
  var GREETING = CFG.greeting || 'مرحبًا، أنا ماجد';
  // تسجيل صوتي: يظهر زرار المايك فقط لو Deepgram متفعّل في البريدج (SCFG.voice) أو مفعّل من الصفحة.
  var VOICE_ON = SCFG.voice === true || CFG.voice === true;
  var COURSE_URL = CFG.courseUrl || SCFG.courseUrl || 'https://engosoft.com/shop/the-freelance-masterclass-2056';
  // صفحة المتجر (كل الدورات) — وجهة زر «تصفّح الدورات» في تيزر خصم 20%
  var SHOP_URL = CFG.shopUrl || SCFG.shopUrl || 'https://engosoft.com/shop';
  var PROMO_CODE = CFG.promoCode || SCFG.promoCode || 'free100';
  // كود خصم العملاء المسجّلين (20% على أي دورة) — قابل للتخصيص من الصفحة أو Railway env
  var DISCOUNT_CODE = CFG.discountCode || SCFG.discountCode || 'engo20';
  var TZ_DELAY = Number(CFG.teaserDelay) > 0 ? Number(CFG.teaserDelay) : 3500;
  var TZ_ROTATE = Number(CFG.teaserRotate) > 2000 ? Number(CFG.teaserRotate) : 9000;
  var MAX_FILE_MB = 10;
  var STORE_PREFIX = 'majed:conversation:' + BRIDGE + ':';
  var LIST_PREFIX = 'majed:convlist:' + BRIDGE + ':';
  var SUBSCRIBE_KEY = 'majed:subscribe:' + BRIDGE;
  var SUBSCRIBE_DONE_KEY = 'majed:subscribe:done:' + BRIDGE;
  var SUBSCRIBE_CFG = {
    enabled: CFG.subscribeEnabled !== false,
    title: CFG.subscribeTitle || '📬 ابقَ قريبًا من تحديثات ماجد',
    text: CFG.subscribeText || 'اكتب بريدك الإلكتروني لتصلك أهم أخبار الدورات والعروض التعليمية. يمكنك تجاهلها ومتابعة المحادثة عاديًا.',
    exitTitle: CFG.subscribeExitTitle || 'قبل أن تغادر…',
    exitText: CFG.subscribeExitText || 'هل تريد أن نرسل لك تحديثات ماجد وأخبار الدورات الجديدة على بريدك؟'
  };

  // تيزر صفحة الكورس — قابل للتخصيص بالكامل من Railway env vars (عبر SCFG.courseTeaser)
  // بيظهر لأي زائر على صفحة كورس مفردة (مسجّل أو لا) بفكرة «مساعدة الشراء» + خصم 20% بكود engo20.
  // مهم: المقصود صفحة الدورة الواحدة (مثال: /shop/the-freelance-masterclass-2056)،
  // مش قائمة المتجر العامة (/shop). عشان كده بنعتمد على علامتين معًا:
  //  1) showOnSelector على عنصر صفحة المنتج المفردة في Odoo (تفاصيل المنتج/الفورم الرئيسي)
  //     — العنصر ده مش موجود في صفحة القائمة، فالتيزر مايظهرش هناك.
  //  2) showOn على '/shop/' و '/course/' و '/training_package/' بشَرطة في الآخر كشرط
  //     احتياطي يضمن الظهور على صفحة الدورة/الباقة حتى لو القالب مختلف، ومع كده القائمة
  //     العامة '/shop' (من غير شرطة) متطلعش.
  // صفحات المتجر اللي مش صفحة كورس/قائمة (سلة/دفع/تأكيد) — نستثنيها من تيزر الكورس والكتالوج
  // عشان '/shop/cart' و'/shop/payment' بتحتوي على '/shop' كـ substring فكانت بتسرّبهم بالغلط.
  var SHOP_FLOW_EXCLUDE = ['/shop/cart', '/shop/checkout', '/shop/payment', '/shop/confirmation', '/shop/address'];
  var ct = SCFG.courseTeaser || {};
  var COURSE_TEASER = {
    showOn: ct.showOn != null ? ct.showOn : ['/shop/', '/course/', '/training_package/'],
    excludeOn: ct.excludeOn != null ? ct.excludeOn : SHOP_FLOW_EXCLUDE,
    showOnSelector: ct.showOnSelector || '#product_details, #product_detail, .js_main_product',
    html: ct.html || '🛒 هل تحتاج مساعدة في شراء «{{course}}»؟<br/>لديك خصم <b>20%</b> على هذه الدورة بالكود 👇',
    botMessage: ct.botMessage || 'أحتاج مساعدة في شراء دورة «{{course}}»، ولديّ كود خصم ' + DISCOUNT_CODE + '.',
    botMessageLabel: ct.botMessageLabel || '💬 ساعدني في الشراء',
    code: ct.code || DISCOUNT_CODE,
    codeLabel: ct.codeLabel || 'كود الخصم ' + DISCOUNT_CODE,
    en: ct.en || {
      html: '🛒 Need help buying «{{course}}»?<br/>You get <b>20%</b> off this course with the code 👇',
      botMessage: 'I need help buying the course «{{course}}», and I have discount code ' + DISCOUNT_CODE + '.',
      botMessageLabel: '💬 Help me buy',
      codeLabel: 'Discount code ' + DISCOUNT_CODE
    }
  };

  // تيزر قائمة الدورات (صفحة المتجر العامة /shop) — رسالة عامة «تحب أساعدك تختار الدورة المناسبة؟»
  // بيظهر على صفحة القائمة بس، ويتستثنى تلقائيًا على صفحة الدورة المفردة (اللي فيها تفاصيل المنتج)
  // عشان COURSE_TEASER هو اللي يظهر هناك. قابل للتخصيص من Railway env عبر SCFG.shopTeaser.
  var st = SCFG.shopTeaser || {};
  var CATALOG_TEASER = {
    showOn: st.showOn != null ? st.showOn : ['/shop', '/course'],
    excludeOn: st.excludeOn != null ? st.excludeOn : SHOP_FLOW_EXCLUDE,
    excludeOnSelector: st.excludeOnSelector != null ? st.excludeOnSelector : '#product_details, #product_detail, .js_main_product',
    html: st.html || 'هل تحب أن أساعدك في اختيار الدورة المناسبة لك؟ 🎯<br/>وهناك <b>خصم</b> على الدورات 👇',
    botMessage: st.botMessage || 'هل يمكنك مساعدتي في اختيار الدورة المناسبة لي من دوراتكم؟ وقد سمعت أن هناك خصمًا على الدورات.',
    botMessageLabel: st.botMessageLabel || '🎯 ساعدني في الاختيار',
    code: st.code || DISCOUNT_CODE,
    codeLabel: st.codeLabel || 'كود الخصم ' + DISCOUNT_CODE,
    en: st.en || {
      html: 'Would you like me to help you choose the right course? 🎯<br/>And there\'s a <b>discount</b> on courses 👇',
      botMessage: 'Can you help me choose the right course from your catalog? I heard there\'s a discount on courses.',
      botMessageLabel: '🎯 Help me choose',
      codeLabel: 'Discount code ' + DISCOUNT_CODE
    }
  };
  // ── تيزرات مخصّصة لكل صفحة (ماجد يظهر بسياق الصفحة اللي العميل واقف عليها) ──
  // كلها مستهدَفة بـ showOn (مسار الـ URL) فبتظهر لوحدها على صفحتها وتخفي التيزرات العامة.
  // الزرار بيفتح الشات ويبعت botMessage للبوت → ماجد يكمّل الشرح/المساعدة (التعليمات في Botpress).
  // قابلة للتخصيص من Railway env عبر SCFG.<name>Teaser (أو MAJED_TEASERS_JSON للتحكم الكامل).

  // صفحة إنشاء الحساب — للزوار فقط
  var sgt = SCFG.signupTeaser || {};
  var SIGNUP_TEASER = {
    showOn: sgt.showOn != null ? sgt.showOn : ['/web/signup', '/web/reset_password'],
    guestOnly: sgt.guestOnly != null ? sgt.guestOnly : true,
    html: sgt.html || 'هل تُنشئ حسابًا جديدًا؟ 👋<br/>إن واجهتك أي خطوة، فأنا <b>ماجد</b> لمساعدتك فورًا',
    botMessage: sgt.botMessage || 'أنا في صفحة إنشاء الحساب وتوقّفت، هل يمكنك مساعدتي في إكمال التسجيل خطوة بخطوة؟',
    botMessageLabel: sgt.botMessageLabel || '✋ ساعدني في التسجيل',
    en: sgt.en || {
      html: 'Creating a new account? 👋<br/>If you get stuck on any step, I\'m <b>Majed</b>, here to help right away',
      botMessage: 'I\'m on the sign-up page and got stuck, can you help me complete the registration step by step?',
      botMessageLabel: '✋ Help me sign up'
    }
  };

  // صفحة تسجيل الدخول — للزوار فقط (نسيت الباسورد / مش عارف يدخل)
  var lgt = SCFG.loginTeaser || {};
  var LOGIN_TEASER = {
    showOn: lgt.showOn != null ? lgt.showOn : ['/web/login'],
    guestOnly: lgt.guestOnly != null ? lgt.guestOnly : true,
    html: lgt.html || 'تواجه مشكلة في الدخول؟ 🔐<br/>نسيت كلمة المرور؟ أساعدك على إعادة تعيينها ويصلك الرابط على بريدك',
    botMessage: lgt.botMessage || 'لديّ مشكلة في تسجيل الدخول، ربما نسيت كلمة المرور، هل يمكنك مساعدتي في إعادة تعيينها؟',
    botMessageLabel: lgt.botMessageLabel || '🔐 ساعدني في الدخول',
    en: lgt.en || {
      html: 'Trouble signing in? 🔐<br/>Forgot your password? I\'ll help you reset it and you\'ll get the link by email',
      botMessage: 'I\'m having trouble logging in, maybe I forgot my password, can you help me reset it?',
      botMessageLabel: '🔐 Help me sign in'
    }
  };

  // صفحة السلة — تشجيع إتمام الطلب + كود الخصم
  var crt = SCFG.cartTeaser || {};
  var CART_TEASER = {
    showOn: crt.showOn != null ? crt.showOn : ['/shop/cart'],
    html: crt.html || '🛒 تفصلك خطوة واحدة عن إتمام طلبك!<br/>هل تحتاج مساعدة؟ ولديك <b>خصم 20%</b> 👇',
    botMessage: crt.botMessage || 'أنا في سلة الشراء وأرغب في إتمام الطلب، هل يمكنك مساعدتي؟ وهل يوجد خصم متاح؟',
    botMessageLabel: crt.botMessageLabel || '🛒 ساعدني في الإتمام',
    code: crt.code || DISCOUNT_CODE,
    codeLabel: crt.codeLabel || 'كود الخصم ' + DISCOUNT_CODE,
    en: crt.en || {
      html: '🛒 You\'re one step away from completing your order!<br/>Need help? You have a <b>20% discount</b> 👇',
      botMessage: 'I\'m in the cart and want to complete my order, can you help me? Is there a discount available?',
      botMessageLabel: '🛒 Help me checkout',
      codeLabel: 'Discount code ' + DISCOUNT_CODE
    }
  };

  // صفحات الدفع/الإتمام — شرح الفرق بين بوابات الدفع الفعلية على الموقع
  // (Kashier / Apple Pay / PayPal / Tap) + زرار نسخ كود الخصم.
  var pmt = SCFG.paymentTeaser || {};
  var PAYMENT_TEASER = {
    showOn: pmt.showOn != null ? pmt.showOn : ['/shop/checkout', '/shop/payment', '/shop/confirmation'],
    html: pmt.html || '💳 هل تتردد في اختيار طريقة الدفع؟<br/>أوضّح لك الفرق بين <b>Kashier</b> و<b>Apple Pay</b> و<b>Tap</b> وأيها أنسب لك',
    botMessage: pmt.botMessage || 'أنا في صفحة الدفع ومتردد بين طرق الدفع (Kashier / Apple Pay / PayPal / Tap)، هل يمكنك توضيح الفرق بينها وأيها أنسب لي؟',
    botMessageLabel: pmt.botMessageLabel || '💳 وضّح لي طرق الدفع',
    // مفيش كود خصم على صفحة الدفع (طلب العميل) — التيزر بيشرح طرق الدفع بس.
    // قابل لإعادة التفعيل من Railway عبر MAJED_PAYMENT_TEASER_CODE لو احتجت.
    code: pmt.code || '',
    codeLabel: pmt.codeLabel || '',
    en: pmt.en || {
      html: '💳 Not sure which payment method?<br/>I\'ll explain the difference between <b>Kashier</b>, <b>Apple Pay</b> and <b>Tap</b> and which suits you',
      botMessage: 'I\'m on the payment page and unsure between the methods (Kashier / Apple Pay / PayPal / Tap), can you explain the difference and which suits me best?',
      botMessageLabel: '💳 Explain payment methods'
    }
  };

  // صفحة طلبات الشركات — طلب تدريب خاص/مخصّص للشركات (مش باقات جاهزة)
  var cmt = SCFG.companyTeaser || {};
  var COMPANY_TEASER = {
    showOn: cmt.showOn != null ? cmt.showOn : ['/company-requests', '/company-request'],
    html: cmt.html || '🏢 هل تحتاج تدريبًا خاصًا لفريق شركتك؟<br/>أساعدك على تجهيز طلب تدريب مخصّص بسرعة',
    botMessage: cmt.botMessage || 'أرغب في تقديم طلب تدريب خاص لشركتي، هل يمكنك مساعدتي في تجهيز الطلب ومعرفة الخطوات؟',
    botMessageLabel: cmt.botMessageLabel || '🏢 اطلب تدريبًا خاصًا',
    en: cmt.en || {
      html: '🏢 Need custom training for your company team?<br/>I\'ll help you prepare a tailored training request quickly',
      botMessage: 'I\'d like to submit a custom training request for my company, can you help me prepare it and know the steps?',
      botMessageLabel: '🏢 Request custom training'
    }
  };

  // صفحة «عن إنجوسوفت» — تعريف بالشركة وعرض المساعدة
  var abt = SCFG.aboutTeaser || {};
  var ABOUT_TEASER = {
    showOn: abt.showOn != null ? abt.showOn : ['/about-us', '/about'],
    html: abt.html || 'هل ترغب في معرفة المزيد عن <b>إنجوسوفت</b>؟ 🏢<br/>اسألني عن خبرتنا ودوراتنا وكيف نساعدك',
    botMessage: abt.botMessage || 'أرغب في معرفة المزيد عن إنجوسوفت وخبرتكم والمجالات التي تدرّبون فيها، هل يمكنك إخباري؟',
    botMessageLabel: abt.botMessageLabel || 'ℹ️ عرّفني بإنجوسوفت',
    en: abt.en || {
      html: 'Want to know more about <b>Engosoft</b>? 🏢<br/>Ask me about our experience, courses and how we help you',
      botMessage: 'I\'d like to know more about Engosoft, your experience and the fields you train in, can you tell me?',
      botMessageLabel: 'ℹ️ About Engosoft'
    }
  };

  // ── رسائل تحفيزية لصفحة المتجر (/shop) — تظهر واحدة تلو الأخرى كل بضع ثوانٍ ──
  // تستهدف قائمة المتجر فقط (مستثناة من صفحة الدورة المفردة وصفحات السلة/الدفع)،
  // وتشجّع الزائر المتردّد على البدء. قابلة للتجاوز الكامل من Railway عبر MAJED_TEASERS_JSON.
  function shopMotivation(html, botMessage, botMessageLabel, extra) {
    var t = {
      showOn: ['/shop', '/course'],
      excludeOn: SHOP_FLOW_EXCLUDE,
      excludeOnSelector: '#product_details, #product_detail, .js_main_product',
      html: html, botMessage: botMessage, botMessageLabel: botMessageLabel
    };
    if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) t[k] = extra[k]; } }
    return t;
  }
  var SHOP_MOTIVATION_TEASERS = [
    shopMotivation(
      '🤔 هل أنت متردّد في اختيار دورتك؟<br/>دعني أساعدك على اختيار الأنسب لمجالك',
      'أنا متردّد في اختيار الدورة المناسبة لي، هل يمكنك مساعدتي في الاختيار؟',
      '🎯 ساعدني في الاختيار',
      { en: {
        html: '🤔 Not sure which course to pick?<br/>Let me help you choose the best fit for your field',
        botMessage: 'I\'m hesitant about choosing the right course, can you help me choose?',
        botMessageLabel: '🎯 Help me choose'
      } }
    ),
    shopMotivation(
      '👷‍♂️ اغتنم الفرصة كما فعل غيرك!<br/>آلاف المهندسين طوّروا مهاراتهم وانطلقوا في مسارهم المهني معنا',
      'أرغب في تطوير مهاراتي المهنية مثل غيري من المهندسين، ما الدورات التي تنصحني بها؟',
      '🚀 ابدأ الآن',
      { en: {
        html: '👷‍♂️ Seize the opportunity like others did!<br/>Thousands of engineers upgraded their skills and advanced their careers with us',
        botMessage: 'I want to develop my professional skills like other engineers, which courses do you recommend?',
        botMessageLabel: '🚀 Start now'
      } }
    ),
    shopMotivation(
      '🎓 انضمّ إلى أكثر من <b>50,000 متدرّب</b><br/>اختر دورتك وابدأ رحلتك التعليمية اليوم',
      'أرغب في الانضمام إليكم والبدء في رحلتي التعليمية، ما الخطوات؟',
      '✨ انضمّ إلينا',
      { en: {
        html: '🎓 Join more than <b>50,000 trainees</b><br/>Pick your course and start your learning journey today',
        botMessage: 'I\'d like to join and start my learning journey, what are the steps?',
        botMessageLabel: '✨ Join us'
      } }
    ),
    shopMotivation(
      '🎉 خصم <b>20%</b> على <b>جميع الدورات</b>!<br/>اغتنم الفرصة قبل انتهائها',
      'سمعت أن هناك خصم 20% على جميع الدورات، كيف أستفيد منه؟',
      '🏷️ استفد من الخصم',
      { code: DISCOUNT_CODE, codeLabel: 'كود الخصم ' + DISCOUNT_CODE, en: {
        html: '🎉 <b>20%</b> off <b>all courses</b>!<br/>Grab the offer before it ends',
        botMessage: 'I heard there\'s a 20% discount on all courses, how do I use it?',
        botMessageLabel: '🏷️ Get the discount',
        codeLabel: 'Discount code ' + DISCOUNT_CODE
      } }
    )
  ];

  // ── رسائل تحفيزية لصفحة السلة (/shop/cart) — تشجّع العميل على إتمام عملية الشراء ──
  // تتبدّل واحدة تلو الأخرى كل بضع ثوانٍ مع تيزر السلة الأساسي (CART_TEASER).
  var CART_MOTIVATION_TEASERS = [
    {
      showOn: ['/shop/cart'],
      html: '⏳ لا تفوّت الفرصة!<br/>أكمل طلبك الآن واحجز مقعدك في الدورة',
      botMessage: 'أنا في سلة الشراء وأريد إكمال طلبي وحجز مقعدي، هل يمكنك مساعدتي؟',
      botMessageLabel: '✅ أكمل طلبي',
      en: {
        html: '⏳ Don\'t miss out!<br/>Complete your order now and reserve your seat',
        botMessage: 'I\'m in the cart and want to complete my order and reserve my seat, can you help me?',
        botMessageLabel: '✅ Complete my order'
      }
    },
    {
      showOn: ['/shop/cart'],
      html: '🚀 استثمر في مستقبلك المهني!<br/>أكمل الشراء وابدأ رحلة التعلّم فورًا',
      botMessage: 'أرغب في إتمام الشراء والبدء في التعلّم فورًا، ما الخطوات؟',
      botMessageLabel: '🚀 أكمل الشراء',
      en: {
        html: '🚀 Invest in your career!<br/>Complete your purchase and start learning right away',
        botMessage: 'I\'d like to complete the purchase and start learning right away, what are the steps?',
        botMessageLabel: '🚀 Complete purchase'
      }
    },
    {
      showOn: ['/shop/cart'],
      html: '🎉 خصم <b>20%</b> بانتظارك!<br/>أكمل طلبك واستفد من العرض قبل انتهائه',
      botMessage: 'هناك خصم 20% وأريد الاستفادة منه على طلبي في السلة، كيف أطبّقه؟',
      botMessageLabel: '🏷️ استفد من الخصم',
      code: DISCOUNT_CODE, codeLabel: 'كود الخصم ' + DISCOUNT_CODE,
      en: {
        html: '🎉 A <b>20%</b> discount is waiting!<br/>Complete your order and use the offer before it ends',
        botMessage: 'There\'s a 20% discount and I want to use it on my cart order, how do I apply it?',
        botMessageLabel: '🏷️ Get the discount',
        codeLabel: 'Discount code ' + DISCOUNT_CODE
      }
    }
  ];

  // الرسالة التي تلفت انتباه العميل.
  // الأولوية: MajedConfig.teasers (الصفحة) ← MajedServerConfig.teasers (Railway) ← الافتراضي المدمج.
  var TEASERS = (CFG.teasers && CFG.teasers.length) ? CFG.teasers
    : (SCFG.teasers && SCFG.teasers.length) ? SCFG.teasers
    : [
      {
        html: 'مرحبًا! أنا <b>ماجد</b>، مستشارك التعليمي 👋<br/>اسألني عن أي دورة أو عن خطتك التعليمية',
        en: { html: 'Hi! I\'m <b>Majed</b>, your learning advisor 👋<br/>Ask me about any course or your learning plan' }
      },
      {
        // عرض الدورة المجانية — يظهر قبل تسجيل الدخول فقط (للزوار)
        guestOnly: true,
        html: '🎁 دورة <b>احتراف العمل الحر - Freelance</b><br/><b>مجانًا</b> 🎉<br/>أنشئ حسابك واحصل على هديتك 👇',
        link: COURSE_URL, linkText: 'رابط الدورة', code: PROMO_CODE, codeLabel: 'كود الخصم',
        en: {
          html: '🎁 <b>Freelance Masterclass</b><br/><b>Free</b> 🎉<br/>Create your account and get your gift 👇',
          linkText: 'Course link', codeLabel: 'Promo code'
        }
      },
      {
        // خصم 20% على أي دورة — يظهر بعد تسجيل الدخول فقط (للعملاء المسجّلين)
        loggedInOnly: true,
        html: '🎉 خصم <b>20%</b> على <b>أي دورة</b>!<br/>استخدم هذا الكود عند الشراء 👇',
        link: SHOP_URL, linkText: 'تصفّح الدورات', code: DISCOUNT_CODE, codeLabel: 'كود الخصم ' + DISCOUNT_CODE,
        en: {
          html: '🎉 <b>20%</b> off <b>any course</b>!<br/>Use this code at checkout 👇',
          linkText: 'Browse courses', codeLabel: 'Promo code ' + DISCOUNT_CODE
        }
      },
      SIGNUP_TEASER,
      LOGIN_TEASER,
      CART_TEASER,
      PAYMENT_TEASER,
      COMPANY_TEASER,
      ABOUT_TEASER,
      COURSE_TEASER,
      CATALOG_TEASER
    ].concat(SHOP_MOTIVATION_TEASERS, CART_MOTIVATION_TEASERS);

  // ---------- state ----------
  var convId = null, es = null, started = false, userData = {};
  var ctxPromise = null;          // user-context fetch (once)
  var seenIds = {};               // message-id de-dup between transcript + SSE
  var responseStreams = {};       // stream_id -> one progressive assistant message
  var loadingTranscript = false;  // buffer SSE renders while a transcript loads
  var pendingEvents = [];
  var pendingFile = null;         // file picked but not sent yet
  var pendingThumb = '';          // objectURL of the pending image preview
  var uploading = false;
  var forceNew = false;           // «محادثة جديدة»: skip the stored conversation id
  var live = false;               // customer actually chatting → glass header
  var sessionConfig = {};
  var subCard = null, subAfterReplyShown = false, subExitShown = false;
  var tzTimer = null, tzRotateTimer = null, tzIndex = 0, tzVisible = false;

  // ---------- styles ----------
  var CSS = [
    '@import url("https://fonts.googleapis.com/css2?family=Noto+Sans+Arabic:wght@400;500;600;700;800&display=swap");',
    '#mjd-root{position:fixed;bottom:22px;left:22px;z-index:2147483000;direction:rtl;font-family:"Noto Sans Arabic",system-ui,sans-serif;font-kerning:normal}',
    '#mjd-root,#mjd-root *,#mjd-root *::before,#mjd-root *::after{box-sizing:border-box}',
    '#mjd-root[data-side="right"]{left:auto;right:22px}',
    '/* launcher */',
    '#mjd-fab{width:64px;height:64px;border-radius:50%;cursor:pointer;border:0;padding:3px;position:relative;touch-action:none;',
    'background:linear-gradient(150deg,#fff,#e8f0ff);box-shadow:0 12px 30px rgba(2,82,217,.28),0 4px 16px rgba(2,82,217,.16);',
    'transition:transform .2s cubic-bezier(.2,.9,.2,1),opacity .25s ease}',
    '#mjd-fab:hover{transform:translateY(-3px) scale(1.05)}#mjd-fab:active{transform:scale(.96)}',
    '#mjd-fab img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}',
    '#mjd-fab .mjd-dot{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#16a34a;border:2.5px solid #fff}',
    '#mjd-root[data-side="right"] #mjd-fab .mjd-dot{left:auto;right:2px}',
    '#mjd-fab .mjd-ring{position:absolute;inset:-6px;border-radius:50%;border:1.5px solid rgba(2,82,217,.34);animation:mjdBreathe 2.8s ease-in-out infinite;pointer-events:none}',
    '@keyframes mjdBreathe{0%,100%{transform:scale(1);opacity:.5}50%{transform:scale(1.07);opacity:.85}}',
    '/* teaser (attention bubble) */',
    '#mjd-tz{position:absolute;bottom:84px;left:0;width:min(305px,calc(100vw - 104px));cursor:pointer;display:none;',
    'background:rgba(255,255,255,.94);backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);',
    'border:1px solid rgba(2,82,217,.16);border-radius:18px;border-bottom-left-radius:6px;padding:12px 13px;',
    'box-shadow:0 18px 44px rgba(0,29,54,.18),0 4px 14px rgba(2,82,217,.12)}',
    '#mjd-root[data-side="right"] #mjd-tz{left:auto;right:0;border-bottom-left-radius:18px;border-bottom-right-radius:6px}',
    '#mjd-tz.mjd-on{display:block;animation:mjdTzIn .38s cubic-bezier(.2,.9,.3,1.2) both}',
    '@keyframes mjdTzIn{from{opacity:0;transform:translateY(10px) scale(.95)}to{opacity:1;transform:none}}',
    '#mjd-tz .mjd-tz-in{display:flex;gap:10px;align-items:flex-start;transition:opacity .25s ease,transform .25s ease}',
    '#mjd-tz.mjd-swap .mjd-tz-in{opacity:0;transform:translateY(7px)}',
    '#mjd-tz img{width:38px;height:38px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1.5px solid rgba(2,82,217,.25)}',
    '#mjd-tz .mjd-tz-tx{font-size:13px;line-height:1.65;color:#001d36;font-weight:500}',
    '#mjd-tz .mjd-tz-tx b{font-weight:800}',
    '#mjd-tz .mjd-tz-act{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}',
    '#mjd-tz .mjd-tz-go{display:inline-flex;align-items:center;gap:5px;background:linear-gradient(135deg,#0252d9,#1d6fe9);color:#fff;',
    'font:inherit;font-size:12px;font-weight:800;border:0;border-radius:999px;padding:7px 13px;min-height:40px;cursor:pointer;text-decoration:none}',
    '#mjd-tz .mjd-tz-code{display:inline-flex;align-items:center;gap:5px;border:1.5px dashed rgba(2,82,217,.55);color:#0252d9;',
    'font-size:12px;font-weight:800;border-radius:999px;padding:6px 12px;min-height:40px;cursor:pointer;background:rgba(2,82,217,.06);font-family:inherit}',
    '#mjd-tz .mjd-tz-x{position:absolute;top:-9px;left:-9px;width:22px;height:22px;border-radius:50%;border:0;cursor:pointer;',
    'background:#001d36;color:#fff;font-size:12px;line-height:1;display:grid;place-items:center;box-shadow:0 4px 10px rgba(0,29,54,.3)}',
    '#mjd-root[data-side="right"] #mjd-tz .mjd-tz-x{left:auto;right:-9px}',
    '/* panel */',
    '#mjd-panel{--mjd-space-control:8px;--mjd-space-group:12px;position:absolute;bottom:80px;left:0;width:384px;max-width:calc(100vw - 28px);height:610px;max-height:calc(100vh - 108px);',
    'border-radius:22px;overflow:hidden;display:none;flex-direction:column;box-shadow:0 28px 70px rgba(0,29,54,.28);',
    'opacity:0;transform:translateY(10px) scale(.98);transition:opacity .22s ease,transform .22s ease}',
    '#mjd-root[data-side="right"] #mjd-panel{left:auto;right:0}',
    '#mjd-panel.mjd-open{display:flex;opacity:1;transform:none}',
    '/* theme tokens */',
    '#mjd-panel[data-theme="light"]{--bg:#f4f8ff;--surf:#fff;--surf2:#f1f5fd;--line:#dce8ff;--text:#001d36;--muted:#50647a;--soft:#718399;--botbd:#d5e3fa;--bar:#fff;--pill:#f5f8ff;--pillbd:#dce8ff;--pilltx:#17324d;--brand:#0252d9;--brand-2:#1d6fe9;--brand-soft:rgba(2,82,217,.10);--accent:#0252d9;--focus:rgba(2,82,217,.20);--wa:#1fa855;--wabg:rgba(31,168,85,.1);--wabd:rgba(31,168,85,.28);--glass:rgba(255,255,255,.78);--glassbd:rgba(2,82,217,.10)}',
    '#mjd-panel[data-theme="dark"]{--bg:#06172d;--surf:rgba(255,255,255,.07);--surf2:rgba(255,255,255,.08);--line:rgba(126,170,255,.18);--text:#f6f9ff;--muted:#afc0d8;--soft:#8298b5;--botbd:rgba(126,170,255,.20);--bar:rgba(255,255,255,.04);--pill:rgba(255,255,255,.07);--pillbd:rgba(126,170,255,.18);--pilltx:#f6f9ff;--brand:#7eAAff;--brand-2:#4f8cff;--brand-soft:rgba(91,143,249,.16);--accent:#9ebdff;--focus:rgba(91,143,249,.28);--wa:#7ff0a8;--wabg:rgba(37,211,102,.16);--wabd:rgba(37,211,102,.4);--glass:rgba(6,23,45,.70);--glassbd:rgba(126,170,255,.14)}',
    '#mjd-panel{background:var(--bg);color:var(--text)}',
    '#mjd-panel[data-theme="dark"]{background:radial-gradient(560px 300px at 86% -8%,rgba(2,82,217,.32),transparent 60%),radial-gradient(520px 300px at 0% 102%,rgba(79,140,255,.12),transparent 60%),#06172d}',
    '/* header */',
    '.mjd-hd{display:flex;align-items:center;gap:var(--mjd-space-group);padding:12px 14px;border-bottom:1px solid var(--line);transition:padding .25s ease;',
    'cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}',
    '.mjd-hd img{width:40px;height:40px;border-radius:13px;object-fit:cover;border:1px solid var(--line);transition:width .25s ease,height .25s ease}',
    '.mjd-hd .mjd-nm{min-width:0}',
    '.mjd-hd .mjd-nm b{font-size:15.5px;font-weight:800;line-height:1.35;display:block;white-space:nowrap}',
    '.mjd-hd .mjd-nm s{text-decoration:none;font-size:11.5px;line-height:1.35;color:#16a34a;display:block;white-space:nowrap;margin-top:2px}',
    '#mjd-panel[data-theme="dark"] .mjd-hd .mjd-nm s{color:#7df3c4}',
    '.mjd-hd .mjd-tools{margin-inline-start:auto;display:flex;gap:var(--mjd-space-control)}',
    '.mjd-ic{width:40px;height:40px;border-radius:11px;border:1px solid var(--line);background:var(--surf);color:var(--muted);cursor:pointer;display:grid;place-items:center;text-decoration:none;flex:0 0 auto}',
    '.mjd-ic:hover{color:var(--text)}.mjd-ic svg{width:18px;height:18px}',
    '.mjd-live-ic{display:none!important}',
    '/* «وضع المحادثة»: هيدر زجاجي مدمج + إخفاء شريط التواصل = مساحة شات أكبر */',
    '#mjd-panel.mjd-live .mjd-hd{position:absolute;top:0;left:0;right:0;z-index:6;border-bottom:1px solid var(--glassbd);',
    'background:var(--glass);backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);padding:8px 10px;gap:8px}',
    '#mjd-panel.mjd-live .mjd-hd img{width:32px;height:32px;border-radius:10px}',
    '#mjd-panel.mjd-live .mjd-hd .mjd-nm b{font-size:13.5px}',
    '#mjd-panel.mjd-live .mjd-hd .mjd-nm s{font-size:10.5px}',
    '#mjd-panel.mjd-live .mjd-tools{gap:8px}',
    '#mjd-panel.mjd-live .mjd-ic{width:36px;height:36px;border-radius:10px;background:transparent;border-color:transparent}',
    '#mjd-panel.mjd-live .mjd-ic:hover{background:var(--surf2)}',
    '#mjd-panel.mjd-live .mjd-live-ic{display:grid!important}',
    '#mjd-panel.mjd-live .mjd-cbar{display:none}',
    '#mjd-panel.mjd-live .mjd-bd{padding-top:64px}',
    '/* pinned contact bar */',
    '.mjd-cbar{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--mjd-space-control);padding:10px 12px;background:var(--bar);border-bottom:1px solid var(--line)}',
    '.mjd-cb{min-width:0;display:flex;align-items:center;justify-content:center;gap:6px;height:44px;padding:0 7px;border-radius:11px;font:inherit;font-size:12px;font-weight:700;cursor:pointer;text-decoration:none;background:var(--pill);border:1px solid var(--pillbd);color:var(--pilltx);transition:transform .14s}',
    '.mjd-cb:hover{transform:translateY(-1px)}.mjd-cb svg{width:16px;height:16px}',
    '.mjd-cb.mjd-wa{background:var(--wabg);border-color:var(--wabd);color:var(--wa)}',
    '.mjd-cb.mjd-vo{opacity:.62}',
    '.mjd-cb .mjd-soon{font-size:9px;font-weight:800;background:#f59e0b;color:#fff;border-radius:999px;padding:1px 6px}',
    '/* body */',
    '.mjd-bd{flex:1;overflow-y:auto;overflow-x:hidden;padding:14px 12px;display:flex;flex-direction:column;gap:10px;transition:padding-top .25s ease}',
    '/* فقاعات الشات داخل column flex لازم flex-shrink:0 — غيره فقاعات الصور بتنهرس لارتفاع صفر أول ما المحادثة تطول */',
    '.mjd-bd>*{flex-shrink:0}',
    '.mjd-row{display:flex;gap:8px;align-items:flex-end;max-width:92%;min-width:0;animation:mjdRise .3s ease both}',
    '.mjd-row.mjd-bot{align-self:flex-start}.mjd-row.mjd-me{align-self:flex-end}',
    '@keyframes mjdRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
    '.mjd-mini{width:27px;height:27px;border-radius:9px;object-fit:cover;flex-shrink:0;border:1px solid var(--line)}',
    '.mjd-bub{font-size:13.5px;line-height:1.65;padding:10px 12px;border-radius:15px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;word-break:normal;text-align:start;max-width:100%;min-width:0}',
    '.mjd-bot .mjd-bub{background:var(--surf);border:1px solid var(--botbd);border-bottom-right-radius:6px}',
    '.mjd-bub a{color:var(--brand);text-decoration:underline;font-weight:600;word-break:break-all}',
    '.mjd-me .mjd-bub a{color:#fff}',
    '.mjd-me .mjd-bub{background:linear-gradient(135deg,var(--brand),var(--brand-2));color:#fff;border-bottom-left-radius:6px}',
    '/* rich (markdown) bot message */',
    '.mjd-bub.mjd-md{white-space:normal}',
    '.mjd-md>:first-child{margin-top:0}.mjd-md>:last-child{margin-bottom:0}',
    '.mjd-md p{margin:0 0 7px}',
    '.mjd-md strong{font-weight:800;color:var(--text)}',
    '.mjd-md em{font-style:italic}',
    '.mjd-md code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em;background:var(--surf2);border:1px solid var(--botbd);border-radius:5px;padding:1px 5px}',
    '.mjd-md ul,.mjd-md ol{margin:7px 0;padding-inline-start:22px}',
    '.mjd-md li{margin:4px 0;line-height:1.65}',
    '.mjd-md li::marker{color:var(--brand)}',
    '.mjd-md .mjd-h{font-weight:800;line-height:1.45;margin:10px 0 5px}',
    '.mjd-md .mjd-h1{font-size:14.5px}.mjd-md .mjd-h2{font-size:13.75px}.mjd-md .mjd-h3{font-size:13px}',
    '.mjd-md hr{border:0;border-top:1px solid var(--botbd);margin:10px 0}',
    '.mjd-card{align-self:flex-start;width:86%;background:var(--surf);border:1px solid var(--botbd);border-radius:14px;overflow:hidden;animation:mjdRise .3s ease both}',
    '.mjd-card img{width:100%;max-height:160px;object-fit:cover;display:block;background:var(--surf2)}',
    '.mjd-card .mjd-ct{padding:11px 13px}.mjd-card .mjd-ct b{font-size:14px;display:block}.mjd-card .mjd-ct span{font-size:12px;color:var(--muted)}',
    '.mjd-card a,.mjd-card button{display:flex;align-items:center;gap:8px;padding:11px 13px;min-height:44px;font:inherit;font-size:13px;font-weight:700;color:var(--brand);text-decoration:none;cursor:pointer;border:0;background:transparent;border-top:1px solid var(--line);width:100%;text-align:start}',
    '.mjd-card a:hover,.mjd-card button:hover{background:var(--surf2)}',
    '/* One assistant turn: streamed copy, recommendation, price, and CTA share one surface. */',
    '.mjd-row.mjd-answer-row{align-items:flex-start;align-self:flex-start;max-width:100%;width:100%;gap:9px}',
    '.mjd-answer{width:min(100%,328px);min-width:0;background:var(--surf);border:1px solid var(--botbd);border-radius:17px 17px 7px 17px;overflow:hidden;',
    'box-shadow:0 10px 30px rgba(0,29,54,.09);transition:border-color .2s ease,box-shadow .2s ease}',
    '#mjd-panel[data-theme="dark"] .mjd-answer{box-shadow:0 10px 30px rgba(0,0,0,.18)}',
    '.mjd-answer.mjd-streaming{border-color:color-mix(in srgb,var(--brand) 45%,var(--botbd));box-shadow:0 0 0 3px var(--focus),0 10px 30px rgba(0,29,54,.09)}',
    '.mjd-answer .mjd-answer-copy{border:0!important;border-radius:0!important;background:transparent!important;padding:11px 12px 9px}',
    '.mjd-answer .mjd-answer-copy:empty{display:none}',
    '.mjd-answer-rich{display:flex;flex-direction:column;gap:10px;padding:0 10px 10px}',
    '.mjd-answer-rich:empty{display:none}',
    '.mjd-answer-rich .mjd-crs,.mjd-answer-rich .mjd-pkg,.mjd-answer-rich .mjd-ins,.mjd-answer-rich .mjd-card{width:100%;align-self:stretch;margin:0;box-shadow:none}',
    '.mjd-answer-rich .mjd-options{max-width:100%;padding:2px 1px 1px}',
    '.mjd-answer.mjd-streaming .mjd-answer-copy:after{content:"";display:inline-block;width:2px;height:1em;margin-inline-start:4px;vertical-align:-.12em;background:var(--brand);border-radius:2px;animation:mjdCursor .8s steps(1) infinite}',
    '@keyframes mjdCursor{0%,45%{opacity:1}46%,100%{opacity:0}}',
    '/* course & track cards — a price is not a sentence, so each fact gets its own slot */',
    '.mjd-crs,.mjd-pkg,.mjd-ins{align-self:stretch;background:var(--surf);border:1px solid var(--botbd);border-radius:16px;',
    'overflow:hidden;animation:mjdRise .32s cubic-bezier(.2,.9,.3,1.1) both;box-shadow:0 6px 18px rgba(0,29,54,.06)}',
    '#mjd-panel[data-theme="dark"] .mjd-crs,#mjd-panel[data-theme="dark"] .mjd-pkg,',
    '#mjd-panel[data-theme="dark"] .mjd-ins{box-shadow:none}',
    '.mjd-crs:hover,.mjd-pkg:hover,.mjd-ins:hover{border-color:var(--brand);box-shadow:0 10px 26px var(--focus)}',
    /* text bubble + its card read as ONE reply: tuck the card up under the
       bubble so they group together instead of floating apart. */
    '.mjd-row.mjd-bot + .mjd-crs,.mjd-row.mjd-bot + .mjd-pkg,.mjd-row.mjd-bot + .mjd-ins,' +
    '.mjd-crs + .mjd-crs,.mjd-pkg + .mjd-crs,.mjd-crs + .mjd-pkg{margin-top:-4px}',
    '.mjd-crs-top{display:flex;gap:9px;padding:11px 11px 0}',
    '.mjd-crs-th{width:44px;height:44px;flex:0 0 44px;border-radius:11px;object-fit:cover;background:',
    'linear-gradient(135deg,rgba(2,82,217,.18),rgba(29,111,233,.18));display:block}',
    '.mjd-crs-hd{min-width:0;flex:1;display:flex;flex-direction:column;gap:6px;padding-top:1px}',
    '.mjd-crs-t{font-size:13px;font-weight:800;line-height:1.45;color:var(--text);',
    'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '.mjd-crs-by{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:12px;color:var(--muted)}',
    '.mjd-crs-by .mjd-in{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:100%;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mjd-rt{display:inline-flex;align-items:center;gap:3px;color:#f59e0b;font-weight:800;font-size:12px}',
    '.mjd-tags{display:flex;flex-wrap:wrap;gap:5px;padding:8px 11px 0}',
    '.mjd-tag{font-size:11px;font-weight:700;line-height:1;padding:5px 8px;border-radius:7px;',
    'background:var(--surf2);color:var(--muted);border:1px solid var(--line);white-space:nowrap;',
    /* Odoo free-text fields run long ("...Completion Certificate from Engosoft
       upon Finishing the Course"); a chip that cannot shrink tears the card. */
    'max-width:100%;overflow:hidden;text-overflow:ellipsis}',
    '.mjd-tag.mjd-tag-b{background:var(--brand-soft);border-color:color-mix(in srgb,var(--brand) 30%,transparent);color:var(--brand)}',
    '.mjd-tag.mjd-tag-hot{background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.3);color:#d97706}',
    '.mjd-crs-ft{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:var(--mjd-space-group);padding:10px 11px 11px;margin-top:9px;border-top:1px solid var(--line)}',
    '.mjd-price{font-size:15px;font-weight:800;line-height:1.15;color:var(--accent);white-space:nowrap;font-variant-numeric:tabular-nums}',
    /* margin-inline-start flips with the RTL panel and glued the currency to
       the number ("2,500EGP"); a symmetric margin reads right in both. */
    '.mjd-price i{font-style:normal;font-size:11.5px;font-weight:800;color:var(--muted);margin:0 4px}',
    '.mjd-price s{display:block;font-size:11px;font-weight:600;color:var(--soft)}',
    '.mjd-price em{font-style:normal;font-size:11.5px;color:var(--muted);font-weight:700;display:block}',
    '.mjd-cta{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr);gap:var(--mjd-space-control);width:100%;margin:0}',
    '.mjd-cta>:only-child{grid-column:1/-1}',
    '.mjd-buy,.mjd-det{display:inline-flex;align-items:center;gap:7px;border-radius:10px;font:inherit;font-size:12px;',
    'font-weight:800;text-decoration:none;padding:8px 12px;min-height:44px;cursor:pointer;border:1px solid transparent;white-space:nowrap;justify-content:center;min-width:0}',
    '.mjd-buy{background:linear-gradient(135deg,var(--brand),var(--brand-2));color:#fff;box-shadow:0 6px 16px var(--focus)}',
    '.mjd-buy:hover{filter:brightness(1.07)}',
    '.mjd-buy-form{display:flex;margin:0;min-width:0;width:100%}',
    '.mjd-buy-form .mjd-buy{width:100%;height:100%}',
    '.mjd-det{background:var(--surf2);color:var(--text);border-color:var(--line)}',
    '.mjd-det:hover{border-color:var(--brand);color:var(--brand)}',
    '/* track card */',
    '.mjd-pkg-hd{display:flex;align-items:center;gap:8px;padding:9px 11px;',
    'background:linear-gradient(135deg,var(--brand-soft),rgba(217,119,6,.08));border-bottom:1px solid var(--line)}',
    '.mjd-pkg-hd b{font-size:14px;font-weight:800;line-height:1.4;color:var(--text);min-width:0}',
    '.mjd-pkg-kd{font-size:10.5px;font-weight:800;color:var(--brand);background:var(--surf);border:1px solid color-mix(in srgb,var(--brand) 34%,transparent);',
    'border-radius:999px;padding:4px 8px;white-space:nowrap;flex:0 0 auto}',
    '.mjd-pkg-op{display:flex;flex-direction:column;gap:1px;padding:7px 11px 0}',
    '.mjd-pkg-op div{display:flex;align-items:baseline;gap:8px;font-size:12px;padding:5px 0;border-bottom:1px dashed var(--line)}',
    '.mjd-pkg-op div:last-child{border-bottom:0}',
    '.mjd-pkg-op span{color:var(--muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mjd-pkg-op b{margin-inline-start:auto;font-weight:800;color:var(--text);white-space:nowrap}',
    '.mjd-pkg-op s{color:var(--soft);font-size:11px;font-weight:600}',
    '.mjd-crs-by svg{width:13px;height:13px;flex:0 0 13px;opacity:.75}',
    '.mjd-buy svg{width:14px;height:14px;flex:0 0 14px}',
    '/* instructor card — a trainer is a face and a track record */',
    '.mjd-ins{display:flex;gap:10px;align-items:flex-start;padding:10px 11px}',
    '.mjd-ins-ph{width:46px;height:46px;flex:0 0 46px;border-radius:50%;object-fit:cover;',
    'background:linear-gradient(135deg,var(--brand),var(--brand-2));color:#fff;display:grid;place-items:center;',
    'font-size:15px;font-weight:800;border:1.5px solid color-mix(in srgb,var(--brand) 30%,transparent)}',
    '.mjd-ins-in{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}',
    '.mjd-ins-in b{font-size:13.5px;font-weight:800;line-height:1.4;color:var(--text)}',
    '.mjd-ins-in s{text-decoration:none;font-size:11.5px;color:var(--muted);line-height:1.5}',
    '.mjd-ins-cs{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px}',
    '.mjd-ins-bio{margin:6px 0 0;font-size:12px;line-height:1.75;color:var(--muted);',
    'display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
    '.mjd-ins.mjd-open-bio .mjd-ins-bio{-webkit-line-clamp:unset;display:block}',
    '.mjd-more{align-self:flex-start;margin-top:2px;background:none;border:0;padding:0;cursor:pointer;',
    'font:inherit;font-size:11.5px;font-weight:800;color:var(--brand)}',
    '.mjd-ins-sec{margin-top:8px}',
    '.mjd-ins-sec b{display:block;font-size:11.5px;font-weight:800;color:var(--text);margin-bottom:4px}',
    '.mjd-ins-sec ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px}',
    '.mjd-ins-sec li{font-size:11.5px;line-height:1.6;color:var(--muted);padding-inline-start:14px;position:relative}',
    '.mjd-ins-sec li::before{content:"✓";position:absolute;inset-inline-start:0;color:var(--brand);font-weight:800}',
    '.mjd-ins-cs span{font-size:10.5px;font-weight:700;padding:4px 7px;border-radius:6px;',
    'background:var(--surf2);border:1px solid var(--line);color:var(--muted);',
    'max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '/* narrow panels (phones, or a short window): keep cards readable, not wide */',
    '@media (max-width:520px){',
    '  #mjd-panel{width:min(384px,calc(100vw - 20px));height:min(610px,calc(100dvh - 96px))}',
    '  .mjd-bd{padding:11px 9px;gap:9px}',
    '  .mjd-crs-th{width:42px;height:42px;flex:0 0 42px}',
    '  .mjd-crs-ft{flex-wrap:wrap;gap:8px}',
    '  .mjd-cta{margin-inline-start:0;width:100%}',
    '  .mjd-buy,.mjd-det{flex:1;justify-content:center}',
    '  .mjd-tag{font-size:10.5px}',
    '}',
    '@media (max-width:360px){',
    '  .mjd-hd{gap:8px;padding:10px}',
    '  .mjd-hd img{width:36px;height:36px;border-radius:11px}',
    '  .mjd-ic{width:36px;height:36px}',
    '  #mjd-panel.mjd-live .mjd-live-ic{display:none!important}',
    '  .mjd-cbar{padding:8px;gap:8px}',
    '  .mjd-cb{gap:4px;padding:0 3px;font-size:11px}',
    '  .mjd-cb .mjd-soon{font-size:8px;padding:1px 4px}',
    '}',
    '.mjd-options{align-self:flex-start;display:flex;flex-wrap:wrap;column-gap:10px;row-gap:8px;max-width:88%;animation:mjdRise .3s ease both}',
    '.mjd-opt{border:1px solid color-mix(in srgb,var(--brand) 34%,transparent);background:var(--surf);color:var(--brand);border-radius:999px;padding:8px 13px;min-height:40px;font:inherit;font-size:12.5px;font-weight:800;cursor:pointer}',
    '.mjd-opt:hover{background:var(--surf2)}',
    '.mjd-sub{align-self:stretch;background:linear-gradient(135deg,rgba(2,82,217,.1),rgba(29,111,233,.1));border:1px solid rgba(2,82,217,.22);border-radius:16px;padding:13px;animation:mjdRise .3s ease both;box-shadow:0 12px 26px rgba(0,29,54,.08)}',
    '.mjd-sub-hd{display:flex;align-items:flex-start;gap:9px;margin-bottom:8px}',
    '.mjd-sub-hd b{font-size:14px;font-weight:800;line-height:1.35;color:var(--text)}',
    '.mjd-sub-hd span{display:block;font-size:12.5px;line-height:1.55;color:var(--muted);margin-top:3px}',
    '.mjd-sub-x{margin-inline-start:auto;width:28px;height:28px;border:0;border-radius:9px;background:rgba(255,255,255,.58);color:var(--muted);cursor:pointer;font:inherit;font-weight:800}',
    '#mjd-panel[data-theme="dark"] .mjd-sub-x{background:rgba(255,255,255,.08)}',
    '.mjd-sub-form{display:flex;gap:8px;align-items:center}',
    '.mjd-sub-form input{flex:1;min-width:0;height:38px;border:1px solid var(--pillbd);background:var(--surf);color:var(--text);border-radius:12px;padding:0 12px;font:inherit;font-size:13px;outline:0;direction:ltr;text-align:left}',
    '.mjd-sub-form input::placeholder{text-align:right;direction:rtl;color:var(--soft)}',
    '.mjd-sub-btn{height:38px;border:0;border-radius:12px;padding:0 13px;background:linear-gradient(135deg,#0252d9,#1d6fe9);color:#fff;font:inherit;font-size:12.5px;font-weight:800;cursor:pointer;white-space:nowrap}',
    '.mjd-sub-skip{height:34px;border:0;background:transparent;color:var(--muted);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;margin-top:7px;padding:0 4px}',
    '.mjd-sub-msg{font-size:12px;color:var(--muted);line-height:1.5;margin-top:7px;min-height:18px}',
    '.mjd-sub.mjd-ok{border-color:rgba(34,197,94,.32);background:linear-gradient(135deg,rgba(34,197,94,.12),rgba(2,82,217,.08))}',
    '.mjd-sub.mjd-err{border-color:rgba(239,68,68,.34)}',
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
    '.mjd-media a:not(.mjd-pic){display:block;padding:11px 13px;color:var(--brand);text-decoration:none;font-weight:800;word-break:break-word;font-size:13px}',
    '.mjd-media .mjd-pic+a{padding-top:9px}',
    '.mjd-media .mjd-imgerr{display:flex;align-items:center;gap:9px;padding:11px 13px;color:var(--muted);font-size:12.5px;line-height:1.6}',
    '.mjd-media .mjd-imgerr a:not(.mjd-pic){display:inline;padding:0;font-size:12.5px}',
    '.mjd-file{display:flex;align-items:center;gap:9px;padding:10px 13px;text-decoration:none;color:inherit}',
    '.mjd-file .mjd-fi{width:36px;height:36px;border-radius:10px;background:var(--brand-soft);color:var(--brand);display:grid;place-items:center;flex-shrink:0}',
    '.mjd-file .mjd-fi svg{width:18px;height:18px}',
    '.mjd-file b{font-size:12.5px;display:block;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mjd-file span{font-size:11px;color:var(--muted)}',
    '.mjd-typing{align-self:flex-start;display:flex;align-items:center;gap:9px;padding:11px 15px;background:var(--surf);border:1px solid var(--botbd);border-radius:16px;border-bottom-right-radius:6px}',
    '.mjd-typing .mjd-dots{display:flex;gap:4px}',
    '.mjd-typing i{width:6px;height:6px;border-radius:50%;background:var(--soft);animation:mjdBlink .9s infinite}',
    '.mjd-typing i:nth-child(2){animation-delay:.2s}.mjd-typing i:nth-child(3){animation-delay:.4s}',
    '@keyframes mjdBlink{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}',
    '.mjd-typing .mjd-tw{font-size:12.5px;font-weight:700;white-space:nowrap;background:linear-gradient(90deg,var(--soft) 20%,var(--text) 50%,var(--soft) 80%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;animation:mjdShine 1.4s linear infinite,mjdFadeWord .4s ease both}',
    '@keyframes mjdShine{from{background-position:220% 0}to{background-position:-220% 0}}',
    '@keyframes mjdFadeWord{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}',
    '/* pending attachment chip */',
    '.mjd-attbar{display:none;align-items:center;gap:9px;margin:0 14px;padding:8px 10px;background:var(--surf2);border:1px dashed var(--pillbd);border-radius:13px}',
    '.mjd-attbar.mjd-on{display:flex}',
    '.mjd-attbar img{width:38px;height:38px;border-radius:9px;object-fit:cover}',
    '.mjd-attbar .mjd-fi{width:38px;height:38px;border-radius:9px;background:var(--brand-soft);color:var(--brand);display:grid;place-items:center}',
    '.mjd-attbar .mjd-fi svg{width:18px;height:18px}',
    '.mjd-attbar b{font-size:12px;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}',
    '.mjd-attbar span{font-size:10.5px;color:var(--muted)}',
    '.mjd-attbar .mjd-att-x{margin-inline-start:auto;width:26px;height:26px;border-radius:8px;border:0;background:transparent;color:var(--muted);cursor:pointer;font-size:14px}',
    '.mjd-attbar .mjd-att-x:hover{color:#ef4444}',
    '/* reply-to-message */',
    '.mjd-reply-btn{flex-shrink:0;align-self:center;width:26px;height:26px;border-radius:50%;border:0;background:transparent;color:var(--soft);cursor:pointer;display:grid;place-items:center;opacity:0;transition:opacity .15s,background .15s,color .15s}',
    '.mjd-reply-btn svg{width:15px;height:15px}',
    '.mjd-row:hover .mjd-reply-btn{opacity:.65}',
    '.mjd-reply-btn:hover{opacity:1;background:var(--surf2);color:var(--brand)}',
    '@media (hover:none){.mjd-reply-btn{opacity:.5}}',
    '.mjd-quote{display:block;border-inline-start:3px solid rgba(255,255,255,.55);background:rgba(255,255,255,.14);padding:4px 9px;margin:0 0 7px;border-radius:6px;font-size:12px;line-height:1.5;max-height:46px;overflow:hidden;opacity:.92}',
    '.mjd-bot .mjd-quote{border-inline-start-color:color-mix(in srgb,var(--brand) 55%,transparent);background:var(--surf2);color:var(--muted)}',
    '.mjd-replybar{display:none;align-items:center;gap:9px;margin:0 14px 8px;padding:8px 11px;background:var(--surf2);border:1px solid var(--pillbd);border-inline-start:3px solid var(--brand);border-radius:11px}',
    '.mjd-replybar.mjd-on{display:flex}',
    '.mjd-replybar .mjd-rb-tx{flex:1;min-width:0;font-size:12px;color:var(--muted);line-height:1.45}',
    '.mjd-replybar .mjd-rb-tx b{display:block;font-size:11px;color:var(--brand);font-weight:800;margin-bottom:1px}',
    '.mjd-replybar .mjd-rb-tx span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mjd-replybar .mjd-rb-x{flex-shrink:0;width:26px;height:26px;border-radius:8px;border:0;background:transparent;color:var(--muted);cursor:pointer;font-size:14px}',
    '.mjd-replybar .mjd-rb-x:hover{color:#ef4444}',
    '/* input */',
    '.mjd-ip{padding:12px 14px;border-top:1px solid var(--line);display:flex;align-items:center;gap:10px;background:var(--bar)}',
    '.mjd-box{flex:1;min-width:0;display:flex;align-items:center;gap:4px;background:var(--surf2);border:1px solid var(--line);border-radius:999px;padding:0 6px 0 15px;height:46px;transition:border-color .16s,box-shadow .16s}',
    '.mjd-box:focus-within{border-color:var(--brand);box-shadow:0 0 0 4px var(--focus)}',
    '.mjd-box input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:var(--text);font:inherit;font-size:13.5px}',
    '.mjd-box input::placeholder{color:var(--soft)}',
    '.mjd-att-btn{width:36px;height:36px;border-radius:50%;border:0;background:transparent;color:var(--soft);cursor:pointer;display:grid;place-items:center;flex-shrink:0}',
    '.mjd-att-btn:hover{color:var(--brand);background:var(--brand-soft)}.mjd-att-btn svg{width:18px;height:18px}',
    '/* voice recording */',
    '.mjd-att-btn.mjd-recording{color:#ef4444;background:rgba(239,68,68,.14);animation:mjdRecPulse 1.1s ease-in-out infinite}',
    '@keyframes mjdRecPulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.35)}50%{box-shadow:0 0 0 6px rgba(239,68,68,0)}}',
    '.mjd-recbar{display:none;align-items:center;gap:10px;margin:0 14px 8px;padding:9px 12px;background:var(--surf2);border:1px solid var(--pillbd);border-radius:13px}',
    '.mjd-recbar.mjd-on{display:flex}',
    '.mjd-recbar .mjd-rec-dot{width:11px;height:11px;border-radius:50%;background:#ef4444;flex-shrink:0;animation:mjdDot 1s ease-in-out infinite}',
    '@keyframes mjdDot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.75)}}',
    '.mjd-recbar .mjd-rec-time{font-size:13px;font-weight:800;font-variant-numeric:tabular-nums;color:var(--text)}',
    '.mjd-recbar .mjd-rec-lbl{font-size:12px;color:var(--muted)}',
    '.mjd-recbar .mjd-rec-cancel{margin-inline-start:auto;background:transparent;border:0;color:var(--muted);cursor:pointer;font:inherit;font-size:12px;font-weight:700;padding:4px 8px;border-radius:8px}',
    '.mjd-recbar .mjd-rec-cancel:hover{color:#ef4444;background:rgba(239,68,68,.1)}',
    '.mjd-snd{width:44px;height:44px;border-radius:50%;border:0;cursor:pointer;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,var(--brand),var(--brand-2));box-shadow:0 8px 22px var(--focus);transition:transform .14s;flex:0 0 44px}',
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
    '.mjd-hrow:hover{border-color:rgba(2,82,217,.4)}',
    '.mjd-hrow.mjd-cur{border-color:#0252d9;box-shadow:0 0 0 3px rgba(2,82,217,.14)}',
    '.mjd-hrow img{width:34px;height:34px;border-radius:11px;object-fit:cover;flex-shrink:0}',
    '.mjd-hrow .mjd-hx{flex:1;min-width:0}',
    '.mjd-hrow .mjd-hx b{display:block;font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mjd-hrow .mjd-hx span{font-size:11px;color:var(--muted)}',
    '.mjd-hrow .mjd-st{width:8px;height:8px;border-radius:50%;flex-shrink:0}',
    '.mjd-hrow .mjd-st[data-st="open"]{background:#f59e0b}.mjd-hrow .mjd-st[data-st="pending"]{background:#0252d9}.mjd-hrow .mjd-st[data-st="resolved"]{background:#9ca3af}',
    '.mjd-hist-empty{text-align:center;color:var(--muted);font-size:13px;padding:40px 16px}',
    '.mjd-skel{height:58px;border-radius:14px;background:linear-gradient(90deg,var(--surf2),var(--surf),var(--surf2));background-size:200% 100%;animation:mjdShimmer 1.2s linear infinite}',
    '@keyframes mjdShimmer{from{background-position:200% 0}to{background-position:-200% 0}}',
    '.mjd-hist-new{margin:10px 14px 14px;height:44px;border-radius:13px;border:0;cursor:pointer;font:inherit;font-size:13.5px;font-weight:800;color:#fff;',
    'background:linear-gradient(135deg,#0252d9,#1d6fe9);box-shadow:0 10px 24px rgba(2,82,217,.35);display:flex;align-items:center;justify-content:center;gap:8px}',
    '.mjd-hist-new svg{width:16px;height:16px}',
    '/* ===== Liquid Glass — fallback تلقائي: المتصفح غير الداعم يبقى على الخلفية الصلبة ===== */',
    '@supports ((backdrop-filter:blur(20px)) or (-webkit-backdrop-filter:blur(20px))){',
    '#mjd-panel{-webkit-backdrop-filter:blur(20px) saturate(160%);backdrop-filter:blur(20px) saturate(160%)}',
    '#mjd-panel[data-theme="light"]{background:rgba(244,248,255,.86);box-shadow:0 28px 70px rgba(0,29,54,.22),inset 0 0 0 1px rgba(255,255,255,.76)}',
    '#mjd-panel[data-theme="dark"]{background:radial-gradient(560px 300px at 86% -8%,rgba(2,82,217,.30),transparent 60%),radial-gradient(520px 300px at 0% 102%,rgba(79,140,255,.12),transparent 60%),rgba(6,23,45,.82);box-shadow:0 28px 70px rgba(2,6,23,.5),inset 0 0 0 1px rgba(126,170,255,.12)}',
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
    'border:1px solid rgba(2,82,217,.3);background:rgba(255,255,255,.88);-webkit-backdrop-filter:blur(12px) saturate(1.4);backdrop-filter:blur(12px) saturate(1.4);',
    'cursor:pointer;box-shadow:0 10px 26px rgba(0,29,54,.22);padding:0}',
    '#mjd-edge.mjd-on{display:flex}',
    '#mjd-edge[data-side="right"]{right:0;left:auto;border-radius:14px 0 0 14px;border-right:0}',
    '#mjd-edge[data-side="left"]{left:0;right:auto;border-radius:0 14px 14px 0;border-left:0}',
    '#mjd-edge img{width:26px;height:26px;border-radius:50%;object-fit:cover;display:block}',
    '/* وصولية: حلقة تركيز واضحة لعناصر التفاعل */',
    '#mjd-fab:focus-visible,#mjd-edge:focus-visible,.mjd-ic:focus-visible,.mjd-opt:focus-visible,.mjd-snd:focus-visible,.mjd-att-btn:focus-visible,.mjd-full:focus-visible,.mjd-hrow:focus-visible,.mjd-sub input:focus-visible,.mjd-sub button:focus-visible,.mjd-buy:focus-visible,.mjd-det:focus-visible{outline:2px solid #0252d9;outline-offset:2px}',
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
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/></svg>'
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
      '<div class="mjd-replybar" id="mjd-replybar"></div>' +
      '<div class="mjd-attbar" id="mjd-attbar"></div>' +
      (VOICE_ON ? '<div class="mjd-recbar" id="mjd-recbar"><span class="mjd-rec-dot"></span><span class="mjd-rec-time" id="mjd-rec-time">0:00</span><span class="mjd-rec-lbl">جارٍ التسجيل… اضغط المايك للإرسال</span><button class="mjd-rec-cancel" id="mjd-rec-cancel" type="button">✕ إلغاء</button></div>' : '') +
      '<div class="mjd-ip">' +
        '<div class="mjd-box">' +
          '<input id="mjd-in" type="text" placeholder="اكتب رسالتك لماجد..." aria-label="رسالة"/>' +
          (VOICE_ON ? '<button class="mjd-att-btn mjd-rec" id="mjd-rec-btn" type="button" aria-label="تسجيل صوتي" title="تسجيل صوتي">' + I.mic + '</button>' : '') +
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
  var replyBar = document.getElementById('mjd-replybar');
  var fileIn = document.getElementById('mjd-file');
  var recBtn = document.getElementById('mjd-rec-btn');
  var recBar = document.getElementById('mjd-recbar');
  var recTime = document.getElementById('mjd-rec-time');
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
  // ---------- lightweight markdown → safe HTML (for bot replies) ----------
  // Botpress sends markdown-ish text (**bold**, lists, headings). We escape first
  // (XSS-safe) then re-introduce only a small, known set of tags.
  function mdInline(s) {
    var store = [];
    var hold = function (html) { store.push(html); return '\u0000' + (store.length - 1) + '\u0000'; };
    // inline code first, so its contents aren't touched by other rules
    s = s.replace(/`([^`]+)`/g, function (_, c) { return hold('<code>' + c + '</code>'); });
    // [text](url) links
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, t, u) {
      return hold('<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>');
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    // bare URLs (kept out of any link we already built via placeholders)
    s = s.replace(/https?:\/\/[^\s<>"']+/g, function (u) {
      var tail = '', m = u.match(/[)\].,!?؟،;:]+$/);
      if (m) { tail = m[0]; u = u.slice(0, u.length - tail.length); }
      return hold('<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>') + tail;
    });
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return store[+i]; });
  }
  function mdToHtml(src) {
    var lines = esc(src || '').split(/\r?\n/);
    var html = '', para = [], listType = null;
    var flushPara = function () { if (para.length) { html += '<p>' + mdInline(para.join('<br>')) + '</p>'; para = []; } };
    var closeList = function () { if (listType) { html += '</' + listType + '>'; listType = null; } };
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) { flushPara(); closeList(); continue; }
      var h = t.match(/^(#{1,3})\s+(.*)$/);
      var ul = t.match(/^[-*•]\s+(.*)$/);
      var ol = t.match(/^(\d+)[.)]\s+(.*)$/);
      if (/^(-{3,}|_{3,}|\*{3,})$/.test(t)) { flushPara(); closeList(); html += '<hr>'; continue; }
      if (h) { flushPara(); closeList(); html += '<div class="mjd-h mjd-h' + h[1].length + '">' + mdInline(h[2]) + '</div>'; continue; }
      if (ul) { flushPara(); if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; } html += '<li>' + mdInline(ul[1]) + '</li>'; continue; }
      if (ol) { flushPara(); if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; } html += '<li>' + mdInline(ol[2]) + '</li>'; continue; }
      closeList(); para.push(t);
    }
    flushPara(); closeList();
    return html || '<p></p>';
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

  // ---------- reply-to-message ----------
  var REPLY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17l-5-5 5-5"/><path d="M4 12h11a4 4 0 0 1 4 4v2"/></svg>';
  var replyTo = null; // { text, role } captured for the next send
  function attachReply(row, role) {
    var bub = row.querySelector('.mjd-bub');
    if (!bub) return;
    var btn = inject('button', { class: 'mjd-reply-btn', type: 'button', 'aria-label': 'رد على هذه الرسالة', title: 'رد' }, REPLY_SVG);
    btn.addEventListener('click', function () { startReply(bub.textContent || '', role); });
    row.appendChild(btn);
  }
  function startReply(text, role) {
    text = (text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    replyTo = { text: text, role: role };
    var who = role === 'me' ? 'ردًّا على رسالتك' : 'ردًّا على ماجد';
    replyBar.innerHTML = '<div class="mjd-rb-tx"><b>' + esc(who) + '</b><span>' + esc(text.slice(0, 140)) + '</span></div>' +
      '<button class="mjd-rb-x" type="button" aria-label="إلغاء الرد">✕</button>';
    replyBar.querySelector('.mjd-rb-x').addEventListener('click', clearReply);
    replyBar.classList.add('mjd-on');
    try { input.focus(); } catch (e) {}
  }
  function clearReply() {
    replyTo = null;
    replyBar.classList.remove('mjd-on');
    replyBar.innerHTML = '';
  }

  function addBot(html, isMd) {
    var bub = '<div class="mjd-bub' + (isMd ? ' mjd-md' : '') + '">' + html + '</div>';
    var row = inject('div', { class: 'mjd-row mjd-bot' },
      '<img class="mjd-mini" src="' + AVATAR + '"' + AVA_ERR + '/>' + bub);
    bd.appendChild(row); attachReply(row, 'bot'); scrollDown();
  }
  function addMe(text, quote) {
    var q = quote ? '<span class="mjd-quote">' + esc(String(quote).slice(0, 200)) + '</span>' : '';
    var row = inject('div', { class: 'mjd-row mjd-me' }, '<div class="mjd-bub">' + q + esc(text) + '</div>');
    bd.appendChild(row); attachReply(row, 'me'); scrollDown();
  }
  function subscribeBackendEnabled() {
    return SUBSCRIBE_CFG.enabled && (!sessionConfig.subscribe || sessionConfig.subscribe.enabled !== false);
  }
  function subscribeState() {
    try {
      if (localStorage.getItem(SUBSCRIBE_DONE_KEY) === '1') return 'subscribed';
      return sessionStorage.getItem(SUBSCRIBE_KEY) || '';
    } catch (e) { return ''; }
  }
  function markSubscribeState(state) {
    try {
      sessionStorage.setItem(SUBSCRIBE_KEY, state);
      if (state === 'subscribed') localStorage.setItem(SUBSCRIBE_DONE_KEY, '1');
    } catch (e) {}
  }
  function canShowSubscribe(kind) {
    if (!subscribeBackendEnabled() || isLoggedIn()) return false;
    var st = subscribeState();
    if (st === 'subscribed' || st === 'dismissed') return false;
    if (kind === 'after_reply' && (subAfterReplyShown || st === 'after_seen')) return false;
    if (kind === 'exit' && subExitShown) return false;
    return true;
  }
  function removeSubscribeCard() {
    if (subCard && subCard.parentNode) subCard.parentNode.removeChild(subCard);
    subCard = null;
  }
  function setSubscribeMsg(el, text, bad) {
    el.textContent = text || '';
    if (subCard) subCard.classList.toggle('mjd-err', !!bad);
  }
  function submitSubscribe(email, source, msg, btn) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email)) {
      setSubscribeMsg(msg, 'اكتب بريدًا إلكترونيًا صحيحًا.', true);
      return;
    }
    btn.disabled = true;
    setSubscribeMsg(msg, 'جاري الاشتراك…');
    fetch(BRIDGE + '/widget/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email,
        name: userData.name || '',
        conversationId: convId,
        source: source,
        userData: userData
      })
    }).then(function (r) {
      if (!r.ok) throw new Error('bad_status');
      markSubscribeState('subscribed');
      if (subCard) {
        subCard.classList.add('mjd-ok');
        subCard.innerHTML = '<div class="mjd-sub-hd"><div><b>تم الاشتراك بنجاح.</b><span>ستصلك تحديثات ماجد على بريدك الإلكتروني عند توفر أخبار مهمة.</span></div></div>';
      }
      if (source === 'exit') setTimeout(function () { closePanel(true); }, 900);
    }).catch(function () {
      btn.disabled = false;
      setSubscribeMsg(msg, 'تعذّر الاشتراك الآن. جرّب مرة أخرى لاحقًا.', true);
    });
  }
  function showSubscribeCard(kind) {
    if (!canShowSubscribe(kind)) return false;
    removeSubscribeCard();
    var isExit = kind === 'exit';
    if (isExit) subExitShown = true;
    else {
      subAfterReplyShown = true;
      try { sessionStorage.setItem(SUBSCRIBE_KEY, 'after_seen'); } catch (e) {}
    }
    var title = isExit ? SUBSCRIBE_CFG.exitTitle : SUBSCRIBE_CFG.title;
    var text = isExit ? SUBSCRIBE_CFG.exitText : SUBSCRIBE_CFG.text;
    subCard = inject('div', { class: 'mjd-sub', role: 'group', 'aria-label': title },
      '<div class="mjd-sub-hd">' +
        '<div><b>' + esc(title) + '</b><span>' + esc(text) + '</span></div>' +
        '<button class="mjd-sub-x" type="button" aria-label="إغلاق">×</button>' +
      '</div>' +
      '<div class="mjd-sub-form">' +
        '<input type="email" inputmode="email" autocomplete="email" placeholder="بريدك الإلكتروني"/>' +
        '<button class="mjd-sub-btn" type="button">' + (isExit ? 'اشترك وأغلق' : 'اشترك') + '</button>' +
      '</div>' +
      '<button class="mjd-sub-skip" type="button">' + (isExit ? 'لا، شكرًا' : 'ليس الآن') + '</button>' +
      '<div class="mjd-sub-msg" aria-live="polite"></div>');
    var mail = subCard.querySelector('input');
    var btn = subCard.querySelector('.mjd-sub-btn');
    var skip = subCard.querySelector('.mjd-sub-skip');
    var close = subCard.querySelector('.mjd-sub-x');
    var msg = subCard.querySelector('.mjd-sub-msg');
    btn.addEventListener('click', function () { submitSubscribe(mail.value, kind, msg, btn); });
    mail.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitSubscribe(mail.value, kind, msg, btn); });
    skip.addEventListener('click', function () {
      markSubscribeState('dismissed');
      removeSubscribeCard();
      if (isExit) closePanel(true);
    });
    close.addEventListener('click', function () {
      removeSubscribeCard();
      if (isExit) closePanel(true);
    });
    bd.appendChild(subCard);
    scrollDown();
    return true;
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
  // customer's own voice note → an inline audio player of their recording. We show the
  // recording (not the transcript) so the spoken text stays private; only the bot sees it.
  function addVoiceNote(blob) {
    var url = '';
    try { url = URL.createObjectURL(blob); } catch (e) {}
    if (url) addAttachment({ file_type: 'audio', data_url: url }, true);
  }
  // ---------- course / track cards ----------
  var AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
                   'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  // "2026-08-20 16:00:00" → "20 أغسطس". Formatted here, not in the bridge, so
  // the customer always reads Arabic months whatever the server's locale is.
  function fmtDay(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '';
    return Number(m[3]) + ' ' + (AR_MONTHS[Number(m[2]) - 1] || '');
  }
  function tag(text, cls) {
    return text ? '<span class="mjd-tag' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>' : '';
  }
  // The price is the one number a customer scans for, so it gets its own slot
  // and its own weight instead of being buried in a run-on grey line.
  function priceBlock(main, note, was) {
    if (!main) return '<div class="mjd-price"><em>' + esc(note || 'اطلب السعر الحالي') + '</em></div>';
    var parts = String(main).split(' ');
    var num = parts.shift(), cur = parts.join(' ');
    return '<div class="mjd-price">' + esc(num) + (cur ? '<i>' + esc(cur) + '</i>' : '') +
      (was ? '<s>' + esc(was) + '</s>' : '') + (note ? '<em>' + esc(note) + '</em>' : '') + '</div>';
  }
  // Odoo declares /shop/cart/update as POST-only. Opening the generated URL as
  // an <a> sent GET and produced the customer-facing "Method Not Allowed"
  // page. Submit the same fields as a real form, including Odoo's CSRF token
  // when the host page exposes it.
  function checkoutButton(rawUrl) {
    try {
      var url = new URL(String(rawUrl || ''), window.location.href);
      if (!/^https?:$/.test(url.protocol) || !/\/shop\/cart\/update\/?$/.test(url.pathname)) return '';
      var productId = url.searchParams.get('product_id');
      if (!/^\d+$/.test(productId || '')) return '';
      var tokenField = document.querySelector('input[name="csrf_token"]');
      var tokenMeta = document.querySelector('meta[name="csrf-token"]');
      var csrf = (window.odoo && window.odoo.csrf_token) ||
        (tokenField && tokenField.value) || (tokenMeta && tokenMeta.content) || '';
      var hidden = '<input type="hidden" name="product_id" value="' + esc(productId) + '"/>' +
        '<input type="hidden" name="add_qty" value="' + esc(url.searchParams.get('add_qty') || '1') + '"/>' +
        '<input type="hidden" name="express" value="' + esc(url.searchParams.get('express') || '1') + '"/>';
      if (csrf) hidden += '<input type="hidden" name="csrf_token" value="' + esc(csrf) + '"/>';
      return '<form class="mjd-buy-form" method="post" action="' +
        esc(url.origin + url.pathname) + '" target="_blank">' + hidden +
        '<button class="mjd-buy" type="submit">' + I.cart + 'اشترِ الدورة الآن</button></form>';
    } catch (_) {
      return '';
    }
  }
  function courseCardHtml(it) {
    var h = '<div class="mjd-crs-top">';
    if (it.media_url) h += '<img class="mjd-crs-th" src="' + esc(it.media_url) + '" alt="" ' +
      'onerror="this.style.display=\'none\'"/>';
    h += '<div class="mjd-crs-hd"><b class="mjd-crs-t">' + esc(it.title) + '</b>';
    var by = '';
    if (it.instructor) {
      by += '<span class="mjd-in">' + I.user + esc(it.instructor) +
        (it.instructors_count > 1 ? ' +' + (it.instructors_count - 1) : '') + '</span>';
    }
    if (it.rating) by += '<span class="mjd-rt">★ ' + esc(String(it.rating)) + '</span>';
    if (by) h += '<div class="mjd-crs-by">' + by + '</div>';
    h += '</div></div>';

    var tags = tag(it.delivery, 'mjd-tag-b') + tag(it.duration_text);
    if (it.starts_at) tags += tag('تبدأ ' + fmtDay(it.starts_at));
    if (tags) h += '<div class="mjd-tags">' + tags + '</div>';

    h += '<div class="mjd-crs-ft">' + priceBlock(it.price_display) + '<div class="mjd-cta">';
    if (it.checkout_url) h += checkoutButton(it.checkout_url);
    // "تفاصيل أكتر" goes back through ماجد (STAGE 3 of the funnel) — the bot
    // answers with the full details, link and reviews — instead of jumping the
    // customer straight out to the page and dropping them from the conversation.
    if (it.course_id || it.url) h += '<button class="mjd-det" type="button" data-pb="' +
      esc('أرغب في معرفة مزيد من التفاصيل عن «' + (it.title || 'الدورة') + '»') + '">مزيد من التفاصيل</button>';
    return h + '</div></div>';
  }
  // A photo that 404s (Odoo may not serve employee images publicly) must not
  // leave a broken frame — initials in the brand gradient read as intentional.
  function initials(name) {
    var parts = String(name || '').replace(/^(د|م|أ|Dr|Eng|Mr|Ms)\.?\s*/i, '')
      .trim().split(/\s+/).filter(Boolean);
    return (parts.slice(0, 2).map(function (w) { return w[0]; }).join('') || '؟')
      .toUpperCase();
  }
  function instructorCardHtml(it) {
    var ph = it.media_url
      ? '<img class="mjd-ins-ph" src="' + esc(it.media_url) + '" alt="" ' +
        'onerror="this.outerHTML=\'<div class=&quot;mjd-ins-ph&quot;>' +
        esc(initials(it.title)) + '</div>\'"/>'
      : '<div class="mjd-ins-ph">' + esc(initials(it.title)) + '</div>';
    var h = ph + '<div class="mjd-ins-in"><b>' + esc(it.title) + '</b>';
    var count = Number(it.courses_count) || 0;
    var countLabel = !count ? '' : count === 1 ? 'دورة واحدة' :
      count === 2 ? 'دورتان' : count <= 10 ? count + ' دورات' : count + ' دورة';
    var sub = [it.job_title, countLabel]
      .filter(Boolean).join(' · ');
    if (sub) h += '<s>' + esc(sub) + '</s>';
    if ((it.teaches || []).length) {
      h += '<div class="mjd-ins-cs">' +
        it.teaches.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') +
        '</div>';
    }
    // The profile the site shows in its own popup: biography, specialisations,
    // experience. Long bios are clamped with a «اقرأ المزيد» toggle rather than
    // pushing the whole conversation off the screen.
    if (it.bio) {
      h += '<p class="mjd-ins-bio">' + esc(it.bio) + '</p>' +
(String(it.bio).length > 190 ? '<button class="mjd-more" type="button">اقرأ المزيد</button>' : '');
    }
    (it.sections || []).forEach(function (sec) {
      if (!sec || !(sec.items || []).length) return;
      h += '<div class="mjd-ins-sec"><b>' + esc(sec.label) + '</b><ul>' +
        sec.items.slice(0, 6).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') +
        '</ul></div>';
    });
    return h + '</div>';
  }
  function packageCardHtml(it) {
    var h = '<div class="mjd-pkg-hd"><span class="mjd-pkg-kd">مسار متكامل</span><b>' +
      esc(it.title) + '</b></div>';
    var tags = '';
    if (it.courses_count) tags += tag(it.courses_count + ' دورة', 'mjd-tag-b');
    if (it.training_hours) tags += tag(it.training_hours + ' ساعة');
    if (it.attendance) tags += tag(it.attendance);
    if (it.starts_at) tags += tag('أقرب دفعة ' + fmtDay(it.starts_at));
    if (it.badge) tags += tag(it.badge, 'mjd-tag-hot');
    if (tags) h += '<div class="mjd-tags">' + tags + '</div>';
    // every buyable option, listed: a track has no single price, and showing
    // one number quotes the recorded track to someone asking about onsite
    if ((it.options || []).length) {
      h += '<div class="mjd-pkg-op">';
      it.options.forEach(function (o) {
        h += '<div><span>' + esc(o.label) + '</span><b>' + esc(o.price_display) +
          (o.was_display ? ' <s>' + esc(o.was_display) + '</s>' : '') + '</b></div>';
      });
      h += '</div>';
    }
    h += '<div class="mjd-crs-ft">' +
      priceBlock(it.price_from_display, (it.options || []).length > 1 ? 'يبدأ من' : '') +
      '<div class="mjd-cta">';
    if (it.url) h += '<a class="mjd-buy" href="' + esc(it.url) +
      '" target="_blank" rel="noopener">' + I.cart + 'عرض المسار</a>';
    return h + '</div></div>';
  }
  function addCard(attrs, target) {
    var items = (attrs && attrs.items) || [];
    items.forEach(function (it) {
      var card;
      if (it.kind === 'course') {
        card = inject('div', { class: 'mjd-crs' }, courseCardHtml(it));
      } else if (it.kind === 'package') {
        card = inject('div', { class: 'mjd-pkg' }, packageCardHtml(it));
      } else if (it.kind === 'instructor') {
        card = inject('div', { class: 'mjd-ins' }, instructorCardHtml(it));
        var more = card.querySelector('.mjd-more');
        if (more) {
          more.addEventListener('click', function () {
            var open = card.classList.toggle('mjd-open-bio');
            more.textContent = open ? 'اقرأ أقل' : 'اقرأ المزيد';
            scrollDown();
          });
        }
      } else {
        // Botpress cards keep the original renderer, unchanged
        var h = (it.media_url || it.image_url ? '<img src="' + esc(it.media_url || it.image_url) + '" alt=""/>' : '') +
          '<div class="mjd-ct"><b>' + esc(it.title) + '</b>' + (it.description ? '<span>' + esc(it.description) + '</span>' : '') + '</div>';
        (it.actions || []).forEach(function (a) {
          if (a.type === 'link') h += '<a href="' + esc(a.uri) + '" target="_blank" rel="noopener">' + esc(a.text) + '</a>';
          else h += '<button data-pb="' + esc(a.payload || a.text) + '">' + esc(a.text) + '</button>';
        });
        card = inject('div', { class: 'mjd-card' }, h);
      }
      card.querySelectorAll('button[data-pb]').forEach(function (btn) {
        // send the postback value to the bot, but show the human label in the bubble
        btn.addEventListener('click', function () { sendMessage(btn.getAttribute('data-pb'), btn.textContent); });
      });
      // Leaving for the course page must never cost the conversation: the link
      // opens a new tab, and rememberOpen() makes the chat come back already
      // open there, with the transcript restored.
      card.querySelectorAll('a[target="_blank"]').forEach(function (a) {
        a.addEventListener('click', rememberOpen);
      });
      (target || bd).appendChild(card);
    });
    scrollDown();
  }
  function addOptions(attrs, content, target) {
    var items = (attrs && attrs.items) || [];
    if (content && !target) addBot(mdToHtml(content), true);
    var wrap = inject('div', { class: 'mjd-options' }, '');
    items.forEach(function (it) {
      var b = inject('button', { class: 'mjd-opt', type: 'button', 'data-val': it.value || it.title || '' }, esc(it.title || it.value || 'اختيار'));
      // the customer sees the label they clicked; the bot receives the option value
      b.addEventListener('click', function () { sendMessage(b.getAttribute('data-val'), b.textContent); });
      wrap.appendChild(b);
    });
    if (items.length) { (target || bd).appendChild(wrap); scrollDown(); }
  }
  function responseKey(m) {
    var attrs = (m && m.content_attributes) || {};
    return String(attrs.stream_id || (m && m.id != null ? 'message-' + m.id : 'message-' + Date.now() + '-' + Math.random()));
  }
  function ensureResponse(m) {
    var key = responseKey(m);
    var hit = responseStreams[key];
    if (hit && hit.row && hit.row.parentNode) return hit;
    var row = inject('div', { class: 'mjd-row mjd-bot mjd-answer-row' },
      '<img class="mjd-mini" src="' + AVATAR + '"' + AVA_ERR + '/>' +
      '<section class="mjd-answer" role="group" aria-label="استجابة ماجد">' +
        '<div class="mjd-bub mjd-md mjd-answer-copy" aria-live="polite" aria-atomic="false"></div>' +
        '<div class="mjd-answer-rich"></div>' +
      '</section>');
    bd.appendChild(row);
    attachReply(row, 'bot');
    hit = {
      row: row,
      answer: row.querySelector('.mjd-answer'),
      copy: row.querySelector('.mjd-answer-copy'),
      rich: row.querySelector('.mjd-answer-rich'),
      raw: ''
    };
    responseStreams[key] = hit;
    scrollDown();
    return hit;
  }
  function setResponseCopy(hit, value) {
    hit.raw = String(value || '');
    hit.copy.innerHTML = hit.raw ? mdToHtml(hit.raw) : '';
  }
  function renderAssistantResponse(m) {
    var attrs = m.content_attributes || {};
    var state = attrs.stream_state || 'complete';
    var key = responseKey(m);
    if (state === 'abort') {
      var aborted = responseStreams[key];
      if (aborted && aborted.row) aborted.row.remove();
      delete responseStreams[key];
      return;
    }

    var hit = ensureResponse(m);
    if (state === 'start') {
      hit.answer.classList.add('mjd-streaming');
      return;
    }
    if (state === 'delta') {
      hit.answer.classList.add('mjd-streaming');
      setResponseCopy(hit, hit.raw + String(m.content || ''));
      scrollDown();
      return;
    }

    hit.answer.classList.remove('mjd-streaming');
    setResponseCopy(hit, m.content || hit.raw);
    hit.rich.innerHTML = '';
    if (m.content_type === 'cards' && (attrs.items || []).length) {
      addCard(attrs, hit.rich);
    } else if (m.content_type === 'input_select' && (attrs.items || []).length) {
      addOptions(attrs, '', hit.rich);
    }
    if ((attrs.quick_replies || []).length) {
      addOptions({ items: attrs.quick_replies }, '', hit.rich);
    }
    scrollDown();
  }
  function addMedia(attrs, content) {
    attrs = attrs || {};
    var url = stripMediaTag(attrs.url || '');
    var kind = attrs.media_type || 'file';
    var title = attrs.title || mediaTitleFromUrl(url, kind) || url || 'ملف';
    var caption = String(content || '').trim();
    if (caption && caption !== title && caption !== url) addBot(mdToHtml(caption), true);
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
  var typingEl = null, typingTimer = null;
  // rotating "thinking" phrases shown while Majed prepares a reply
  var THINK_PHRASES = [
    'يحلّل ماجد طلبك…',
    'يراجع بيانات الدورات…',
    'يتحقق من السعر والتفاصيل…',
    'يصوغ إجابة مناسبة…',
    'لحظة من فضلك…'
  ];
  function showTyping() {
    if (typingEl) return;
    typingEl = inject('div', { class: 'mjd-typing' },
      '<span class="mjd-dots"><i></i><i></i><i></i></span><span class="mjd-tw"></span>');
    var tw = typingEl.querySelector('.mjd-tw');
    var i = Math.floor(Math.random() * THINK_PHRASES.length);
    var rotate = function () {
      tw.textContent = THINK_PHRASES[i % THINK_PHRASES.length];
      // restart the fade animation on each phrase change
      tw.style.animation = 'none'; void tw.offsetWidth; tw.style.animation = '';
      i++;
    };
    rotate();
    typingTimer = setInterval(rotate, 1600);
    bd.appendChild(typingEl); scrollDown();
  }
  function hideTyping() {
    if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
    if (typingEl) { typingEl.remove(); typingEl = null; }
  }

  // one agent/bot message (from SSE or transcript) → the right bubble type
  function renderAgentMessage(m) {
    m = m || {};
    m.content_attributes = objectAttrs(m.content_attributes);
    if (m.content_type === 'assistant_stream' || m.content_type === 'cards' ||
        (m.content_attributes.stream_id &&
          (m.content_type === 'text' || m.content_type === 'input_select'))) {
      renderAssistantResponse(m);
      return;
    }
    var inlineMedia = (!m.content_type || m.content_type === 'text') && m.content ? detectMediaInText(m.content) : null;
    if (inlineMedia) {
      if (inlineMedia.caption) addBot(mdToHtml(inlineMedia.caption), true);
      addMedia({ media_type: inlineMedia.kind, url: inlineMedia.url, title: inlineMedia.title }, '');
    } else if (m.content_type === 'input_select' && m.content_attributes) {
      addOptions(m.content_attributes, m.content);
    } else if (m.content_type === 'media' && m.content_attributes) {
      addMedia(m.content_attributes, m.content);
    } else if (m.content) {
      addBot(mdToHtml(m.content), true);
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
          // the shop's own language code, so the bot names courses the way
          // the page does ('ar-001' here, 'ar_001' in Odoo)
          lang: (function () {
            try { return document.documentElement.getAttribute('lang') || ''; }
            catch (e) { return ''; }
          })(),
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
  // backstop ضد الرسالة المكرّرة: لو نفس المحتوى وصل عبر الستريم مرتين بـ id مختلف
  // خلال نافذة قصيرة (مثلاً echo من Chatwoot بعد البث الحي)، نتجاهل التكرار.
  var recentStream = []; // [{ sig, ts }]
  function streamSig(m) {
    m = m || {};
    var ca = m.content_attributes || {};
    var att = (m.attachments || []).map(function (a) { return a.data_url || a.url || a.name || ''; }).join(',');
    var extra = ca.url || ca.image_url || '';
    if (ca.stream_id) extra += '#' + ca.stream_id + ':' + String(ca.sequence ?? '');
    try { if (ca.items) extra += '#' + ca.items.length; } catch (e) {}
    return (m.content_type || 'text') + '|' + (m.content || '') + '|' + att + '|' + extra;
  }
  function isRecentDuplicate(m) {
    var sig = streamSig(m), now = Date.now();
    recentStream = recentStream.filter(function (e) { return now - e.ts < 4000; });
    for (var i = 0; i < recentStream.length; i++) { if (recentStream[i].sig === sig) return true; }
    recentStream.push({ sig: sig, ts: now });
    return false;
  }
  function renderStreamMessage(m) {
    if (m.id != null) {
      if (seenIds[m.id]) return;
      seenIds[m.id] = 1;
    }
    if (isRecentDuplicate(m)) return;
    hideTyping();
    renderAgentMessage(m);
    if (live && m.content_type !== 'assistant_stream') showSubscribeCard('after_reply');
  }

  // transcript restore (reopen / switch from history)
  function loadMessages(id) {
    loadingTranscript = true;
    return fetch(BRIDGE + '/widget/messages?conversationId=' + encodeURIComponent(id))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var msgs = (d && d.messages) || [];
        if (!msgs.length) return;
        bd.innerHTML = ''; responseStreams = {}; hideTyping();
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
      sessionConfig = d || {};
      if (d && d.conversationId) {
        convId = d.conversationId;
        forceNew = false;
        saveStoredConv(convId);
        rememberConv(convId);
        var p = d.reused ? loadMessages(convId) : Promise.resolve();
        return p.then ? p.then(function () { openStream(); }) : openStream();
      }
      addBot('تعذّر بدء المحادثة. حاول مرة أخرى بعد لحظات.'); started = false;
    }).catch(function () { addBot('تعذّر الاتصال. حاول مرة أخرى.'); started = false; });
  }

  // text = what is sent to the bridge/bot; display = what the customer sees in their bubble
  // (for choice/postback clicks display is the button label, not the raw value).
  function sendMessage(text, display) {
    text = (text || '').trim();
    // a picked file goes out with the typed text as caption (button clicks don't consume it)
    if (pendingFile && display == null) { clearReply(); sendAttachment(text); return; }
    if (!text) return;
    removeSubscribeCard();
    var rep = replyTo;   // capture before clearing, so the send carries the quote
    clearReply();
    addMe((display || text).trim() || text, rep ? rep.text : '');
    setLive(true);
    // Keep the "was open" memory fresh on every active turn, so a long live
    // chat still reopens ماجد in a newly opened tab instead of aging out.
    rememberOpen();
    if (!convId) { startSession().then(function () { if (convId) postMsg(text, rep); }); return; }
    postMsg(text, rep);
  }
  function postMsg(text, rep) {
    showTyping();
    var body = { conversationId: convId, text: text, userData: userData };
    if (rep && rep.text) body.replyTo = { text: rep.text, role: rep.role };
    fetch(BRIDGE + '/widget/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
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
      addBot('حجم الملف أكبر من ' + MAX_FILE_MB + 'MB. يُرجى إرسال ملف أصغر.');
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
      if (!convId) { fail('تعذّر بدء المحادثة. حاول مرة أخرى.'); return; }
      var fd = new FormData();
      fd.append('file', f, f.name);
      fd.append('conversationId', convId);
      if (caption) fd.append('caption', caption);
      try { fd.append('userData', JSON.stringify(userData)); } catch (e) {}
      fetch(BRIDGE + '/widget/upload', { method: 'POST', body: fd })
        .then(function (r) {
          if (r.ok) return r.json();
          if (r.status === 413) throw new Error('حجم الملف أكبر من ' + MAX_FILE_MB + 'MB. يُرجى إرسال ملف أصغر.');
          if (r.status === 415) throw new Error('نوع الملف غير مدعوم.');
          throw new Error('تعذّر رفع الملف. حاول مرة أخرى.');
        })
        .then(function () { done(); })
        .catch(function (e) { fail(e && e.message ? e.message : 'تعذّر رفع الملف. حاول مرة أخرى.'); });
    };
    var done = function () { uploading = false; sendBtn.removeAttribute('disabled'); };
    var fail = function (msg) { uploading = false; sendBtn.removeAttribute('disabled'); hideTyping(); addBot(esc(msg)); };

    if (!convId) startSession().then(doUpload);
    else doUpload();
  }

  // ---------- voice recording (تسجيل صوتي → Deepgram → نص للبوت؛ العميل يشوف التسجيل فقط) ----------
  var mediaRec = null, mediaChunks = [], mediaStream = null, recTimer = null, recStart = 0, recCancelled = false, voiceSending = false;
  function isRecording() { return !!(mediaRec && mediaRec.state === 'recording'); }
  function pickRecMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    var opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    for (var i = 0; i < opts.length; i++) { if (MediaRecorder.isTypeSupported(opts[i])) return opts[i]; }
    return '';
  }
  function stopTracks() {
    if (mediaStream) { try { mediaStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} mediaStream = null; }
  }
  function tickRec() {
    var s = Math.floor((Date.now() - recStart) / 1000);
    if (recTime) recTime.textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    if (s >= 120) stopRecording(false); // حد أقصى دقيقتين
  }
  function showRecBar() {
    if (recBar) recBar.classList.add('mjd-on');
    if (recBtn) recBtn.classList.add('mjd-recording');
    tickRec(); clearInterval(recTimer); recTimer = setInterval(tickRec, 500);
  }
  function hideRecBar() {
    if (recBar) recBar.classList.remove('mjd-on');
    if (recBtn) recBtn.classList.remove('mjd-recording');
    clearInterval(recTimer);
  }
  function startRecording() {
    if (voiceSending) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      addBot('التسجيل الصوتي غير مدعوم في هذا المتصفح 🎙️'); return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      mediaStream = stream;
      var mime = pickRecMime();
      try { mediaRec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch (e) { mediaRec = new MediaRecorder(stream); }
      mediaChunks = []; recCancelled = false;
      mediaRec.ondataavailable = function (ev) { if (ev.data && ev.data.size) mediaChunks.push(ev.data); };
      mediaRec.onstop = function () {
        stopTracks();
        if (recCancelled) { mediaChunks = []; return; }
        var type = (mediaRec && mediaRec.mimeType) || mime || 'audio/webm';
        var blob = new Blob(mediaChunks, { type: type });
        mediaChunks = [];
        if (blob.size > 400) sendVoice(blob);
      };
      mediaRec.start();
      recStart = Date.now();
      showRecBar();
    }).catch(function () { addBot('أحتاج إلى إذن الميكروفون لتسجيل رسالتك الصوتية.'); });
  }
  function stopRecording(cancel) {
    recCancelled = !!cancel;
    hideRecBar();
    if (mediaRec && mediaRec.state !== 'inactive') { try { mediaRec.stop(); } catch (e) { stopTracks(); } }
    else stopTracks();
  }
  function sendVoice(blob) {
    if (!blob || !blob.size || voiceSending) return;
    voiceSending = true;
    setLive(true);
    var doSend = function () {
      if (!convId) { voiceSending = false; return; }
      var ext = blob.type.indexOf('mp4') >= 0 ? 'm4a' : blob.type.indexOf('ogg') >= 0 ? 'ogg' : 'webm';
      var fd = new FormData();
      fd.append('file', blob, 'voice.' + ext);
      fd.append('conversationId', convId);
      fd.append('userData', JSON.stringify(userData));
      // Show the customer's recording (audio player), NOT the transcript — the spoken text
      // stays private and only reaches the bot server-side. Then «ماجد يفكّر…» → رد ماجد.
      addVoiceNote(blob);
      showTyping();
      fetch(BRIDGE + '/widget/voice', { method: 'POST', body: fd })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          voiceSending = false;
          // Speech recognised → keep the indicator until Majed's reply lands over SSE.
          if (res.ok && res.d && res.d.transcript) return;
          // No speech / transcription failed → stop the indicator and nudge the customer.
          hideTyping();
          if (res.d && res.d.error === 'transcribe_failed') addBot('تعذّر تحويل الصوت إلى نص، حاول مرة أخرى 🎙️');
          else addBot('لم أسمع صوتًا واضحًا، حاول مرة أخرى 🎙️');
        })
        .catch(function () { voiceSending = false; hideTyping(); addBot('تعذّر إرسال التسجيل، حاول مرة أخرى.'); });
    };
    if (!convId) startSession().then(doSend); else doSend();
  }

  // ---------- conversation history («المحادثات السابقة») ----------
  function openHistory() {
    hist.classList.add('mjd-on');
    histLs.innerHTML = '<div class="mjd-skel"></div><div class="mjd-skel"></div><div class="mjd-skel"></div>';
    ensureCtx().then(function () {
      var entries = listConvs();
      if (!entries.length) {
        histLs.innerHTML = '<div class="mjd-hist-empty">لا توجد محادثات سابقة بعد.<br/>ابدأ محادثتك الأولى مع ماجد.</div>';
        return;
      }
      var ids = entries.map(function (e) { return e.id; }).join(',');
      fetch(BRIDGE + '/widget/conversations?ids=' + encodeURIComponent(ids))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var list = (d && d.conversations) || [];
          if (!list.length) {
            histLs.innerHTML = '<div class="mjd-hist-empty">لا توجد محادثات سابقة بعد.<br/>ابدأ محادثتك الأولى مع ماجد.</div>';
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
          histLs.innerHTML = '<div class="mjd-hist-empty">تعذّر تحميل المحادثات. حاول مرة أخرى.</div>';
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
    responseStreams = {};
    removeSubscribeCard();
    bd.innerHTML = ''; hideTyping();
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
    responseStreams = {};
    removeSubscribeCard();
    bd.innerHTML = ''; hideTyping();
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
  //  - excludeOnSelector: لو العنصر ده موجود في الصفحة → التيزر مايظهرش (مثلاً قائمة الدورات
  //    تستثني صفحة الدورة المفردة اللي فيها تفاصيل المنتج)
  //  - showOn: substring أو مصفوفة في الـ URL (host+path+query)
  //  - showOnSelector: يظهر لو عنصر بالـ selector ده موجود في الصفحة (مفيد لصفحات الكورس/المنتج)
  //  - من غير أي منهم → يظهر في كل صفحة
  function tzMatchesPage(t) {
    if (!t) return false;
    var here = '';
    try { here = (location.host + location.pathname + location.search).toLowerCase(); } catch (e) { here = ''; }
    // excludeOn: لو الـ URL طابق أحد الأنماط دي → التيزر مايظهرش (يكسب على showOn).
    // بيمنع تسرّب تيزرات المتجر/الكورس العامة على صفحات السلة/الدفع (لأن '/shop/cart'
    // بتحتوي على '/shop' كـ substring).
    if (t.excludeOn != null) {
      var ex = Array.isArray(t.excludeOn) ? t.excludeOn : [t.excludeOn];
      for (var j = 0; j < ex.length; j++) {
        var ep = String(ex[j] || '').trim().toLowerCase();
        if (ep && here.indexOf(ep) !== -1) return false;
      }
    }
    if (t.excludeOnSelector) {
      try { if (document.querySelector(t.excludeOnSelector)) return false; } catch (e) {}
    }
    if (!tzIsTargeted(t)) return true;
    if (t.showOnSelector) {
      try { if (document.querySelector(t.showOnSelector)) return true; } catch (e) {}
    }
    if (t.showOn != null) {
      var pats = Array.isArray(t.showOn) ? t.showOn : [t.showOn];
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
    var name = pageCourseName() || (pageLang() === 'en' ? 'this course' : 'هذه الدورة');
    if (escapeName) name = esc(name);
    return s.replace(/\{\{course\}\}/g, name);
  }

  // لغة الصفحة الحالية: 'en' لو الموقع إنجليزي (من <html lang> أو بادئة الرابط /en/…)، وإلا 'ar'.
  // بيتحدّث تلقائيًا لما العميل يبدّل لغة الموقع (Odoo بيعمل reload)، فالتيزر بيظهر باللغة الصح.
  function pageLang() {
    var l = '';
    try { l = (document.documentElement.getAttribute('lang') || '').toLowerCase(); } catch (e) {}
    if (l.indexOf('en') === 0) return 'en';
    if (l.indexOf('ar') === 0) return 'ar';
    try {
      var m = location.pathname.toLowerCase().match(/^\/([a-z]{2})(?:[-_][a-z]{2,3})?(?:\/|$)/);
      if (m && m[1] === 'en') return 'en';
    } catch (e) {}
    return 'ar';
  }
  // نص التيزر باللغة الحالية: لو الصفحة إنجليزي وللتيزر ترجمة en[key] → استخدمها، وإلا العربي.
  function tzText(t, key) {
    if (pageLang() === 'en' && t && t.en && t.en[key] != null) return t.en[key];
    return t ? t[key] : undefined;
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
    var en = pageLang() === 'en';
    var txHtml = resolveCourse(tzText(t, 'html') || '', true);
    var msg = tzText(t, 'botMessage');
    var msgLabel = tzText(t, 'botMessageLabel') || (en ? 'Chat 💬' : 'كلّمني 💬');
    var linkTx = tzText(t, 'linkText') || (en ? 'Open link' : 'افتح الرابط');
    var codeLbl = tzText(t, 'codeLabel') || t.code;
    var dirAttr = en ? ' dir="ltr" style="text-align:left"' : '';
    var h = '<img src="' + AVATAR + '"' + AVA_ERR + ' alt="ماجد"/>' +
      '<div' + dirAttr + '><div class="mjd-tz-tx">' + txHtml + '</div>';
    if (t.link || t.code || msg) {
      h += '<div class="mjd-tz-act">';
      if (msg) h += '<button class="mjd-tz-go mjd-tz-ask" type="button" data-msg="' + esc(msg) + '">' + esc(msgLabel) + '</button>';
      if (t.link) h += '<a class="mjd-tz-go" href="' + esc(t.link) + '" target="_blank" rel="noopener">' + esc(linkTx) + ' ↗</a>';
      if (t.code) h += '<button class="mjd-tz-code" type="button" data-code="' + esc(t.code) + '" data-label="' + esc(codeLbl) + '">🏷️ ' + esc(codeLbl) + '</button>';
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
      var copied = en ? '✓ Copied: ' : '✓ تم النسخ: ';
      var ok = function () { codeBtn.textContent = copied + code; setTimeout(function () { codeBtn.textContent = '🏷️ ' + label; }, 2200); };
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
  // ===== استمرارية الشات عبر الصفحات =====
  // A course link opens a new tab; that tab used to load with the panel closed,
  // so the customer had to click ماجد again and lost the thread visually. We
  // remember "the panel was open" for a short window and reopen it on load —
  // the conversation id is already stored, so the transcript comes back with it.
  var OPEN_KEY = 'majed:open:' + BRIDGE;
  var OPEN_TTL = 30 * 60 * 1000;
  function rememberOpen() {
    try { localStorage.setItem(OPEN_KEY, String(Date.now())); } catch (e) {}
  }
  function forgetOpen() {
    try { localStorage.removeItem(OPEN_KEY); } catch (e) {}
  }
  function wasOpenRecently() {
    try {
      var t = Number(localStorage.getItem(OPEN_KEY) || 0);
      return t > 0 && Date.now() - t < OPEN_TTL;
    } catch (e) { return false; }
  }

  function openPanel() {
    hideTeaser();
    panel.classList.add('mjd-open');
    requestAnimationFrame(applyPos); // النافذة دلوقتي ليها ارتفاع حقيقي → نضمن إنها جوة الشاشة
    startSession();
    rememberOpen();
    setTimeout(function () { input.focus(); }, 200);
  }
  // يفتح الشات ويبعت رسالة جاهزة للبوت (مستخدَم من زرار التيزر «ساعدني في الشراء»).
  // بنبدأ الجلسة الأول وننتظرها عشان convId يبقى جاهز قبل الإرسال (نتفادى سباق startSession).
  function openPanelAndSend(text, label) {
    hideTeaser();
    panel.classList.add('mjd-open');
    requestAnimationFrame(applyPos);
    rememberOpen();
    setTimeout(function () { input.focus(); }, 200);
    startSession().then(function () { sendMessage(text, label || text); });
  }

  // X = قفل النافذة ورجوع الزر العائم فقط — المحادثة وSSE فاضلين شغالين بالظبط
  function closePanel(force) {
    var forced = force === true;
    if (!forced && panel.classList.contains('mjd-open') && live && showSubscribeCard('exit')) return;
    removeSubscribeCard();
    panel.classList.remove('mjd-open');
    forgetOpen();   // closing is a decision — it must survive the next page too
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
    closePanel(true);
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
    addBot('ستتوفر المحادثة الصوتية قريبًا. يمكنني الآن مساعدتك كتابةً أو تحويلك إلى أحد الموظفين.');
  });
  document.getElementById('mjd-theme').addEventListener('click', function () {
    panel.setAttribute('data-theme', panel.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  document.getElementById('mjd-att-btn').addEventListener('click', function () { fileIn.click(); });
  fileIn.addEventListener('change', function () { setPendingFile(fileIn.files && fileIn.files[0]); });
  if (recBtn) {
    recBtn.addEventListener('click', function () { if (isRecording()) stopRecording(false); else startRecording(); });
    var recCancel = document.getElementById('mjd-rec-cancel');
    if (recCancel) recCancel.addEventListener('click', function () { stopRecording(true); });
  }
  document.getElementById('mjd-hist-btn').addEventListener('click', function () {
    hist.classList.contains('mjd-on') ? closeHistory() : openHistory();
  });
  document.getElementById('mjd-hist-x').addEventListener('click', closeHistory);
  document.getElementById('mjd-new').addEventListener('click', newConversation);

  // أول ظهور — التيزر بيظهر للكل (الترحيب)، وعرض الكورس بس للزوار قبل اللوجين.
  // ولو العميل كان فاتح الشات وراح يفتح صفحة كورس: الشات يفتح لوحده بالمحادثة
  // كاملة بدل ما يدوّر على الزر تاني. على الموبايل النافذة بتغطي الصفحة، فبنسيبه
  // مقفول ونكتفي بالتيزر — هو راح يقرأ الكورس مش الشات.
  ensureCtx().then(function () {
    if (wasOpenRecently() && window.innerWidth >= 768 &&
        !root.classList.contains('mjd-hidden')) {
      openPanel();
      return;
    }
    showTeaser();
  });
})();
