# ماجد «نور» — Master Document (يونيو 2026)

> كل اللي اتبنى، والحالة الحالية، وخطوات التطوير الجاية.
> اقرأه الأول في أي محادثة جديدة قبل ما تبدأ.

---

## 1. ملخص المشروع

**ماجد** مساعد ذكاء اصطناعي تعليمي لـ **Engosoft**. بيشتغل كـ widget شات مدمج في موقع Odoo الخاص بالمتدربين.

- **القناة**: ويدجت مخصّص اسمه «نور» — مش Chatwoot Webchat ومش Botpress Webchat.
- **الذكاء**: Botpress Cloud (Autonomous Node + Gemini 2.5 Flash).
- **مصدر الحقيقة**: Chatwoot self-hosted — كل رسالة (بوت/عميل/موظف) بتتسجّل هناك.
- **الربط**: Bridge server (Node.js/Express) على Railway يربط كل الأطراف.

---

## 2. المعمارية الكاملة

```
   ويدجت «نور» (على موقع Odoo — demo.engosoft.com)
        │
        │  (1) POST /widget/session  → يرجّع conversationId
        │  (2) GET  /widget/stream   → SSE (ردود فورية للعميل)
        │  (3) POST /widget/message  → رسالة + بيانات المتدرب
        │  (4) POST /widget/upload   → مرفق (صورة/PDF/صوت)
        │  (5) GET  /widget/messages → transcript (تاريخ)
        ▼
     ┌────────────────────────────────────────────────┐
     │         البريدج (Railway)                      │
     │  integration/bridge/index.js                   │
     │  URL: majed-production-dd41.up.railway.app      │
     └────────────────┬──────────────┬────────────────┘
                      │              │
         يكتب كل      │              │  Botpress Chat API
         رسالة هنا    ▼              ▼  (SSE للردود)
              ┌──────────┐    ┌──────────────────┐
              │ Chatwoot │    │  Botpress Cloud   │
              │ self-    │    │  (ماجد bot)       │
              │ hosted   │◀───│  Gemini 2.5 Flash │
              │ /account/│    │                   │
              │ 2/inbox/ │    │  Autonomous Node  │
              │ 29 (API) │    │  = المخ           │
              └────┬─────┘    └──────────────────┘
                   │
          رد الموظف البشري
          (webhook → SSE → ويدجت)
```

**قاعدة ذهبية:** Chatwoot = مصدر الحقيقة الوحيد. لا بوت يرد ولا موظف إلا وبيتسجّل هناك.

---

## 3. خريطة الملفات

```
majed-liquid-widget/
├── MAJED_MASTER_DOC.md          ← أنت هنا
├── HANDOVER_PATH_B.md           ← توثيق نشر مفصّل (موصى بقراءته قبل الـ deploy)
├── integration/
│   ├── bridge/
│   │   ├── index.js             ★ البريدج الكامل (Chatwoot ↔ Botpress Chat API + SSE)
│   │   └── public/
│   │       ├── majed-widget.js  ★ ويدجت «نور» (الكود اللي بيتحمّل على الموقع)
│   │       └── majed-avatar.png
│   ├── odoo/ai_user_context_webhook/  ← موديول Odoo
│   │   ├── views/webchat_template.xml ★ يحقن الـ script في صفحات Odoo
│   │   └── controllers/main.py        ← GET /ai_webhook/user_context
│   ├── ai_user_context_webhook_MAJED_AVATAR.zip  ★★ اللي يترفع في Odoo
│   ├── BOTPRESS_CHAT_API_SETUP.md    ← دليل إعداد Botpress Chat API
│   ├── BOTPRESS_FLOW_BRIEF.md        ← (قديم/متجاوَز — للمرجعية فقط)
│   ├── CHATWOOT_SETUP.md             ← دليل ضبط Chatwoot
│   └── PATH_B_DEPLOY.md              ← Checklist النشر
└── chat-noor.html               ← موكاب «نور» النهائي (عرض فقط)
```

