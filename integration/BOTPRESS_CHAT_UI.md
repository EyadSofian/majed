# ماجد — واجهة الشات التفاعلية (Botpress → Bridge → Chatwoot)

> الأزرار اللي «جوه الشات» مش HTML بتتبني — دي **رسائل تفاعلية** يبعتها Botpress،
> والبريدج يمرّرها لـ Chatwoot، وChatwoot يرسمها بستايله في **شاشة العميل** و**انبوكس الموظف** مع بعض.
> معاينة الشكل النهائي: افتح [`chat-inbox-preview.html`](../chat-inbox-preview.html).

---

## 0) الحقيقة المعمارية (مهم تفهمها قبل أي شغل)

نافذة شات Chatwoot **جوّه iframe** من `chat.engosoft.com` → **مينفعش تتستايل بـ CSS من برّه**.
اللي بتتحكم فيه فعلاً اتنين بس:

| الحاجة | بتتظبط منين |
|--------|--------------|
| شكل النافذة (لون/اسم/أفاتار/خلفية/«powered by») | **داشبورد Chatwoot** — القسم (1) تحت |
| الأزرار/الكروت **جوه** الشات | **payload** يبعته Botpress — القسم (2) و(3) |

الزرار الأصفر/الأزرق اللي العميل يدوسه = أصلي من Chatwoot، اكلكيبل، وبيظهر للموظف تلقائيًا. مفيش كود واجهة.

---

## 1) ثيم Chatwoot (Dashboard → Inbox Settings → Configuration / Widget)

| الإعداد | القيمة |
|---------|--------|
| Website Name | `ماجد` |
| Widget Color | `#7c5cff` (بنفسجي «نور») |
| Welcome Heading | `أهلاً، أنا ماجد` |
| Welcome Tagline | `مستشارك التعليمي في Engosoft — اسألني عن دوراتك وتقدّمك` |
| Reply Time | `In a few minutes` |
| Avatar | ارفع `assets/majed-avatar.png` كـ **Channel Avatar** |
| Theme | `Light` (الافتراضي — مظبوط في الموديول `darkMode:"light"`) |
| Business Hours | حسب الدوام (اختياري) |
| Branding ("powered by Chatwoot") | شيله من **Super Admin Console → Settings** |

> **مهم:** لون الويدجت `#7c5cff` لازم يساوي هوية «نور» (شوف [`chat-noor.html`](../chat-noor.html))
> عشان النافذة وزرار ماجد العائم في الموديول يطلعوا بنفس الإحساس.
>
> **الربط = Agent Bot (مش Webhooks):** اعمل **Agent Bot** (Settings → Integrations → Bots) بـ
> `outgoing_url = https://<bridge>/chatwoot/webhook`، وبعدين Inbox «Majed» → **Bot Configuration** → اختاره.
> الـ Agent Bot بيبعت تلقائيًا **`conversation_created`** (للترحيب) و **`message_created`** (لرسائل العميل)
> لنفس الرابط — من غير ما تعمل Webhook منفصل. (الرسائل التفاعلية cards/input_select تشتغل في **website inbox** بس.)

---

## 2) الـ Payloads الجاهزة (عقد البريدج)

البريدج ([`bridge/index.js`](bridge/index.js)) يستقبل من Botpress الشكل ده ويمرّر `content_type` +
`content_attributes` لـ Chatwoot زي ما هو. أي تشكيلة من `messages` + `actions` مقبولة.

> ⚡ **جديد — الترحيب التلقائي (نور):** البريدج بقى يبعت **نص الترحيب + كارت التواصل**
> (واتساب/إيميل/فويس) **لحظة ما العميل يفتح الشات** (`conversation_created`) — من غير ما يستنى أول رسالة.
> النص والأرقام تتظبط من الـ env (`WELCOME_TEXT` / `WA_NUMBER` / `SUPPORT_EMAIL`).
> **عشان كده Botpress ماينفعش يبعت ترحيب تاني** — يبدأ يرد على طول من أول رسالة للعميل.
> (لو عايز Botpress هو اللي يرحّب، حُط `WELCOME_ENABLED=false`).

### أ) رسالة الترحيب + أزرار اختيار (input_select)
الزر يبعت `value` للبوت كـ **postback** (رسالة جديدة) → يرجع للبريدج → Botpress.

