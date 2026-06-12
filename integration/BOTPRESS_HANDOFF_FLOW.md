# Botpress Handoff — ماجد (النسخة النهائية الجاهزة للصق)

> عند الـ handoff: يتبعت **برايفت نوت** في شاتووت + المحادثة **تتفتح** (status=open) وتتعيّن
> على فريق الإشراف — وأثناء ما هي مفتوحة البوت **ما يردّش** (البريدج بيوقف التوجيه تلقائيًا).
> لما الموظف يقفل/يرجّع المحادثة pending، البوت يرجع يرد تاني.
>
> ⚠ هذه النسخة تستبدل النسخة القديمة — فيها إصلاح باج `cwConvId not found`:
> القراءة الصحيحة من `event.tags.user` (مش `user.tags`)، والمتغيرات بنطاق **conversation**.

---

## خطوات التنفيذ في Botpress Studio (بالترتيب)

1. **Variables** → أنشئ 4 متغيرات بنطاق **conversation** (مش workflow):
   `cwConvId` · `handoffSummary` · `salesCourseName` · `chatwootPrivateNote`
2. **Autonomous Node «Majed»** → أضف الـ 2 transitions (القسم 2) — `complaintHandoff` الأول.
3. أنشئ Standard Node باسم **complaintHandoff** → 6 كروت (القسم 3).
4. أنشئ Standard Node باسم **salesHandoff** → 5 كروت (القسم 4).
5. من كل node منهم: transition «always» راجع للـ Autonomous Node.
6. في كارت `sendPrivateNote` وكارت `openAndAssign` (في النودين): حط التوكن بتاعك مكان
   `REPLACE_WITH_CHATWOOT_API_TOKEN` — تجيبه من Chatwoot → Profile → Access Token.
7. جرّب من الويدجت الحقيقي (مش الـ Emulator!) — راجع checklist آخر الملف.

---

## 1. المتغيرات (Studio → Variables)

كلها بنطاق **conversation** عشان تفضل موجودة بعد الانتقال بين النودات:

| Name | Type | Scope | بيتكتب من |
|------|------|-------|-----------|
| `cwConvId` | String | conversation | Execute Code (setCwConvId) |
| `handoffSummary` | String | conversation | الـ Autonomous Node (LLM) |
| `salesCourseName` | String | conversation | الـ Autonomous Node (LLM) |
| `chatwootPrivateNote` | String | conversation | Execute Code (buildSummary) |

**في الـ Autonomous Node → Variables Access:**
- `conversation.handoffSummary` → Allow Write Access ✅
- `conversation.salesCourseName` → Allow Write Access ✅
- `conversation.cwConvId` و `conversation.chatwootPrivateNote` → قراءة فقط.

---

## 2. Autonomous Node «Majed» — Transitions

الترتيب مهم: الأكثر تحديدًا فوق.

### Transition 1 — `complaintHandoff` (فوق)
```
The user reports a complaint, technical issue, refund request, certificate problem,
login failure, video playback issue, instructor problem, or any issue requiring
human intervention.
Before transitioning:
- Store a one-sentence Arabic summary of the issue in {{conversation.handoffSummary}}.
- Do NOT send any message to the user before transitioning.
- Transition IMMEDIATELY once handoffSummary is set.
```

### Transition 2 — `salesHandoff`
```
The user explicitly wants to purchase a course, complete enrollment,
or requests to speak with a sales advisor.
Before transitioning:
- Store the course name in {{conversation.salesCourseName}}.
- Store a one-sentence Arabic summary in {{conversation.handoffSummary}}.
- Do NOT send any message before transitioning.
- Transition IMMEDIATELY once both variables are set.
```

---

## 3. Standard Node «complaintHandoff» — 6 كروت

### Card 1 — Execute Code «setCwConvId»

> **الإصلاح المهم:** في Execute Code تاجات اليوزر بتيجي من `event.tags.user`
> مش من `user.tags` — ده كان سبب `cwConvId not found`.

