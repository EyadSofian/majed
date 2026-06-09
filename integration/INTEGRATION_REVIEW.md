# مراجعة الربط + خطوات النشر (Chatwoot ↔ Botpress ↔ Odoo)

## 🗺️ الصورة الكاملة للمعمارية

```
┌─────────────┐   بيانات المتدرب     ┌──────────────┐
│   Odoo 17   │ ───setUser/attrs──▶ │   Chatwoot   │
│  (website)  │                      │ self-hosted  │
│ + الأفاتار  │ ◀──ويدجت الشات────── │chat.engosoft │
└─────────────┘                      └──────┬───────┘
                                            │ message_created (webhook)
                                            ▼
                                     ┌──────────────┐
                                     │ Bridge (Node) │  Railway
                                     │  Express      │
                                     └──────┬───────┘
                                            │ forward
                                            ▼
                                     ┌──────────────┐
                                     │   Botpress   │  (مخ ماجد)
                                     └──────┬───────┘
                                            │ رد
                                            ▼
                              يرجع لـ Chatwoot عن طريق API
```

- **Odoo** = يحقن الويدجت + يبعت بيانات المتدرب (اسم/كورسات/تقدم) لـ Chatwoot.
- **Chatwoot** = واجهة المحادثة + تخزين + لوحة الدعم البشري.
- **Bridge** = يوصّل رسائل العميل لـ Botpress ويرجّع رد Botpress لـ Chatwoot.
- **Botpress** = الذكاء/الردود.

---

## ✅ اللي اتعمل في المراجعة

1. **موديول Odoo:** استبدلت الـ 3 أزرار (واتساب/إيميل/ماجد) بـ **أفاتار ماجد واحد يفتح الشات على طول** — مطابق للويدجت اللي بنيناه. (`views/webchat_template.xml`)
2. أضفت صورة الأفاتار في `static/src/img/majed-avatar.png` (بتتقدّم تلقائيًا من Odoo).
3. أضفت `window.chatwootSettings` (hideMessageBubble, locale ar, ...) قبل تحميل الـ SDK.
4. حافظت على دفع بيانات المتدرب (`setUser` + `setCustomAttributes`) — ده شغل ممتاز ومتسيب زي ما هو.
5. تأكدت إن الـ XML سليم (well-formed).
6. **شِلت الكود الميت:** فولدر `services/` (webhook_service.py) وفولدر `models/` (res_users فاضي)
   — مكانوش متستوردين في `__init__.py` أصلًا.
7. **صغّرت صورة الأفاتار** من 1.2MB لـ 105KB (256×256، PNG optimized).

---

## ⚠️ نقاط لازم تتعامل معاها قبل الإنتاج

### 1. التحقق من هوية المستخدم (HMAC) — متوسط الأهمية
الموديول بيبعت `setUser(id, {...})` **من غير `identifier_hash`**. لو الـ Inbox مفعّل عليه
**"Enforce user identity validation"**، النداء ده هيفشل.
- **حل سريع:** اقفل الـ enforcement من Inbox → Configuration.
- **حل آمن:** أحسب HMAC SHA256 للـ identifier بـ `HMAC key` بتاع الـ Inbox **من السيرفر** (Odoo controller) وأبعته للمتصفح. قولي أعمله لو محتاجه.

### 2. الـ Bridge مفيهوش حماية — مهم أمنيًا
`/chatwoot/webhook` و `/botpress/webhook` **مفتوحين لأي حد**. أي شخص يعرف الـ URL يقدر يحقن
رسائل. الموصى به: توكن سري مشترك يتبعت في header ويتفحص في الـ bridge.
- ممكن أضيف فحص `X-Webhook-Secret` بسيط لو موافق.

### 3. كود ميت في الموديول — ✅ اتشال
`services/webhook_service.py` و `models/` كانوا مش متوصّلين بأي حاجة → **اتشالوا**.
المسار الفعّال الوحيد هو الـ fetch من المتصفح (`/ai_webhook/user_context`).

### 4. التوكن في الكود
`chatwoot_website_token` في `data/ir_config_parameter.xml` = توكن عام (بيظهر في الـ JS أصلًا) → **مفيش مشكلة**.
لكن `CHATWOOT_API_TOKEN` بتاع الـ bridge **سري** → لازم يفضل في environment variables بس (مش في الكود). ✅ معمول صح.