★ = الملفات الجوهرية | ★★ = ما يُرفع على Odoo

---

## 4. المتغيرات الجوهرية

| المتغير | القيمة | مكانه |
|---------|--------|-------|
| `CHATWOOT_BASE_URL` | `https://chat.engosoft.com` | Railway |
| `CHATWOOT_ACCOUNT_ID` | `2` | Railway |
| `CHATWOOT_API_TOKEN` | (بعد الـ rotate) | Railway |
| `CHATWOOT_INBOX_ID` | `29` (API Channel) | Railway |
| `BOTPRESS_CHAT_WEBHOOK_ID` | `<id>` من Chat integration | Railway |
| `WIDGET_ORIGIN` | `https://demo.engosoft.com` | Railway |
| `ai_webhook.bridge_url` | `https://majed-production-dd41.up.railway.app` | Odoo System Parameters |

---

## 5. الحالة الحالية (يونيو 2026)

### خلص وتم التأكيد منه ✅
- بريدج كامل: session/message/SSE + Chatwoot API channel + Botpress Chat API + handoff.
- ويدجت «نور»: زرار عائم، Light/Dark، teaser دوّار، مرفقات (📎)، تاريخ محادثات (🕘)، هيدر زجاجي.
- موديول Odoo: حقن الويدجت + بيانات المتدرب من `/ai_webhook/user_context`.
- Handoff آلي بـ 3 طرق: `[[HANDOFF:N]]` في نص الرد، custom event، أو legacy POST.
- De-dup كامل (message id + SSE reconnect + echo).
- Mapping (cwConv ↔ bpUser/bpConv) محفوظ في `custom_attributes` Chatwoot (يعيش بعد restart).

### فاضل ⏳ (نشر + ربط + بناء فلو Botpress)
- Railway: ضبط Root Directory = `integration/bridge` + المتغيرات + Redeploy.
- Botpress: تركيب Chat integration + بناء الـ Autonomous Node (كود في BOTPRESS_CHAT_API_SETUP.md).
- Odoo: رفع الـ zip + ضبط `ai_webhook.bridge_url`.
- اختبار end-to-end.

### تطوير جديد مطلوب 🆕 (قسم 7 و 8)
- فلو الشكاوى (تحويل لـ Operations بدل صورة).
- فلو المبيعات (تحويل لـ CS بعد عدم الرد على تفاصيل الكورس).

---

## 6. Chatwoot API (self-hosted) — المرجع السريع

**Base URL:** `https://chat.engosoft.com/api/v1/accounts/2`

**Header دايمًا:** `api_access_token: <CHATWOOT_API_TOKEN>`

### أهم الـ endpoints

```typescript
// ── جلب تفاصيل المحادثة (يشمل contact_id)
GET /conversations/{conv_id}
// Response.meta.sender.id       ← Chatwoot contact_id
// Response.meta.sender.name     ← اسم العميل
// Response.status               ← pending / open / resolved
// Response.custom_attributes    ← bp_user_id / bp_conv_id (الـ mapping)

// ── إرسال Private Note (ملخص للموظف)
POST /conversations/{conv_id}/messages
Body: { "content": "...", "private": true, "message_type": "outgoing" }

// ── فتح المحادثة لموظف بشري
POST /conversations/{conv_id}/toggle_status
Body: { "status": "open" }

// ── تحويل لتيم معيّن
POST /conversations/{conv_id}/assignments
Body: { "team_id": 2 }   // 2 = Moderation Team

// ── تحويل لموظف معيّن
POST /conversations/{conv_id}/assignments
Body: { "assignee_id": 5 }

// ── جلب جهة الاتصال (بالـ contact_id)
GET /contacts/{contact_id}

// ── إرسال رسالة عادية للعميل من الموظف
POST /conversations/{conv_id}/messages
Body: { "content": "...", "message_type": "outgoing" }
```

### تيمات Chatwoot المعرّفة
| ID | الاسم | الاستخدام |
|----|-------|-----------|
| 2  | Moderation Team | شكاوى + تحويل العميل للمتابعة البشرية |