```typescript
const c = conversation as any;

let cwConvId = '';

// PRIMARY: read from event.tags.user (correct path in Botpress Execute Code)
try {
  const profileStr = (event as any)?.tags?.user?.['chat:profile'] || '{}';
  const profile = JSON.parse(profileStr);
  cwConvId = String(profile._cw || '');
} catch (_) {}

// FALLBACK: try user object directly (in case API changes)
if (!cwConvId) {
  try {
    const profileStr = (user as any)?.tags?.['chat:profile'] || '{}';
    const profile = JSON.parse(profileStr);
    cwConvId = String(profile._cw || '');
  } catch (_) {}
}

if (cwConvId) {
  c.cwConvId = cwConvId;
  console.log('cwConvId set:', cwConvId);
} else {
  console.log('cwConvId not found — Chatwoot calls will be skipped');
}
```

### Card 2 — Execute Code «buildSummary»

```typescript
const c = conversation as any;

let transcript = '';
try {
  const { messages } = await client.listMessages({
    conversationId: event.conversationId
  });
  transcript = (messages || [])
    .slice(-8)
    .map((m: any) => {
      const role = m.userId === event.userId ? 'User' : 'Bot';
      const text = m.payload?.text || '';
      return text ? `${role}: ${text}` : null;
    })
    .filter(Boolean)
    .join('\n');
} catch (err: any) {
  console.log('transcript error:', err.message);
}

const llmSummary = c.handoffSummary || '';
const courseName  = c.salesCourseName || '';

const lines: string[] = ['📋 Majed Bot Summary:'];
if (llmSummary) lines.push(`Issue: ${llmSummary}`);
if (courseName)  lines.push(`Course Interest: ${courseName}`);
if (transcript)  { lines.push(''); lines.push('📝 Last Messages:'); lines.push(transcript); }

c.chatwootPrivateNote = lines.join('\n').slice(0, 2000);
console.log('Summary built:', c.chatwootPrivateNote.length, 'chars');
```

### Card 3 — Execute Code «sendPrivateNote»

```typescript
const c = conversation as any;

const cwConvId = c.cwConvId || '';
if (!cwConvId) {
  console.log('No cwConvId — skipping private note');
} else {
  const BASE  = 'https://chat.engosoft.com/api/v1/accounts/2';
  const TOKEN = 'REPLACE_WITH_CHATWOOT_API_TOKEN';  // Chatwoot → Profile → Access Token

  try {
    await axios.post(
      `${BASE}/conversations/${cwConvId}/messages`,
      {
        content:      c.chatwootPrivateNote || c.handoffSummary || 'Customer requested human agent.',
        private:      true,
        message_type: 'outgoing'
      },
      {
        headers: { 'api_access_token': TOKEN, 'Content-Type': 'application/json' },
        timeout: 10000
      }
    );
    console.log('Private note sent, conv:', cwConvId);
  } catch (err: any) {
    console.log('Private note failed:', err.response?.data || err.message);
  }
}
```

### Card 4 — Execute Code «openAndAssign»

التعيين الأول وبعدين الفتح — عشان الموظف يلاقيها معيّنة من أول لحظة.

```typescript
const c = conversation as any;

const cwConvId = c.cwConvId || '';
if (!cwConvId) {
  console.log('No cwConvId — skipping assign+open');
} else {
  const BASE    = 'https://chat.engosoft.com/api/v1/accounts/2';
  const TOKEN   = 'REPLACE_WITH_CHATWOOT_API_TOKEN';  // same token as sendPrivateNote
  const TEAM_ID = 2;                                   // Moderation Team
  const headers = { 'api_access_token': TOKEN, 'Content-Type': 'application/json' };

  // Step 1: assign to team
  try {
    await axios.post(
      `${BASE}/conversations/${cwConvId}/assignments`,
      { team_id: TEAM_ID },
      { headers, timeout: 10000 }
    );
    console.log('Assigned team:', TEAM_ID, 'conv:', cwConvId);
  } catch (err: any) {
    console.log('Assign failed:', err.response?.data || err.message);
  }

  // Step 2: open conversation (bridge will stop forwarding to bot while status=open)
  try {
    await axios.post(
      `${BASE}/conversations/${cwConvId}/toggle_status`,
      { status: 'open' },
      { headers, timeout: 10000 }
    );
    console.log('Conversation opened:', cwConvId);
  } catch (err: any) {
    console.log('Status toggle failed:', err.response?.data || err.message);
  }
}
```

### Card 5 — Send Email (كارت Botpress الجاهز)

| الحقل | القيمة |
|-------|--------|
| To | `mahfouz.mohamed@engosoft.com` |
| Subject | `شكوى جديدة من {{workflow.userFullName}}` |
| Reply To | `{{workflow.userEmail}}` |

