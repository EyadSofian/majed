# ماجد «نور» — Handover كامل (Path B)

> **⚠ تحديث (يونيو 2026):** جهة Botpress اتنقلت من Webhook Integration إلى **Botpress Chat API الحقيقي**
> (users/conversations/SSE). تعليمات الربط والمتغيرات الحالية في:
> [`integration/BOTPRESS_CHAT_API_SETUP.md`](integration/BOTPRESS_CHAT_API_SETUP.md) —
> المتغير الأساسي بقى `BOTPRESS_CHAT_WEBHOOK_ID` (و`BOTPRESS_WEBHOOK_URL` اتشال).
> باقي هذا الملف (الويدجت/Odoo/Chatwoot/Railway) ساري كما هو.

> مساعد Engosoft التعليمي. **ويدجت مخصّص بالكامل** («نور») على موقع Odoo، متوصّل بـ **بريدج Node/Express** على Railway،
> اللي بيربط الموقع ↔ **Chatwoot (API Channel)** ↔ **Botpress (مخ البوت)**. ردود فورية بـ **SSE**.
> الريبو: https://github.com/EyadSofian/majed · آخر تحديث: يونيو 2026.

---

## 0) أمان — اقرأه الأول 🔐
- **التوكن اللي اتشارك في الشات نصًا (`Buvw2…`) لازم يتعمله Rotate** من Chatwoot (Profile → Access Token → Regenerate). متحطّوش في أي ملف على GitHub — مكانه **Railway env بس**.
- مفيش أي سر متخزّن في الريبو (`.env` متجاهَل في `.gitignore`).

---

## 1) المعمارية (Path B)

```
   ويدجت «نور» (Odoo site)
        │  (1) POST /widget/session  → conversationId
        │  (2) GET  /widget/stream   → SSE (ردود فورية)
        │  (3) POST /widget/message  → رسالة العميل + بيانات المتدرب
        ▼
     ┌─────────────────┐   forward + userData    ┌──────────┐
     │  البريدج (Railway) │ ──────────────────────▶ │ Botpress │  ← المخ
     │  Node/Express+SSE │ ◀────── رد البوت ──────── │  ماجد    │
     └────────┬──────────┘                         └──────────┘
              │ يكتب كل الرسائل في Chatwoot (API Channel)
              ▼
        ┌──────────┐  رد الموظف → webhook → البريدج → SSE → الويدجت (فوري)
        │ Chatwoot │  ← الموظف البشري يشوف ويرد + handoff
        └──────────┘
```

**القاعدة الذهبية:** Chatwoot = **مصدر الحقيقة الوحيد**. كل رد (بوت/موظف) يتكتب في Chatwoot ويتبعت للويدجت بـ SSE مع **منع تكرار بالـ message id**.

---

## 2) خريطة الملفات (مكان كل حاجة)

```
majed-liquid-widget/
├── integration/
│   ├── bridge/                         ← يترفع على Railway (Root Directory)
│   │   ├── index.js                    ★ بريدج الطريق ب (SSE + API channel + Botpress + handoff)
│   │   ├── public/
│   │   │   ├── majed-widget.js         ★ ويدجت «نور» (بيتقدّم على GET /majed-widget.js)
│   │   │   └── majed-avatar.png        ← أفاتار fallback (يضمن الصورة متكسرش أبدًا)
│   │   ├── .env.example                ← كل المتغيرات المطلوبة
│   │   ├── package.json / package-lock.json / railway.toml / .dockerignore
│   │   └── index.website-inbox.bak.js  ← النسخة القديمة (مرجع، مش بتشتغل)
│   │
│   ├── odoo/ai_user_context_webhook/   ← موديول Odoo (الكود المصدر)
│   │   ├── views/webchat_template.xml  ★ يحقن <script src="{bridge}/majed-widget.js"> + config
│   │   ├── controllers/main.py         ← endpoint GET /ai_webhook/user_context
│   │   ├── utils/data_builder.py       ← يبني بيانات المتدرب (كورسات/تقدم)
│   │   ├── data/ir_config_parameter.xml← System Parameters الافتراضية
│   │   └── static/src/img/majed-avatar.png
│   │
│   ├── ai_user_context_webhook_MAJED_AVATAR.zip  ★★ ده اللي يترفع/يتركّب في Odoo
│   ├── PATH_B_DEPLOY.md                ← دليل نشر مفصّل
│   ├── BOTPRESS_CHAT_UI.md             ← payloads + Execute Code لـ Botpress
│   └── CHATWOOT_SETUP.md / INTEGRATION_REVIEW.md
│
├── chat-noor.html                      ← موكاب «نور» النهائي (Light/Dark) — للعرض
├── chat-concepts.html / chat-ui-pro.html / chat-inbox-preview.html  ← موكابات بديلة
└── HANDOVER_PATH_B.md                  ← (الملف ده)
```

