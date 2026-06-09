# ماجد — ملخص المشروع الكامل (Handover)

> مساعد Engosoft التعليمي على الموقع: ويدجت Chatwoot بزرار مخصص (ماجد) + ربط Botpress + بيانات المتدرب من Odoo.
> آخر تحديث: يونيو 2026.

---

## 1) نظرة عامة — المنظومة بالكامل

```
┌──────────────┐   بيانات المتدرب     ┌──────────────┐   message_created   ┌───────────┐   forward + context  ┌──────────┐
│   Odoo 17    │ ──setUser/attrs───▶ │   Chatwoot   │ ──────webhook──────▶ │  Bridge   │ ───────────────────▶ │ Botpress │
│  (website)   │                      │ self-hosted  │                      │ (Railway) │                       │  (ماجد)  │
│ زرار ماجد +  │ ◀──ويدجت الشات────── │chat.engosoft │ ◀── text/cards ───── │  Express  │ ◀── reply/handoff ─── │          │
└──────────────┘                      └──────┬───────┘   /handoff (API)     └───────────┘                       └──────────┘
                                             │ الموظف البشري يستلم عند الـ handoff (status: open + team)
                                             ▼  داشبورد Chatwoot
```

**كل طبقة بتعمل إيه:**
| الطبقة | المسؤولية |
|--------|-----------|
| **Odoo module** | يحقن الويدجت في كل صفحات الموقع + يبعت بيانات المتدرب (اسم/كورسات/تقدم) لـ Chatwoot |
| **Chatwoot** | واجهة المحادثة + تخزين + داشبورد الموظف البشري + التحويل |
| **Bridge** | يوصّل رسائل العميل لـ Botpress (ومعاها بيانات المتدرب) ويرجّع رد Botpress (نص/أزرار/handoff) |
| **Botpress** | مخ ماجد: الردود + المنطق + قرار التحويل لأي تيم |

---

## 2) القرارات الأساسية اللي اتاخدت

1. **الزرار يفتح الشات على طول** — مفيش قائمة ٤ أيقونات (اتشالت نهائيًا).
2. **تصميم الزرار النهائي:** Liquid Glass + صورة ماجد جواه + نقطة أونلاين فوق يمين + حلقة نابضة + **رسالة ترحيب جانبية**.
3. الأزرار (واتساب/إيميل/Voice) **مش launcher** — بتظهر **جوه الشات** كرسائل Card تفاعلية يبعتها البوت.
4. **التحويل لموظف بشري (handoff):** المنطق في Botpress، والبريدج بينفّذ (status → open + assign team).
5. بيانات المتدرب بتوصل **Chatwoot** (للموظف) و **Botpress** (لماجد) — الاتنين.

---

## 3) الملفات — كل ملف بيعمل إيه

### أ) معاينة الويدجت (مجلد المشروع الرئيسي) — للتجربة والعرض
| الملف | الوظيفة |
|------|---------|
| `index.html` | صفحة معاينة كاملة: زرار ماجد + لوحة شات احتياطية + تحميل Chatwoot الحقيقي |
| `demo.html` | نسخة **ملف واحد** (الصورة جواه) — ارفعها بسهولة لعرض لينك للإدارة |
| `module-ui-preview.html` | معاينة معزولة للتصميم النهائي للزرار (نفس كود الموديول) |
| `launcher-concepts.html` | الـ ٣ كونسبتات (A زجاج / B أوربـ / C Pill) اللي اخترت منها |
| `chat-panel-preview.html` / `chat-buttons-preview.html` | موكابات للأشكال اللي جرّبناها |
| `server.js` + `package.json` + `railway.toml` | سيرفر ثابت لتشغيل المعاينة محليًا/Railway |
| `assets/majed-avatar.png` | صورة ماجد (مضغوطة 256px / 105KB) |
| `DEMO.md` | طرق رفع لينك المعاينة (Netlify Drop / Railway) |

