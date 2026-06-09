# لينك معاينة ماجد — للعرض على الإدارة

عندك ملف واحد مستقل: **`demo.html`** (الأفاتار متضمَّن جواه، بيتصل بـ Chatwoot الحقيقي).
ارفعه بأي طريقة من دول عشان تطلّع لينك:

## الأسرع — Netlify Drop (من غير حساب، ثوانٍ)
1. افتح <https://app.netlify.com/drop>
2. **اسحب ملف `demo.html`** (أو المجلد كله) وافلته في الصفحة.
3. هياخد فورًا لينك زي `https://random-name.netlify.app` → ابعته للإدارة. ✅

## دائم — Railway (المشروع جاهز أصلًا)
المشروع فيه `server.js` + `railway.toml`، فالنشر مباشر:
1. ارفع مجلد المشروع على GitHub.
2. Railway → New Project → Deploy from GitHub → هيشتغل `npm start`.
3. هتاخد لينك زي `https://majed-widget.up.railway.app`.

## بديل — GitHub Pages
ارفع المجلد على repo → Settings → Pages → Branch = main → اللينك يطلع على `https://<user>.github.io/<repo>/demo.html`.

---

### ملاحظات للعرض
- الويدجت بيفتح **Chatwoot الحقيقي** (chat.engosoft.com)، يعني أي رسالة في الديمو هتوصل الـ inbox الفعلي.
  لو مش عايز ده وقت العرض، اقفل مؤقتًا ربط Botpress أو نبّه الفريق.
- الزرار = أفاتار ماجد يفتح الشات على طول (مفيش قائمة ٤ أيقونات).
- على الموبايل الشات بياخد عرض الشاشة كامل تقريبًا — جرّبه قبل العرض.