★ = ملف جوهري · ★★ = اللي يترفع في Odoo

---

## 3) الحالة: خلص ✅ / فاضل ⏳

**خلص واتأكد منه ✅**
- البريدج (الطريق ب): جلسة/رسالة/SSE + إنشاء contact+conversation في Chatwoot + forward لـ Botpress + handoff/assign/status. متجرّب محليًا (health بيرجّع inbox 29، `/majed-widget.js` بيرجّع 200).
- ويدجت «نور»: زرار عائم + نافذة Light/Dark + شريط تواصل + SSE + fallback للأفاتار (مايكسرش أبدًا).
- موديول Odoo (Path B): يحقن الويدجت + يبعت بيانات المتدرب. الـ zip متغلّف بـ forward slashes (متوافق Linux).
- كل الكود مرفوع على `main` في github.com/EyadSofian/majed.

**فاضل ⏳ (نشر + ربط + اختبار)**
- ⏳ **Railway:** ضبط Root Directory + المتغيرات + redeploy. *(ده السبب الحالي إن الأيقونة مش ظاهرة — تفاصيل تحت.)*
- ⏳ **Chatwoot:** rotate التوكن + ضبط Webhook URL للـ API channel.
- ⏳ **Botpress:** ربط الـ webhook + بناء فلو الردود/الـ handoff.
- ⏳ **Odoo:** تركيب الـ zip + ضبط `ai_webhook.bridge_url`.
- ⏳ اختبار end-to-end.

---

## 4) 🚨 المشكلة الحالية وحلّها (Railway بيشغّل كود قديم)

**التشخيص المؤكَّد:** Railway حاليًا بيشغّل `server.js` القديم في **جذر** الريبو (اللي بيخدم `index.html` قديمة)، **مش** `integration/bridge/index.js`. النتيجة:
- `GET /` يرجّع HTML قديمة بدل JSON health.
- `GET /majed-widget.js` → **404** → الموديول مش لاقي الويدجت → **الأيقونة مش بتظهر**.

**الحل (خطوتين في Railway):**
1. Service `majed-production-dd41` → **Settings**:
   - **Source/Repo** = `EyadSofian/majed` (مش الريبو القديم).
   - **Root Directory** = `integration/bridge`  ← أهم خطوة.
2. ضيف **Variables** (القسم 5) → **Redeploy**.

**التحقق بعد الـ deploy (لازم يعدّي):**
- `GET https://<bridge>/` → `{"status":"running","mode":"path-b-api-channel","inboxId":"29"}`
- `GET https://<bridge>/majed-widget.js` → **200** (مش 404)

---

## 5) المتغيرات (Variables)

### أ) البريدج — Railway Environment Variables
| المتغير | القيمة | إلزامي |
|---------|--------|--------|
| `CHATWOOT_BASE_URL` | `https://chat.engosoft.com` | ✅ |
| `CHATWOOT_ACCOUNT_ID` | `2` | ✅ |
| `CHATWOOT_INBOX_ID` | `29` | ✅ (أو `CHATWOOT_INBOX_IDENTIFIER`) |
| `CHATWOOT_API_TOKEN` | `<التوكن بعد الـ rotate>` | ✅ |
| `BOTPRESS_WEBHOOK_URL` | `<من Botpress: Messaging webhook>` | ✅ |
| `WIDGET_ORIGIN` | `https://demo.engosoft.com` | ✅ (CORS) |
| `BOTPRESS_PAT` | (اختياري) | — |
| `WELCOME_ENABLED` | `true` | افتراضي |
| `WELCOME_CARD_ENABLED` | `false` | افتراضي (الويدجت بيعرض شريط التواصل بنفسه) |
| `WELCOME_TEXT` | نص الترحيب | افتراضي موجود |
| `WA_NUMBER` | `966920016295` | افتراضي |
| `SUPPORT_EMAIL` | `aibot@engosoft.com` | افتراضي |