> لإيجاد باقي التيمات: `GET /teams` ← يرجّع كل التيمات مع ID.

---

## 7. كيفية الوصول لـ cwConvId داخل Botpress Execute Code

**الوضع الحالي:** البريدج بيحفظ الـ mapping في `custom_attributes` بتاعة محادثة Chatwoot:
- `bp_user_id` ← Botpress User ID
- `bp_user_key` ← Botpress User Key (للتشغيل)
- `bp_conv_id` ← Botpress Conversation ID

لكن **`cwConvId` مش بيتبعت صراحةً لـ Botpress**، فمن داخل Execute Code محتاج تعمل:

### الطريقة 1 — من الـ user profile (بعد التعديل المقترح في قسم 10)

```typescript
// الـ profile بيتحفظ في user.tags['chat:profile']
const profileStr = (user as any).tags?.['chat:profile'] || '{}';
let profile: any = {};
try { profile = JSON.parse(profileStr); } catch (_) {}

const cwConvId = profile._cw || '';  // بعد تعديل البريدج
```

### الطريقة 2 — قراءة الـ metadata من Chatwoot (بدون تعديل البريدج)

```typescript
// Botpress conversation.id هو bp_conv_id المحفوظ في Chatwoot
// نجيب الـ cwConvId بناءً على search في Chatwoot (أبطأ)
// ⚠ هذه الطريقة تتطلب إضافة CHATWOOT_API_TOKEN للبوت كـ environment variable

// الأفضل: استخدم الطريقة 1 بعد تعديل البريدج (قسم 10)
```

### الطريقة 3 — حقن cwConvId في نص السياق (في الـ context injection)

البريدج بيبعت للبوت رسالة سياق في أول المحادثة.
بعد التعديل (قسم 10)، هيضيف سطر:
```
معلومات التنسيق (لا تعرضها): _cw=55520
```

ومن الـ Autonomous Node، إذا احتجت تقرأها في Execute Code:
```typescript
// مش مضمون — اللي مضمون هو الطريقة 1
```

### ✅ الموصى به: الطريقة 1 (بعد تعديل البريدج في قسم 10)

---

## 8. فلو الشكاوى الجديد (بدل صورة الشكوى)

### اللي كان قبل ❌
الـ Autonomous Node كان بيعمل transition لـ node فيه صورة/فورم شكوى.

### اللي هيبقى عليه ✅

**في الـ Autonomous Node Instructions:**

```
COMPLAINT_FLOW:
Triggers: أي شكوى، مشكلة تقنية، شهادة، استرداد، تسجيل دخول، محاضرة، مدرّس.

CRITICAL RULES:
- لا تعمل transition لأي صورة أو فورم.
- لما تكتشف شكوى، ابعت الرد التالي بالضبط:
  "شكرًا لتواصلك. تم تسجيل مشكلتك، وستتواصل معك خدمة العملاء في أقرب وقت 🙏"
- بعدين على طول أضف في ردك:
  [[HANDOFF:2]] ملخص: <ملخص الشكوى في جملة واحدة>
- لا تبعت أي رسالة تانية بعد ده.
```

**سلوك البريدج عند استلام `[[HANDOFF:2]]`:**
1. يشيل الماركر من الرد (مش يظهر للعميل).
2. `cwAssign(convId, { team_id: 2 })` — يحوّل لـ Moderation Team.
3. `cwSetStatus(convId, 'open')` — يفتح المحادثة للموظف.
4. البوت يوقف الرد تلقائيًا (لأن status = open).

**للملاحظات الخاصة (Private Note) — اختياري:**

في نود Execute Code بعد الـ Autonomous Node يمكن تضيف:

