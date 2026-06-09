# ماجد — Botpress Chat API (المسار الحقيقي) · دليل الإعداد والتشغيل

> **التحديث المعماري:** البريدج اتنقل من «Webhook Integration trigger» (غلط — مفيش محادثات جوه Botpress)
> إلى **Botpress Chat API الرسمي** — بينشئ user + conversation + message حقيقيين جوه Botpress،
> والرد بيرجع تلقائي عبر **SSE** ويتكتب في Chatwoot ويوصل الويدجت فوري.
> مفيش Botpress Webchat، ومفيش اعتماد على Webhook Trigger.

---

## 1) ليه المسار القديم كان غلط؟

| | القديم (Webhook Integration) | الجديد (Chat API) |
|---|---|---|
| URL | `webhook.botpress.cloud/<id>` | `chat.botpress.cloud/<id>` |
| اللي بيحصل | حدث خام يدخل الفلو — **مفيش** conversation/user جوه Botpress | user + conversation + messages **حقيقيين** في Botpress |
| الرد | لازم الفلو يعمل POST يدوي للبريدج | بيرجع **تلقائي** عبر SSE listener |
| المحادثات في Botpress | ❌ مش بتظهر | ✅ بتظهر بالكامل |

## 2) القرار المعماري (Agent Bot vs Integration Webhook)

**لا ده ولا ده كمسار وارد.** قناة العميل عندنا هي **الويدجت المخصص** اللي بيكلّم البريدج مباشرة —
فمفيش داعي نلف: ويدجت → Chatwoot → Agent Bot → بريدج → Botpress (round-trip زيادة + احتمالات تكرار).

المعتمد:
- **وارد العميل:** الويدجت → البريدج مباشرة (`/widget/message`).
- **Chatwoot:** يفضل **مصدر الحقيقة** — كل رسالة بتتكتب فيه (incoming/outgoing).
- **Inbox Webhook URL** (الموجود أصلاً على API channel): بيوصّل **رد الموظف** + **تغيّر الحالة** للبريدج.
- **Botpress:** Chat API حقيقي + SSE للردود.
- الـ **Agent Bot غير مطلوب** — والـ gating بتاعه (إيقاف البوت لما الموظف ماسك) متنفّذ جوه البريدج بالـ status.

## 3) إعداد Botpress (مرة واحدة)

1. Botpress Studio → **Integrations** → ركّب **Chat** (مش "Webhook").
2. افتح صفحة إعدادات الـ Chat integration → هتلاقي **Webhook URL** بالشكل:
   `https://chat.botpress.cloud/<CHAT_WEBHOOK_ID>` → انسخ الـ `<CHAT_WEBHOOK_ID>`.
3. **سيب خاصية Encryption Key فاضية** (manual auth غير مدعوم في v1 من البريدج).
4. **Publish** البوت.
5. مفيش حاجة تانية مطلوبة جوه Botpress — أي Autonomous Node/فلو عادي هيستقبل الرسائل
   كمحادثة طبيعية ويرد، والرد هيوصل تلقائيًا.

### بيانات المتدرب جوه البوت
البريدج بيبعت `userData` (اسم/كورسات/تقدم من Odoo) في حقل **`profile`** بتاع الـ Chat user
(JSON string بحد 1000 حرف). جوه البوت اقرأها من tags بتاعة الـ user
(Execute Code: `(user as any).tags?.['chat:profile']` أو شوف الـ user object في الـ Inspector).

### الـ handoff من البوت (3 طرق مدعومة)
1. **ماركر في النص (الأسهل):** البوت يرد بنص فيه `[[HANDOFF]]` أو `[[HANDOFF:3]]`
   → البريدج يشيل الماركر (مش بيظهر للعميل)، يحوّل الحالة لـ open ويعمل assign للتيم.
2. **Custom event** عبر الـ Chat integration بـ payload `{ "type": "handoff", "team_id": 3 }`.
3. **Legacy:** POST لـ `/botpress/webhook` بـ `{ conversationId, actions:[{type:"handoff",team_id:3}] }`.

## 4) متغيرات Railway (القائمة النهائية)