### ب) Odoo — System Parameters (Settings → Technical → Parameters)
| المفتاح | القيمة |
|---------|--------|
| `ai_webhook.bridge_url` | `https://majed-production-dd41.up.railway.app` *(بدون / في الآخر)* — **إلزامي** |
| `ai_webhook.majed_avatar_url` | `/ai_user_context_webhook/static/src/img/majed-avatar.png` |
| `ai_webhook.majed_greeting` | `أهلاً، أنا ماجد` |
| `ai_webhook.wa_number` | `966920016295` |
| `ai_webhook.support_email` | `aibot@engosoft.com` |
| `ai_webhook.theme` | `light` (أو `dark`) |

> لو `ai_webhook.bridge_url` فاضي → الموديول **مش بيحقن أي حاجة** (ولا الزرار). لازم يتظبط.

---

## 6) endpoints البريدج (مرجع)
| Method · Path | الوظيفة |
|---|---|
| `GET /` | health |
| `GET /majed-widget.js` · `GET /majed-avatar.png` | ملفات الويدجت (static) |
| `POST /widget/session` | إنشاء contact+conversation → `{conversationId}` |
| `GET /widget/stream?conversationId=` | SSE (ردود فورية) |
| `POST /widget/message` | `{conversationId, text, userData}` |
| `POST /widget/upload` | **مرفقات العميل** (multipart: `file` + `conversationId` + `caption` + `userData`) → Chatwoot attachment + Botpress media payload |
| `GET /widget/messages?conversationId=` | transcript المحادثة (استرجاع عند إعادة الفتح/الهيستوري) |
| `GET /widget/conversations?ids=1,2` | ملخصات المحادثات لقائمة الهيستوري (آخر رسالة + وقت + حالة) |
| `POST /botpress/webhook` | رد Botpress (نص/cards/handoff) · `GET` للتحقق |
| `POST /chatwoot/webhook` | **Webhook URL** للـ API channel (ردود الموظف → SSE) |

### مزايا الويدجت (تحديث يونيو 2026) ✨
- **رسالة لفت انتباه متغيّرة (Teaser):** بتظهر فوق الزرار العائم بعد ~3.5 ثانية وبتتبدل كل ~9 ثواني بين:
  1. تعريف ماجد («أهلاً! أنا ماجد، مستشارك التعليمي») —
  2. **عرض الكورس المجاني**: The Freelance Masterclass + زرار يفتح
     `https://engosoft.com/shop/the-freelance-masterclass-2056` + كود `free100` (بينتسخ بالضغط).
  قابلة للإغلاق (X = مش هتظهر تاني في نفس الجلسة). تخصيص عبر `MajedConfig.teasers / courseUrl / promoCode / teaserDelay / teaserRotate`.
- **إرفاق ملفات:** زرار 📎 جوه خانة الكتابة (صور/PDF/Office/صوت/فيديو/zip — حد 10MB، `MAX_UPLOAD_MB`).
  الملف بيتكتب في Chatwoot كمرفق حقيقي، وبيوصل Botpress كـ payload حقيقي (`image/audio/video/file` بالرابط) —
  الصور جاهزة للـ vision. مرفقات الموظف من Chatwoot بتظهر برضه في الويدجت.
- **هيستوري المحادثات:** زرار 🕘 في الهيدر يفتح قائمة المحادثات السابقة (آخر رسالة + الوقت + الحالة)،
  فتح أي محادثة بيرجّع الـ transcript كامل، وزرار «محادثة جديدة» يبدأ من الصفر.
  الفتح في محادثة `resolved` بيرجّعها `pending` تلقائي عشان البوت يرد تاني.
- **هيدر زجاجي عند بدء الكلام:** أول ما العميل يبعت رسالة، الهيدر بيتحول لشريط زجاجي مدمج (blur)
  وشريط واتساب/إيميل بيتطوى (بيظهروا كأيقونات صغيرة في الهيدر) → مساحة الشات أكبر.
- **الأفاتار:** اتبدّل بالصورة الكاملة (بالبادج «م. ماجد») بدل القصّة المقرّبة — في البريدج والموديول والـ zip.
- اعتماد جديد في البريدج: **multer** (رفع الملفات) — `npm install` بيجيبه تلقائيًا.

---