```typescript
const w = workflow as any;
const profileStr = (user as any).tags?.['chat:profile'] || '{}';
let profile: any = {};
try { profile = JSON.parse(profileStr); } catch (_) {}

const cwConvId = profile._cw || '';
if (!cwConvId) return;

const API_TOKEN = process.env.CHATWOOT_API_TOKEN; // env var في Botpress
const BASE = 'https://chat.engosoft.com/api/v1/accounts/2';

const summaryText = (w.complaintText || 'العميل أبلغ عن مشكلة').trim();

await axios.post(`${BASE}/conversations/${cwConvId}/messages`, {
  content: `📝 **ملخص البوت:**\n${summaryText}`,
  private: true,
  message_type: 'outgoing'
}, {
  headers: { api_access_token: API_TOKEN, 'Content-Type': 'application/json' },
  timeout: 10000
});
```

> ⚠️ لإضافة `CHATWOOT_API_TOKEN` كـ environment variable في Botpress: Studio → Settings → Environment Variables.

---

## 9. فلو المبيعات / تفاصيل الكورس (بعد عدم الرد)

### المنطق

```
العميل يسأل عن شراء/تفاصيل كورس
    ↓
ماجد يرد بالتفاصيل (محتويات + إنجازات + سعر)
    ↓
يُفعّل clock.setReminder بعد 30 دقيقة (صامت)
    ↓
┌── العميل رد ──────────────────────────────────────────┐
│  workflow.respondedAfterPitch = true                  │
│  استمر بشكل طبيعي                                    │
└───────────────────────────────────────────────────────┘
    ↓ (بعد 30 دقيقة لو ما ردّش)
الـ Reminder يفعّل المحادثة من جديد
    ↓
الـ Autonomous Node يشوف إن respondedAfterPitch = false
    ↓
يبعت: "هل تريد إتمام التسجيل؟ يمكنني توصيلك بمستشار"
    + [[HANDOFF:2]] مع ملخص المحادثة
```

### في الـ Autonomous Node Instructions

```
SALES_FOLLOW_UP:
Condition: لما تحس إن العميل اهتم بتفاصيل كورس أو سأل عن السعر/التسجيل.

After replying with course details:
1. Set workflow.salesPitchSent = true
2. Set workflow.salesPitchCourse = <اسم الكورس>
3. Call the clock.setReminder tool silently — delay: 30 minutes, label: "sales_followup"
4. Do NOT mention the reminder to the user.

When clock.setReminder fires (user will see a new message):
- Check: if workflow.respondedAfterPitch is true → do nothing (user already engaged).
- If workflow.respondedAfterPitch is false (no response since pitch):
  Send: "مرحبًا! لاحظت إنك بتسأل عن {{workflow.salesPitchCourse}} 😊 هل تريد التحدث مع مستشار لمساعدتك في التسجيل؟"
  Then: [[HANDOFF:2]] ملخص: العميل أبدى اهتمامًا بكورس {{workflow.salesPitchCourse}} ولم يكمل

When user responds after sales pitch:
- Set workflow.respondedAfterPitch = true
```

> 📌 ملاحظة: `clock.setReminder` في Botpress هو reminder داخلي — بيطلّع رسالة في نفس المحادثة بعد المدة المحددة. **مش** تقويم جوجل. يشتغل بالصح مع Botpress Chat API (المسار الحالي لماجد).

---

## 9.5. تيزر صفحة الكورس (بوب-أب الشراء فوق زرار الشات) 🆕

**الفكرة:** لما العميل يكون على صفحة كورس/متجر (`engosoft.com/shop/...`)، يطلع له البوب-أب اللي فوق زرار الشات (الـ teaser — مش جوه الشات) بعرض «محتاج مساعدة في الشراء؟ / في عرض؟» مع كود الخصم وزرار يكلّم البوت.

**التنفيذ (في `majed-widget.js`):** كله مبني فوق محرّك الـ teaser الموجود + خاصيتين جديدتين في كل teaser:

| الخاصية | النوع | الوظيفة |
|---------|-------|---------|
| `showOn` | `string` أو `string[]` | يظهر التيزر فقط لو الـ URL (host+path+query) فيه أحد الأنماط (substring). بدونها → يظهر في كل الصفحات. مثال: `showOn:'/shop'` |
| `showOnSelector` | `string` (CSS) | بديل/إضافة لـ `showOn` — يظهر التيزر لو العنصر ده موجود في الصفحة (مفيد لو روابط الكورسات مش ثابتة الشكل). مثال: `.oe_website_sale` |
| `botMessage` | `string` | زرار يفتح الشات ويبعت الرسالة دي للبوت (يشغّل فلو المبيعات في قسم 9). |
| `botMessageLabel` | `string` | نص الزرار (افتراضي «كلّمني 💬»). |
| `{{course}}` | placeholder | جوّا `html` أو `botMessage` — يتحوّل تلقائيًا لاسم الكورس المقروء من الصفحة الحالية (Odoo product page). فالبوت يعرف العميل بيسأل عن أي كورس بالظبط. التخصيص عبر `courseNameSelector`. |
| `code` / `codeLabel` | `string` | كود الخصم/العرض (موجود من قبل — زرار نسخ). |

**🧠 منطق الأولوية (مهم):** لو في تيزر **مستهدَف** (عنده `showOn`/`showOnSelector`) ومطابق للصفحة الحالية، بيظهر **لوحده** وبتختفي التيزرات العامة (زي الترحيب). يعني على صفحة الكورس بتشوف تيزر الشراء بس — مش بيتبدّل مع الترحيب.

**التيزر الافتراضي للمتجر** (مدمج في الويدجت، يظهر تلقائيًا على `/shop` و `/course`):
```js
{
  showOn: ['/shop', '/course'],
  html: '🛒 محتاج مساعدة في شراء «{{course}}»؟<br/>أو عايز تعرف لو في عرض حاليًا؟',
  botMessage: 'محتاج مساعدة في شراء كورس «{{course}}»، وممكن تقوللي لو في عرض؟',
  botMessageLabel: '💬 ساعدني في الشراء',
  code: PROMO_CODE, codeLabel: 'كود الخصم'
}
```

**التحكم من Railway env vars (الأسهل — موصى به):** البريدج بيحقن `window.MajedServerConfig` في أول الملف المقدَّم من `/majed-widget.js`. الأولوية: `MajedConfig` (صفحة Odoo) > `MajedServerConfig` (Railway) > الافتراضي المدمج. غيّر القيمة → **Redeploy** على Railway → خلاص.

| Env var | الوظيفة |
|---------|---------|
| `MAJED_PROMO_CODE` | كود الخصم المعروض على البوب-أب |
| `MAJED_COURSE_TEASER_HTML` | نص التيزر (يدعم `{{course}}` و`<br/>`) |
| `MAJED_COURSE_TEASER_MSG` | الرسالة اللي تتبعت للبوت عند الضغط (يدعم `{{course}}`) |
| `MAJED_COURSE_TEASER_LABEL` | نص زرار «ساعدني في الشراء» |
| `MAJED_COURSE_CODE_LABEL` / `MAJED_COURSE_CODE` | عنوان/قيمة كود التيزر |
| `MAJED_COURSE_SHOWON` | الصفحات اللي يظهر فيها (substrings مفصولة بفاصلة)، مثال: `/shop,/course` |
| `MAJED_COURSE_SHOWON_SELECTOR` | CSS selector بديل للاستهداف |
| `MAJED_TEASERS_JSON` | (متقدّم) JSON array يتحكم في **كل** التيزرات ويتجاوز اللي فوق |

**أو من Odoo (بديل):** System Parameter اسمه `ai_webhook.teasers_json` يقبل نفس الـ JSON array (يتطلب upgrade للموديول).

> ⚠️ شرط: لازم الويدجت يكون محمّل على نفس دومين صفحة الكورس (`engosoft.com`). متحقق حاليًا — الموديول متركّب على الموقع و`bridge_url` مظبوط.

---

## 10. تعديل البريدج لتمرير cwConvId لـ Botpress

**الملف:** `integration/bridge/index.js`

**المشكلة:** حاليًا `compactProfile(userData)` بيحفظ بيانات الكورسات فقط في `user.tags['chat:profile']` ولا يشمل `cwConvId`.