```jsonc
{
  "conversationId": "chatwoot-conv-42",   // البريدج بيستخرج الرقم منها
  "messages": [
    { "text": "أهلاً 👋 أنا ماجد، مساعدك التعليمي في Engosoft. اختار من تحت أو اكتب سؤالك على طول." },
    {
      "content": "تحب أساعدك في إيه؟",
      "content_type": "input_select",
      "content_attributes": {
        "items": [
          { "title": "📚 تقدّمي في الكورسات", "value": "my_progress" },
          { "title": "▶️ الدرس الجاي",        "value": "next_lesson" },
          { "title": "🧑‍💼 أكلّم موظف",        "value": "human_agent" }
        ]
      }
    }
  ]
}
```

### ب) كارت روابط التواصل (cards)
أكشن `link` = يفتح URL (واتساب/إيميل) • أكشن `postback` = يبعت `payload` للبوت.

```jsonc
{
  "conversationId": "chatwoot-conv-42",
  "messages": [
    {
      "content": "طرق التواصل المباشر:",
      "content_type": "cards",
      "content_attributes": {
        "items": [
          {
            "title": "تواصل مع Engosoft",
            "description": "اختار الوسيلة اللي تناسبك",
            "actions": [
              { "type": "link",     "text": "💬 واتساب", "uri": "https://wa.me/966920016295" },
              { "type": "link",     "text": "✉️ إيميل",  "uri": "mailto:aibot@engosoft.com" },
              { "type": "postback", "text": "🎙️ ماجد فويس (قريبًا)", "payload": "voice_soon" }
            ]
          }
        ]
      }
    }
  ]
}
```

### ج) التحويل لموظف بشري (handoff)
رسالة طمأنة + أكشن يحوّل الحالة لـ `open` ويـ assign للتيم.

```jsonc
{
  "conversationId": "chatwoot-conv-42",
  "messages": [{ "text": "تمام 🙌 بوصّلك بزميل من فريقنا حالًا، ثانية واحدة." }],
  "actions": [{ "type": "handoff", "team_id": 3 }]   // 3 = مبيعات، 4 = شكاوى... (انت تحدد في Botpress)
}
```

> **قاعدة الـ teams** (تتحدد في Botpress): «ريسيل/اشتراك» → team مبيعات • «شكوى/مشكلة» → team شكاوى • طلب عام → team دعم.

---

## 3) Botpress — الـ Execute Code Cards (انسخ/الصق)

> كل كارت يبدأ بالـ casts، وكل نداء خارجي في try/catch (من مرجع `07-execute-code`).
> غيّر `BRIDGE` لرابط الـ Railway بتاعك. **محتاج خطة Botpress مدفوعة** عشان `axios` الخارجي يشتغل.

### كارت 1 — التقاط conversation id (أول نود بعد الـ Trigger)
البريدج بيبعت `conversationId: "chatwoot-conv-N"` جوه الـ Trigger payload — نخزّنها في **conversation scope** (بتفضل ثابتة طول المحادثة).

```typescript
const c = conversation as any;
const payload = (event as any).payload?.body || (event as any).payload || {};

// الشكل الأساسي من البريدج: "chatwoot-conv-42"
if (payload.conversationId) {
  c.chatwootConvId = payload.conversationId;
} else if (payload.metadata?.chatwootConvId) {
  c.chatwootConvId = `chatwoot-conv-${payload.metadata.chatwootConvId}`;
}

// بيانات المتدرب اللي Odoo حقنها (لو موجودة) — عشان ماجد «يشوف» الكورسات/التقدم
c.trainee = payload.userData || payload.metadata || {};
console.log('Chatwoot conv:', c.chatwootConvId);
```

### كارت 2 — `sendWelcomeCard` (أول رسالة: ترحيب + أزرار + كارت روابط)
> سمّي الكارت باسم فعل واضح عشان الـ Autonomous Node يختاره صح (`sendWelcomeCard` مش `Execute Code`).