| المتغير | القيمة | ملاحظة |
|---------|--------|--------|
| `CHATWOOT_BASE_URL` | `https://chat.engosoft.com` | |
| `CHATWOOT_ACCOUNT_ID` | `2` | |
| `CHATWOOT_API_TOKEN` | **توكن جديد بعد rotate** | ⚠ القديم اتسرّب في الشات — لازم Regenerate |
| `CHATWOOT_INBOX_ID` | `29` | أو `CHATWOOT_INBOX_IDENTIFIER` |
| `BOTPRESS_CHAT_WEBHOOK_ID` | `<id>` من Chat integration | **جديد — ده الأساسي** |
| `WIDGET_ORIGIN` | `https://demo.engosoft.com` | CORS |
| `WELCOME_*` / `WA_NUMBER` / `SUPPORT_EMAIL` | اختياري | لها قيم افتراضية |
| ~~`BOTPRESS_WEBHOOK_URL`~~ | **احذفه** | كان بيودّي للـ Webhook integration الغلط |
| ~~`BOTPRESS_PAT`~~ | احذفه | الـ Chat API مش محتاجه |

## 5) إعداد Chatwoot (زي ما هو — للتأكيد)
- Inbox 29 (API Channel) → **Webhook URL** = `https://majed-production-dd41.up.railway.app/chatwoot/webhook` ✅ (موجود).
- **مفيش Agent Bot** ومفيش Webhooks integration إضافية.
- ⚠ **Rotate** للـ Access Token (Profile → Access Token → Regenerate) وتحديثه في Railway.

## 6) Deploy على Railway
1. push الكود (تم) → Railway هيعمل redeploy تلقائي (Root Directory = `integration/bridge`).
2. ضيف `BOTPRESS_CHAT_WEBHOOK_ID` واحذف `BOTPRESS_WEBHOOK_URL` و `BOTPRESS_PAT`.
3. بعد الـ deploy تحقق:
   - `GET /` → `{"mode":"chatwoot-botpress-chat-api","botpress":"chat-api","inboxId":"29"}`
   - `GET /debug/config` → كل القيم true والـ inboxId ظاهر (مفيش أسرار في الرد).

## 7) اختبار End-to-End (بالترتيب)
1. افتح الموقع → hard reload → افتح الشات → الترحيب يظهر.
2. ابعت «مرحبا» → تشوفها في انبوكس Chatwoot (incoming) **وفي Botpress** (محادثة حقيقية ظهرت) → رد البوت يرجع في الويدجت خلال ثواني.
3. لوج Railway يوري السلسلة: `IN widget` → `SEND Botpress` → `BOTPRESS reply` → `OUT Chatwoot`.
4. handoff: خلّي البوت يرد بـ `[[HANDOFF:3]] حوّلتك لزميل` → الحالة تبقى open + assign للتيم + البوت يقف.
5. رد الموظف من Chatwoot → يوصل الويدجت فوري. رسائل العميل أثناء open → للموظف فقط (`SKIP bot`).
6. الموظف يقفل/يرجّع الحالة pending → البوت يرجع يرد.

## 8) ضمانات مدمجة (متغطية باختبارات mock — 22 check)
- ✅ outgoing/private عمرها ما تتبعت للبوت أو للعميل بالغلط.
- ✅ dedup بالـ message id (ويدجت) + bp message id (SSE reconnect) + echo الرسائل اللي البريدج كتبها.
- ✅ mapping (cwConv ↔ bpUser/bpConv) محفوظ في **custom_attributes بتاعة محادثة Chatwoot** → يعيش بعد restart للبريدج.
  (in-memory + استرجاع تلقائي؛ مفيش DB — المخاطرة الوحيدة: SSE listener بيتفتح من جديد عند أول رسالة بعد الـ restart.)
- ✅ فشل Botpress مش بيوقّع رسالة العميل (بتتكتب في Chatwoot على أي حال).
- ✅ اللوجينج: `IN widget` / `IN Chatwoot(external)` / `SEND Botpress` / `BOTPRESS reply` / `OUT Chatwoot` / `HANDOFF` / `STATUS` / `SKIP`.

## 9) 🔐 تنبيه أمني (إلزامي)
- `CHATWOOT_API_TOKEN` اللي اتكتب في الشات/الريبو القديم = **مكشوف** → **Regenerate فورًا** وحدّثه في Railway فقط.
- أي `BOTPRESS_PAT` ظهر في الريبو القديم ([chatwoot-botpress-bridge](https://github.com/EyadSofian/chatwoot-botpress-bridge) فيه توكنات hardcoded) = **مكشوف** → rotate من Botpress، ويُفضّل أرشفة/تخصيص الريبو القديم أو مسح الـ history.
- مفيش أي secret في كود الريبو الجديد — كله env vars.

---
*ملف الفلو القديم `BOTPRESS_FLOW_BRIEF.md` اتعلّم عليه إنه متجاوز — مبني على Webhook Trigger.*