### ب) موديول Odoo — `integration/odoo/ai_user_context_webhook/`
| الملف | الوظيفة |
|------|---------|
| `__manifest__.py` | تعريف الموديول (Odoo 17، يعتمد على base + website) |
| `views/webchat_template.xml` | **القلب:** يحقن Chatwoot SDK + يخفي الفقاعة + زرار ماجد (زجاج+صورة) + رسالة الترحيب + يبعت بيانات المتدرب |
| `controllers/main.py` | endpoint `‎/ai_webhook/user_context` (session auth) يرجّع بيانات المتدرب JSON |
| `utils/data_builder.py` | يبني البيانات: user + courses + progress + events من Odoo |
| `data/ir_config_parameter.xml` | الإعدادات (System Parameters) — انظر القسم 5 |
| `static/src/img/majed-avatar.png` | صورة الزرار الافتراضية |

📦 **الجاهز للرفع:** `integration/ai_user_context_webhook_MAJED_AVATAR.zip`

### ج) البريدج — `integration/bridge/`
| الملف | الوظيفة |
|------|---------|
| `index.js` | سيرفر Express: `‎/chatwoot/webhook` (وارد→Botpress + context) و `‎/botpress/webhook` (رد→Chatwoot: نص/cards/handoff) |
| `.env.example` | المتغيرات المطلوبة |
| `README.md` | **عقد الـ payload** اللي Botpress يبعته (مهم لبناء الفلو) |
| `railway.toml` + `package.json` | جاهز للنشر على Railway |

📦 **الجاهز للرفع:** `integration/chatwoot-botpress-bridge-RAILWAY.zip`

### د) التوثيق — `integration/`
| الملف | الوظيفة |
|------|---------|
| `CHATWOOT_SETUP.md` | دليل إعدادات داشبورد Chatwoot (الاسم/اللون/الترحيب/الأجنت بوت/البراندينج) |
| `INTEGRATION_REVIEW.md` | المعمارية + المراجعة + خطوات النشر + مسار البيانات |

---

## 4) مسار البيانات (Data Flow) خطوة بخطوة

1. المتدرب يفتح موقع Odoo → الموديول يحمّل Chatwoot ويظهر **زرار ماجد**.
2. لو عامل login → الموديول ينده `‎/ai_webhook/user_context` ويبعت (الاسم/الكورسات/التقدم) لـ Chatwoot عن طريق `setUser` + `setCustomAttributes`.
3. المتدرب يدوس الزرار → يفتح شات Chatwoot (المحادثة بحالة **pending** = البوت يتعامل).
4. رسالة المتدرب → Chatwoot يبعت `message_created` للبريدج → البريدج يبعتها لـ Botpress **ومعاها بيانات المتدرب** (`userData`).
5. Botpress يرد → البريدج يكتب الرد في Chatwoot (نص أو **Card أزرار**).
6. لو Botpress قرر تحويل → يبعت `{actions:[{type:"handoff",team_id:N}]}` → البريدج يعمل `status: open` + `assign team` → **الموظف البشري يستلم**.

---

## 5) الإعدادات (Reference)

### System Parameters في Odoo (Settings → Technical → Parameters)
| المفتاح | القيمة |
|---------|--------|
| `ai_webhook.chatwoot_base_url` | `https://chat.engosoft.com` |
| `ai_webhook.chatwoot_website_token` | `faaNReedHd76N7wxGjbCUh1x` |
| `ai_webhook.majed_greeting` | نص رسالة الترحيب |
| `ai_webhook.majed_avatar_url` | رابط صورة ماجد (أو رابط الـ Channel Avatar من Chatwoot) |

### Environment Variables للبريدج (Railway)
| المتغير | مصدره |
|---------|-------|
| `CHATWOOT_BASE_URL` | `https://chat.engosoft.com` |
| `CHATWOOT_ACCOUNT_ID` | رقم بعد `/accounts/` في رابط الداشبورد |
| `CHATWOOT_API_TOKEN` | Chatwoot → Profile → Access Token |
| `BOTPRESS_WEBHOOK_URL` | من Botpress (Webhook integration) |
| `BOTPRESS_PAT` | اختياري |