```typescript
const c = conversation as any;
const BRIDGE = 'https://YOUR-BRIDGE.up.railway.app/botpress/webhook';

const body = {
  conversationId: c.chatwootConvId,
  messages: [
    { text: 'أهلاً 👋 أنا ماجد، مساعدك التعليمي في Engosoft. اختار من تحت أو اكتب سؤالك على طول.' },
    {
      content: 'تحب أساعدك في إيه؟',
      content_type: 'input_select',
      content_attributes: {
        items: [
          { title: '📚 تقدّمي في الكورسات', value: 'my_progress' },
          { title: '▶️ الدرس الجاي',        value: 'next_lesson' },
          { title: '🧑‍💼 أكلّم موظف',        value: 'human_agent' },
        ],
      },
    },
    {
      content: 'طرق التواصل المباشر:',
      content_type: 'cards',
      content_attributes: {
        items: [{
          title: 'تواصل مع Engosoft',
          description: 'اختار الوسيلة اللي تناسبك',
          actions: [
            { type: 'link',     text: '💬 واتساب', uri: 'https://wa.me/966920016295' },
            { type: 'link',     text: '✉️ إيميل',  uri: 'mailto:aibot@engosoft.com' },
            { type: 'postback', text: '🎙️ ماجد فويس (قريبًا)', payload: 'voice_soon' },
          ],
        }],
      },
    },
  ],
};

try {
  await axios.post(BRIDGE, body, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
} catch (err: any) {
  console.log('Bridge welcome error:', err.message);
}
```

### كارت 3 — `handoffToHuman` (التحويل لموظف)
الـ Autonomous Node يستدعيه لما العميل يطلب موظف أو لما النية = شكوى/ريسيل. مرّر `teamId` من النود.

```typescript
const c = conversation as any;
const w = workflow as any;
const BRIDGE = 'https://YOUR-BRIDGE.up.railway.app/botpress/webhook';

const teamId = Number(w.handoffTeamId) || 3;   // 3=مبيعات افتراضيًا، 4=شكاوى...

try {
  await axios.post(BRIDGE, {
    conversationId: c.chatwootConvId,
    messages: [{ text: 'تمام 🙌 بوصّلك بزميل من فريقنا حالًا، ثانية واحدة.' }],
    actions: [{ type: 'handoff', team_id: teamId }],
  }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
  c.isHandedOff = true;
} catch (err: any) {
  console.log('Bridge handoff error:', err.message);
}
```

---

## 4) ربط الـ postbacks بالمنطق (في الـ Autonomous Node / Transitions)

لما العميل يدوس زر، البوت يستقبل نص = الـ `value`/`payload`. اربطهم:

| postback | السلوك المطلوب |
|----------|----------------|
| `my_progress` | اقرأ `conversation.trainee.progress_percent` ورُد بالتقدم |
| `next_lesson` | اقرأ `conversation.trainee.courses_json` ورُد بالدرس الجاي |
| `human_agent` | set `workflow.handoffTeamId = 3` → نادِ `handoffToHuman` |
| `voice_soon` | رُد: «ماجد فويس قريّب جدًا 🎙️ — حاليًا أقدر أساعدك كتابة أو أوصّلك بموظف» |

> ملاحظة من مرجع البريدج (`11-webhooks-bridges`): لو المحادثة بقت `open` (موظف ماسكها)
> البوت **ما يردّش**. تأكد إن الفلتر ده موجود قبل ما البوت يعالج الرسالة.

---

## 5) Checklist

- [ ] ثيم Chatwoot متظبط (لون `#7c5cff` + اسم ماجد + أفاتار + Theme=Light) — القسم (1).
- [ ] الـ Webhook مفعّل عليه الحدثين **`conversation_created`** + **`message_created`** على `‎/chatwoot/webhook`.
- [ ] البريدج منشور على Railway + متغيرات الترحيب (`WELCOME_TEXT`/`WA_NUMBER`/`SUPPORT_EMAIL`) مظبوطة.
- [ ] الترحيب التلقائي شغّال: افتح الشات → يظهر نص الترحيب + كارت التواصل فورًا.
- [ ] رابط البريدج متحطّ في `BRIDGE` بالكودين بتوع Botpress.
- [ ] كارت 1 (التقاط conv id) أول نود بعد الـ Trigger.
- [ ] **Botpress مايبعتش ترحيب** (البريدج بيعمله) — يبدأ يرد من أول رسالة للعميل.
- [ ] كارت `handoffToHuman` متربط بنية «موظف/شكوى/ريسيل» + `team_id` الصح.
- [ ] الـ postbacks متربطين (القسم 4).
- [ ] اختبار: زائر مجهول + متدرب logged-in → الترحيب يظهر، الكليك يرجّع للبوت، الـ handoff يفتح للموظف.

---

*المعاينة البصرية: [`chat-noor.html`](../chat-noor.html) + [`chat-inbox-preview.html`](../chat-inbox-preview.html) • عقد البريدج: [`bridge/README.md`](bridge/README.md)*