## 7) خطوات النشر بالترتيب (Checklist)
1. **Chatwoot:** اعمل rotate للتوكن. تأكد إن inbox 29 = **API Channel**. حط الـ **Webhook URL** = `https://<bridge>/chatwoot/webhook`. (الـ Inbox Identifier اختياري لأن عندنا `inbox_id=29`.)
2. **Railway:** repo=`EyadSofian/majed` · **Root Directory=`integration/bridge`** · Variables (قسم 5أ) · Redeploy · تحقق (قسم 4).
3. **Botpress:** حط رابط الرد = `https://<bridge>/botpress/webhook`. ابنِ الفلو (الردود + handoff) من [`integration/BOTPRESS_CHAT_UI.md`](integration/BOTPRESS_CHAT_UI.md). *(الترحيب نفسه بييجي من البريدج.)*
4. **Odoo:** ركّب `integration/ai_user_context_webhook_MAJED_AVATAR.zip` · اضبط `ai_webhook.bridge_url` · reload أي صفحة على `demo.engosoft.com` → الأيقونة تظهر.
5. **اختبار end-to-end:** افتح الويدجت → الترحيب يظهر → ابعت رسالة → توصل Botpress وترجع فوري → جرّب handoff → الموظف يستلم في Chatwoot ورده يوصل الويدجت فوري.

---

## 8) رسالة جاهزة لمسؤول Odoo
> السلام عليكم. ده موديول Odoo 17 لمساعد «ماجد» (ويدجت شات على الموقع).
> 1) ركّب الموديول من الملف المرفق `ai_user_context_webhook_MAJED_AVATAR.zip` (Apps → رفع/تركيب).
> 2) روح Settings → Technical → Parameters → System Parameters واضبط:
>    - `ai_webhook.bridge_url` = `https://majed-production-dd41.up.railway.app` (بدون / في الآخر)
>    - الباقي (avatar/greeting/wa/email/theme) ليهم قيم افتراضية، عدّلها لو حابب.
> 3) اعمل reload لأي صفحة على الموقع → هتلاقي زرار «ماجد» ظاهر.
> ملاحظة: لو الزرار مش ظاهر، اتأكد إن `ai_webhook.bridge_url` متظبط وإن رابط `<bridge>/majed-widget.js` بيفتح ويرجّع كود (مش 404).

---

## 9) Prompt كامل لأي موديل/مطوّر تاني يكمّل
> **السياق:** مساعد «ماجد» التعليمي لـ Engosoft — **Path B**: ويدجت ويب مخصّص («نور») على موقع Odoo 17، متوصّل بـ بريدج Node/Express على Railway، اللي بيربط: الموقع ↔ Chatwoot self-hosted (`chat.engosoft.com`, account_id=2, **API Channel** inbox_id=29) ↔ Botpress Cloud (مخ البوت). الردود فورية عبر **SSE**. الريبو: github.com/EyadSofian/majed.
>
> **مسار البيانات:** الويدجت يعمل `POST {bridge}/widget/session` (ينشئ contact+conversation في Chatwoot) → يفتح `GET {bridge}/widget/stream` (SSE) → يبعت رسائل بـ `POST {bridge}/widget/message` مع `userData` (بيانات المتدرب من Odoo `GET /ai_webhook/user_context`). البريدج يكتب رسالة العميل في Chatwoot (incoming) ويبعتها لـ Botpress. ردود Botpress تيجي على `POST {bridge}/botpress/webhook` بصيغة `{messages:[{text}|{content_type,content_attributes}], actions:[{type:"handoff",team_id}]}` → البريدج يكتبها في Chatwoot (outgoing). ردود الموظف البشري في Chatwoot تطلع عبر **Webhook URL** للـ API channel (`POST {bridge}/chatwoot/webhook`). كل رسالة outgoing تتبعت للويدجت بـ SSE مع dedup بالـ message id. Chatwoot = مصدر الحقيقة.
>
> **الحالة:** الكود كله متبني ومرفوع على main (بريدج `integration/bridge/index.js`، ويدجت `integration/bridge/public/majed-widget.js`، موديول Odoo `integration/odoo/ai_user_context_webhook/`). الفاضل = نشر فقط: ضبط Railway (Root Directory=`integration/bridge` + المتغيرات) + Chatwoot API channel webhook + Botpress flow + تركيب موديول Odoo وضبط `ai_webhook.bridge_url`.
>
> **قواعد مهمة:** صفر أخطاء (مشروع مكلف). التوكن في Railway env بس (مش في الريبو). الويدجت بيتقدّم من البريدج على `/majed-widget.js`. الرسائل التفاعلية (cards/input_select) تشتغل في website/api inbox.

---

*كل الملفات في الريبو. ابدأ من القسم 4 (إصلاح Railway) لأنه السبب الحالي لاختفاء الأيقونة.*
