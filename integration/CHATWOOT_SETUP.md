# دليل إعدادات Chatwoot — كل عنصر في الشات بيتظبط منين

> القاعدة الذهبية: **كود الويدجت بيتحكم في الزرار العائم بس.** كل اللي جوه نافذة الشات
> (الاسم، الترحيب، فورم الإيميل، الردود، البراندينج) بيتظبط من **داشبورد Chatwoot نفسه**.

افتح Chatwoot على `https://chat.engosoft.com` وادخل بحساب Admin.

---

## 1. اسم البوت "Majed" + الأفاتار + رسالة "سوف نعود في أقرب وقت"

**المكان:** Settings → **Inboxes** → اختر الـ Website Inbox بتاع ماجد → تبويب **Configuration**.

| العنصر في الصورة | الحقل في Chatwoot |
|------------------|--------------------|
| الاسم "Majed" | Inbox Name / Website Name |
| الأفاتار في الهيدر | Avatar (ارفع صورة ماجد) |
| اللون الأزرق | Widget Color |
| "سوف نعود في أقرب وقت ممكن" | رسالة خارج أوقات العمل → تبويب **Business Hours** → فعّلها واكتب الرسالة، أو شيلها لو عايز يفضل online دايمًا |
| نص الترحيب فوق | Welcome Heading + Welcome Tagline |

---

## 2. كارت "احصل على الإشعارات في البريد الإلكتروني" + خانة الإيميل + "زودنا بوسيلة للتواصل"

ده **Email Collect Box** + **Pre Chat Form** المدمجين في Chatwoot (مش من الكود).

**المكان:** نفس الـ Inbox → تبويب **Configuration** (وأحيانًا **Pre Chat Form**):

- **"Enable email collect box"** → لو مقفولها، الكارت بتاع الإيميل هيختفي.
- **"Pre Chat Form"** → لو مفعّل، بيطلب بيانات (اسم/إيميل) قبل بداية المحادثة. اقفله لو عايز المتدرب يبدأ على طول.
- مهم: المتدرب اللي عامل **login في Odoo**، الموديول بيبعت إيميله تلقائيًا (`setUser`)، فالكارت ده غالبًا **مش هيظهر** له أصلًا لأن عنده إيميل. بيظهر بس للزائر المجهول.

---

## 3. "رد آلي" (Automated reply) — ردود ماجد

دي مش رسالة مكتوبة في Chatwoot — دي **ردود البوت** اللي جاية من **Botpress** عن طريق الـ bridge. Chatwoot بيحط label "رد آلي" تلقائيًا على أي رسالة جاية من بوت/أتمتة.

**علشان تتحكم في محتوى الردود:** من **Botpress** (الفلو بتاع ماجد)، مش من Chatwoot.

**لو عايز ترحيب تلقائي ثابت من Chatwoot نفسه** (من غير Botpress):
- Settings → **Canned Responses** (ردود جاهزة)، أو
- Settings → **Automation** → اعمل rule: عند `Conversation Created` → Send Message.

---

## 4. شيل "مدعوم بواسطة Chatwoot" (البراندينج)

ده **مش** من كود الويدجت ولا الموديول. في النسخة الـ self-hosted:

**الطريقة 1 (Super Admin Console):**
1. روح `https://chat.engosoft.com/super_admin`
2. ادخل بحساب الـ super admin
3. Settings → غيّر **Installation Name / Brand Name** لـ "Engosoft" و **Brand URL**.
4. ده بيغيّر "مدعوم بواسطة Chatwoot" لـ "مدعوم بواسطة Engosoft" في كل الويدجتس.

**الطريقة 2 (متغيّر بيئة عند الـ deploy):**
- ظبط `BRAND_NAME=Engosoft` و `BRAND_URL=https://engosoft.com` في إعدادات السيرفر وأعد التشغيل.

> ملاحظة: على Chatwoot **Cloud** إزالة البراندينج فيتشر مدفوع، لكن إنت self-hosted فهي مجانية من الـ super admin.

---

## 5. الـ Website Token (مهم للربط)

**المكان:** Settings → Inboxes → الـ Website Inbox → **Configuration** → انسخ الـ **Website Token**.

لازم يكون **نفس التوكن** في ٣ أماكن:
1. موديول Odoo → System Parameters → `ai_webhook.chatwoot_website_token`
2. ويدجت المعاينة → `index.html` → `CHATWOOT_WEBSITE_TOKEN`
3. أي embed تاني (الـ CodePen)

التوكن الحالي: `faaNReedHd76N7wxGjbCUh1x` ✅ (موجود في الكود بالفعل)

---

## 6. ربط ماجد (Botpress) كـ Agent Bot — اختياري لكن مفضّل

عشان ماجد يرد تلقائي، الـ bridge لازم يكون شغّال (شوف `INTEGRATION_REVIEW.md`)، وفي Chatwoot:
- Settings → **Integrations → Webhooks** → أضف: `https://<bridge-url>/chatwoot/webhook` على حدث **`message_created`**.

> ⚠️ لو فعّلت **"Enforce user identity validation"** على الـ Inbox، لازم تبعت `identifier_hash` مع `setUser`
> (HMAC). دلوقتي الموديول بيبعت `setUser` من غير hash — فاقفل الـ enforcement، أو قولي أضيف
> حساب الـ HMAC في الموديول. (تفاصيل في `INTEGRATION_REVIEW.md`)