**Body:**
```
شكوى جديدة عبر ماجد

المتدرب: {{workflow.userFullName}}
الإيميل: {{workflow.userEmail}}
الموبايل: {{workflow.userPhone}}

ملخص المشكلة:
{{conversation.handoffSummary}}

---
تم الإرسال تلقائياً من ماجد — إنجوسوفت
```

### Card 6 — Text

```
تم تحويلك لفريق خدمة العملاء، سيتواصل معك أحد المختصين قريباً. 🙌
```

بعد الكارت الأخير: transition «always» → الـ Autonomous Node.

---

## 4. Standard Node «salesHandoff» — 5 كروت

نفس كروت complaintHandoff **1 → 4 بالظبط** (انسخهم زي ما هم)، من غير كارت الإيميل،
وكارت النص الأخير:

### Card 5 — Text
```
تم تحويلك لفريق المبيعات، سيتواصل معك مستشار قريباً. 🎯
```

بعده: transition «always» → الـ Autonomous Node.

---

## 5. ليه «المحادثة تتفتح» و«البوت ما يتدخلش» بعدها؟

- `openAndAssign` بيحوّل المحادثة في شاتووت لـ **open** → البريدج عنده قاعدة:
  أي محادثة status=open **ما يبعتش** رسائل العميل للبوت (`SKIP bot (agent handling)`).
  يعني الموظف بياخد المحادثة والبوت ساكت — من غير أي إعداد إضافي.
- لما الموظف يخلّص ويرجّع الحالة **pending** (أو resolved والعميل يكتب تاني)،
  البريدج يرجع يوجّه للبوت تلقائيًا.
- في غير حالات الـ handoff المحادثة فاضلة **pending** → البوت هو اللي بيرد،
  والمحادثة **ما تتفتحش** على الفريق من نفسها أبدًا.

---

## 6. حالة الريبو / Railway

| المكان | التغيير | الحالة |
|--------|---------|--------|
| `integration/bridge/index.js` | `bpCreateUser` بيحقن `_cw` في بروفايل اليوزر | ✅ موجود |
| `integration/bridge/index.js` | `ensureBotpress` بيمرر `cwConvId` | ✅ موجود |
| Railway | push → redeploy تلقائي (Root Dir = `integration/bridge`) | بعد أي تعديل |
| Botpress Studio | الخطوات أعلاه | يدوي في Studio |

**مفيش env vars جديدة مطلوبة في Railway لفلو الـ handoff.**
توكن شاتووت بيتحط جوّه كروت Execute Code نفسها.

---

## 7. Checklist الاختبار (من الويدجت الحقيقي — مش الـ Emulator)

> الـ Emulator ما بيعدّيش على البريدج → مفيش محادثة شاتووت → `_cw` فاضي →
> كل نداءات شاتووت هتتعمل skip. جرّب دايمًا من demo.engosoft.com.

ابعت شكوى (مثلاً «الفيديو مش شغال عايز أقدم شكوى») وتابع Botpress Logs بالترتيب:

- [ ] `cwConvId set: <رقم>` — setCwConvId اشتغل
- [ ] `Summary built: <N> chars` — buildSummary اشتغل
- [ ] `Private note sent, conv: <رقم>` — البرايفت نوت وصلت
- [ ] `Assigned team: 2 conv: <رقم>` — التعيين تم
- [ ] `Conversation opened: <رقم>` — المحادثة اتفتحت
- [ ] في شاتووت: المحادثة Open + معيّنة على Moderation Team + فيها البرايفت نوت
- [ ] ابعت رسالة تانية من الويدجت → في لوجز Railway تلاقي `SKIP bot (agent handling, status=open)` — البوت ساكت صح

**لو ظهر `cwConvId not found`:**
- اتأكد إن آخر نسخة bridge متنشرة على Railway (التغيير بتاع `_cw`).
- في Botpress Logs دوّر على `"chat:profile"` في الـ EVENT — لازم يكون فيه `"_cw":"<رقم>"`.

**لو البرايفت نوت رجعت 401:** التوكن غلط/منتهي → Chatwoot → Profile → Access Token →
Regenerate وحدّثه في الكارتين (في النودين = 4 أماكن).

**لو التعيين رجع 404:** يا إما `cwConvId` غلط يا إما بتجرّب من الـ Emulator.
