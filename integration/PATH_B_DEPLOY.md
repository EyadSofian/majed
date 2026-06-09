# ماجد «نور» — دليل النشر (الطريق ب: ويدجت مخصّص + Chatwoot API Channel)

نظرة عامة على الأطراف:

```
ويدجت «نور» (موقع Odoo)  ──▶  البريدج (Railway)  ──▶  Botpress (مخ البوت)
        ▲                          │  ▲
        └──── SSE (رد فوري) ───────┘  └──▶  Chatwoot API Channel (الموظف يشوف ويرد → webhook → SSE)
```

القيم المعروفة:
- Chatwoot Base: `https://chat.engosoft.com`
- Account ID: `2`  ·  Inbox ID: `29` (API Channel «Majed Web»)

> 🔐 الـ **API Access Token** يتحط في Railway env بس — **مش في أي ملف ولا GitHub**. (واللي اتشارك في الشات يُفضّل تجديده.)

---

## 1) البريدج على Railway
1. Railway → New Project → Deploy from GitHub repo → اختر ريبو `majed`.
2. **Root Directory** = `integration/bridge` (مهم — البريدج في مجلد فرعي).
3. Variables (Environment):

| Key | Value |
|-----|-------|
| `CHATWOOT_BASE_URL` | `https://chat.engosoft.com` |
| `CHATWOOT_ACCOUNT_ID` | `2` |
| `CHATWOOT_API_TOKEN` | **(التوكن بتاعك — سرّي)** |
| `CHATWOOT_INBOX_ID` | `29` |
| `BOTPRESS_WEBHOOK_URL` | رابط Botpress webhook |
| `WIDGET_ORIGIN` | `https://demo.engosoft.com` (دومين الموقع بالظبط) |
| `WA_NUMBER` | `966920016295` |
| `SUPPORT_EMAIL` | `aibot@engosoft.com` |

4. بعد النشر خد رابط البريدج، مثلاً `https://majed-bridge.up.railway.app`.
5. تأكد: افتح الرابط في المتصفح → لازم يرجّع `{"status":"running","mode":"path-b-api-channel","inboxId":"29"}`.

## 2) Chatwoot — اربط الـ API Channel بالبريدج
في إعدادات الـ inbox «Majed Web» (الـ API channel):
- **Webhook URL** = `https://<bridge>.up.railway.app/chatwoot/webhook`
  (ده اللي يخلّي رد الموظف يوصل للويدجت لحظيًا).

## 3) Odoo — حمّل الويدجت
الموديول جاهز: `integration/odoo/ai_user_context_webhook/` (أو الـ zip `ai_user_context_webhook_MAJED_AVATAR.zip`).
1. ركّب الموديول (Apps → رفع/تركيب).
2. Settings → Technical → Parameters → System Parameters:

| Key | Value |
|-----|-------|
| `ai_webhook.bridge_url` | `https://<bridge>.up.railway.app` ← **مطلوب** |
| `ai_webhook.majed_avatar_url` | `/ai_user_context_webhook/static/src/img/majed-avatar.png` |
| `ai_webhook.majed_greeting` | `أهلاً، أنا ماجد` |
| `ai_webhook.wa_number` | `966920016295` |
| `ai_webhook.support_email` | `aibot@engosoft.com` |
| `ai_webhook.theme` | `light` |

> الموديول يحقن الويدجت في كل صفحات الموقع، والويدجت بيقرأ بيانات المتدرب من
> `/ai_webhook/user_context` تلقائيًا ويمررها للبريدج (للبوت + Chatwoot).

## 4) Botpress
- رابط رد البوت = `https://<bridge>.up.railway.app/botpress/webhook`.
- شكل الرد: `{ conversationId, messages:[{text}|{content_type,content_attributes}], actions:[{type:"handoff",team_id}] }`.
- التفاصيل + كود Execute Code في [`BOTPRESS_CHAT_UI.md`](BOTPRESS_CHAT_UI.md).
- **مهم:** البريدج بيبعت الترحيب تلقائيًا، فـ Botpress يبدأ يرد من أول رسالة عميل (مايكررش ترحيب).

## 5) اختبار end-to-end
- [ ] `GET /` بيرجّع `inboxId:"29"`.
- [ ] افتح الموقع → زرار ماجد يظهر → افتحه → يجيلك الترحيب (SSE).
- [ ] اكتب رسالة → تظهر في Chatwoot inbox «Majed Web» كـ incoming، والبوت يرد (SSE فوري).
- [ ] رد من Chatwoot كموظف → يظهر في الويدجت لحظيًا.
- [ ] handoff من Botpress → الحالة تبقى open + الموظف يستلم.

---

## ملاحظات تقنية
- **Real-time:** SSE (`/widget/stream`). Chatwoot = مصدر الحقيقة، ومنع التكرار بالـ message id.
- **CORS:** `WIDGET_ORIGIN` لازم يساوي دومين الموقع بالظبط (بدون مسار).
- **تحديث شكل الويدجت:** عدّل `integration/bridge/public/majed-widget.js` وأعد النشر — مفيش لمس لـ Odoo.
- **الويدجت معاينة محلية:** `widget-test.html` (بـ mock bridge) في جذر المشروع.