---

## 🚀 خطوات النشر

### أ) الـ Bridge على Railway
1. ارفع فولدر `integration/bridge` كـ repo على GitHub.
2. Railway → New Project → Deploy from GitHub.
3. في Railway → Variables، ظبط:
   ```
   CHATWOOT_BASE_URL=https://chat.engosoft.com
   CHATWOOT_ACCOUNT_ID=<account id من URL الداشبورد /app/accounts/{ID}>
   CHATWOOT_API_TOKEN=<من Chatwoot → Profile Settings → Access Token>
   BOTPRESS_WEBHOOK_URL=https://webhook.botpress.cloud/<webhook-id>
   BOTPRESS_PAT=<اختياري>
   ```
4. هتاخد URL زي `https://majed-bridge.up.railway.app`.

### ب) ربط Chatwoot بالـ Bridge
- Chatwoot → Settings → Integrations → **Webhooks** → Add:
  `https://majed-bridge.up.railway.app/chatwoot/webhook` — حدث **`message_created`**.

### ج) ربط Botpress بالـ Bridge
- Botpress → Messaging/Webhook integration → Response/Outgoing URL:
  `https://majed-bridge.up.railway.app/botpress/webhook`

### د) موديول Odoo
1. انسخ فولدر `integration/odoo/ai_user_context_webhook` لمجلد addons بتاع Odoo.
2. Apps → Update Apps List → دوّر على **AI User Context Webhook** → Install.
3. Settings → Technical → **System Parameters** → اتأكد من:
   - `ai_webhook.chatwoot_base_url = https://chat.engosoft.com`
   - `ai_webhook.chatwoot_website_token = faaNReedHd76N7wxGjbCUh1x`
4. افتح أي صفحة في موقع Odoo → المفروض تلاقي **أفاتار ماجد** تحت يمين → دوس عليه → الشات يفتح.
5. اعمل login بحساب متدرب → افتح الـ console → المفروض تشوف:
   `[ai_webhook] Trainee data pushed to Chatwoot` → ومن داشبورد Chatwoot هتلاقي الـ contact
   فيه custom attributes (الكورسات، التقدم...).

---

## 🔁 هل بيانات اللوج إن بتوصل Botpress؟ (سؤال مهم)

**الوضع الأصلي:** لأ. الموديول بيبعت بيانات المتدرب لـ **Chatwoot بس** (كـ contact custom attributes
عن طريق `setUser` + `setCustomAttributes`). الموظف البشري بيشوفها في داشبورد Chatwoot، لكن الـ bridge
كان بيبعت لـ Botpress **النص + اسم المرسِل + الـ IDs بس** — يعني ماجد (Botpress) **مكانش بيشوف**
الكورسات/التقدم.

**بعد التعديل:** عدّلت الـ bridge (`bridge/index.js`) عشان ياخد الـ contact attributes من ويب هوك
Chatwoot (`payload.sender.custom_attributes`) ويبعتها لـ Botpress في:
- `userData` (على المستوى الأعلى من الـ event)
- و جوه `metadata` كمان

كده فلو Botpress يقدر يقرأ `courses_json` و `progress_percent` و `enrolled_courses` ... إلخ مباشرة
من الرسالة الواردة.

> مسار البيانات بالكامل:
> `Odoo (login) → setCustomAttributes → Chatwoot contact → message_created webhook → bridge → Botpress`
>
> ملاحظة: البيانات بتوصل Botpress **مع أول رسالة** يبعتها المتدرب بعد اللوج إن (مش لحظة اللوج إن نفسها)،
> لأن Botpress بيشتغل برسائل. ده طبيعي وكافي لأن ماجد محتاج البيانات وقت ما المتدرب يكلّمه.

---

## 🧪 اختبار سريع
- زائر مجهول → الأفاتار يفتح الشات، من غير بيانات.
- متدرب logged-in → نفس الشيء + بياناته بتظهر لماجد في Chatwoot.
- اكتب رسالة → لازم توصل Botpress (شوف Railway logs: `Sent to Botpress`) → ويرجع الرد في الشات.