---

## 6) خطوات النشر (Checklist)

- [ ] **Bridge:** ارفع `integration/bridge` على Railway + ظبط الـ 5 متغيرات → خد الرابط.
- [ ] **Chatwoot:** Settings → Bots → اعمل Agent Bot بـ `outgoing_url = https://<bridge>/chatwoot/webhook` → الـ Inbox → Bot Configuration → اختاره.
- [ ] **Botpress:** حط رابط الرد `https://<bridge>/botpress/webhook` في إعدادات الـ webhook.
- [ ] **Odoo:** ركّب الموديول من الـ zip + اتأكد من الـ System Parameters.
- [ ] **Chatwoot dashboard:** اسم/لون/أفاتار/Business Hours + شيل البراندينج (Super Admin). (التفاصيل في `CHATWOOT_SETUP.md`)
- [ ] **اختبار:** زائر مجهول + متدرب logged-in + رسالة توصل Botpress وترجع + تجربة handoff.

---

## 7) اللي خلص ✅ واللي فاضل ⏳

**خلص:**
- تصميم الزرار النهائي (Liquid Glass + صورة + ترحيب) في الموديول + المعاينة.
- موديول Odoo: حقن الويدجت + إرسال بيانات المتدرب (شغّال).
- البريدج: وارد→Botpress (+context)، رد→Chatwoot، دعم **Cards** و **handoff/assign/status**.
- تنظيف الكود الميت + ضغط الصورة + كل الملفات متزبطة ومضغوطة.

**فاضل (جزء منه عليك في Botpress/Chatwoot):**
- ⏳ **فلو Botpress Cloud:** أول رسالة = Card الأزرار؛ منطق التحويل (team_ids). — *أقدر أكتبلك الـ brief بالتفصيل (Execute Code + Transitions).*
- ⏳ إعداد Chatwoot dashboard (Agent Bot + branding + business hours).
- ⏳ النشر الفعلي على Railway + ربط الأطراف.
- ⏳ (أمان اختياري) توكن سري للبريدج + HMAC لهوية المستخدم.

---

## 8) Prompt جاهز (للتسليم لأي مطوّر/AI يكمّل)

> **السياق:** مساعد "ماجد" التعليمي لـ Engosoft. ويدجت Chatwoot self-hosted (`chat.engosoft.com`, website token `faaNReedHd76N7wxGjbCUh1x`) مدموج في موقع Odoo 17 عن طريق موديول `ai_user_context_webhook`. الزرار مخصص (Liquid Glass + صورة ماجد) ويفتح الشات على طول. البوت = Botpress Cloud، متوصّل بـ Chatwoot عن طريق bridge (Node/Express على Railway) عبر `‎/chatwoot/webhook` و `‎/botpress/webhook`.
>
> **مسار البيانات:** Odoo يبعت بيانات المتدرب (الكورسات/التقدم) كـ Chatwoot contact attributes؛ البريدج بيمرّرها لـ Botpress في `userData` مع كل رسالة. ردود Botpress ترجع للبريدج بصيغة `{ messages:[{text}|{content_type,content_attributes}], actions:[{type:"handoff",team_id}] }`.
>
> **المطلوب في Botpress:** Autonomous Node يبعت أول رسالة Card فيها أزرار (واتساب link، إيميل link، Voice postback)، ويبعت action handoff لما العميل يطلب موظف أو حسب نوع الطلب (ريسيل/شكوى → team_id مختلف).
>
> **قواعد مهمة:** Chatwoot widget جوه iframe (مش بيتستايل من بره)؛ شكل النافذة من داشبورد Chatwoot؛ الأزرار جوه الشات = interactive messages من البوت مش من الكود.

---

*كل الملفات في مجلد المشروع. الـ zip-ين الجاهزين في `integration/`.*