**الحل:** تعديل `compactProfile` أو `bpCreateUser` لإضافة `_cw` للـ profile.

**التعديل المطلوب في `bpCreateUser`:**

```javascript
// قبل (السطر ~631 في index.js)
async function bpCreateUser({ name, userData }) {
  let profile = '';
  try {
    profile = compactProfile(userData);
  } catch (_) {}
  ...
}

// بعد
async function bpCreateUser({ name, userData, cwConvId }) {
  let profile = '';
  try {
    const compact = JSON.parse(compactProfile(userData) || '{}');
    if (cwConvId) compact._cw = String(cwConvId);
    profile = JSON.stringify(compact).slice(0, 490);
  } catch (_) {
    if (cwConvId) profile = JSON.stringify({ _cw: String(cwConvId) });
  }
  ...
}
```

**وفي `ensureBotpress` (السطر ~927) تمرير `cwConvId`:**

```javascript
// قبل
const { userId, userKey } = await bpCreateUser({ name, userData });

// بعد
const { userId, userKey } = await bpCreateUser({ name, userData, cwConvId });
```

**بعد التعديل، في Botpress Execute Code:**

```typescript
const profileStr = (user as any).tags?.['chat:profile'] || '{}';
let profile: any = {};
try { profile = JSON.parse(profileStr); } catch (_) {}

const cwConvId = profile._cw || '';
// الآن cwConvId جاهز لأي Chatwoot API call
```

---

## 11. Checklist التطوير الجديد (بالترتيب)

- [ ] **1. تعديل البريدج** (قسم 10): تمرير `cwConvId` في `bpCreateUser` + `ensureBotpress`.
- [ ] **2. push وredeploy** على Railway.
- [ ] **3. في Botpress Studio:**
  - إضافة `CHATWOOT_API_TOKEN` كـ env var.
  - تحديث Autonomous Node Instructions (قسم 8 للشكاوى + قسم 9 للمبيعات).
  - إزالة أي transitions تودي لصورة شكوى.
- [ ] **4. اختبار handoff الشكاوى:** ابعت شكوى → تأكد إن المحادثة اتحولت لـ open + تيم 2.
- [ ] **5. اختبار فلو المبيعات:** اسأل عن كورس → انتظر 30 دقيقة → تأكد وصول رسالة follow-up.

---

## 12. أمور مهمة لا تنساها

| الموضوع | التفاصيل |
|---------|----------|
| `CHATWOOT_API_TOKEN` | لازم يتعمله **Rotate** (اتسرّب في الشات). روح Profile → Access Token → Regenerate. |
| الـ Webchat Config URL | بيتغيّر مع كل Publish في Botpress — حدّث الـ embed في Odoo. |
| `Allow Conversation = ON` | لازم يكون مفعّل على كل Autonomous Node وإلا البوت صامت. |
| `[[HANDOFF]]` ماركر | البريدج بيشيله من الرد قبل ما يوصل للعميل — العميل مش بيشوفه. |
| `clock.setReminder` | ده Botpress-internal فقط — مش Google Calendar. |
| Team ID 2 | هو الـ Moderation Team في Chatwoot. تأكد من `/api/v1/accounts/2/teams`. |
| Session size | 131KB max في Botpress — متخزّنش JSONs كاملة في workflow variables. |

---

## 13. الـ Repo والروابط

| الـ resource | الرابط |
|---|---|
| GitHub | `github.com/EyadSofian/majed` (branch: main) |
| Railway (بريدج) | `https://majed-production-dd41.up.railway.app` |
| Chatwoot | `https://chat.engosoft.com/app/accounts/2` |
| Moderation Team | `https://chat.engosoft.com/app/accounts/2/settings/teams/2/edit` |
| Botpress Studio | `https://app.botpress.cloud` |
| Odoo موقع المتدربين | `https://demo.engosoft.com` |

---

*آخر تحديث: يونيو 2026 — بناءً على Bridge Path B (Chat API) + التطوير الجديد (Complaint/Sales flows).*
