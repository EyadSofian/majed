# ⚠ متجاوز (Superseded) — لا تستخدم هذا الملف
>
> **هذا البريف كان مبنيًا على Webhook Integration trigger، وتم استبداله بالكامل
> بمسار Botpress Chat API الحقيقي. اتبع:** [`BOTPRESS_CHAT_API_SETUP.md`](BOTPRESS_CHAT_API_SETUP.md)
> — مفيش فلو خاص مطلوب جوه Botpress؛ أي Autonomous Node عادي بيرد تلقائيًا.

# فلو Botpress — عشان ماجد يرد (الطريق ب) [قديم]

> الناقص الوحيد دلوقتي. البريدج بيبعت رسالة العميل لـ Botpress، وبيستنى الرد على
> `https://majed-production-dd41.up.railway.app/botpress/webhook`. لازم نبني فلو في Botpress
> يستقبل الرسالة، يرد، ويبعت الرد للبريدج بالصيغة الصح.

---

## 1) إيه اللي البريدج بيبعته لـ Botpress (مهم عشان تقرأ الحقول الصح)

البريدج يعمل POST على `BOTPRESS_WEBHOOK_URL` (الـ Trigger Card URL) بالشكل ده:

```json
{
  "userId": "cw-widget-55520",
  "conversationId": "chatwoot-conv-55520",
  "type": "text",
  "text": "كيف حالك يا ماجد",
  "payload": { "type": "text", "text": "كيف حالك يا ماجد" },
  "userData": { "name": "...", "remaining_lessons": "7", "courses_json": "[...]" },
  "metadata": { "chatwootConvId": "55520" }
}
```

في Botpress الـ Trigger Card بيستقبلها في **`event.payload.body`**.

## 2) إيه اللي Botpress لازم يبعته للبريدج (صيغة الرد)

POST على `https://majed-production-dd41.up.railway.app/botpress/webhook`:

```json
{
  "conversationId": "chatwoot-conv-55520",
  "messages": [ { "text": "رد ماجد هنا" } ],
  "actions": [ { "type": "handoff", "team_id": 3 } ]
}
```
- `messages` ممكن تكون نص، أو كارت: `{ "content":"...", "content_type":"cards", "content_attributes":{...} }`
- `actions` اختياري (للتحويل لموظف).

---

## 3) الفلو في Botpress (4 نودات)

### النود 1 — Trigger Card
- نوعه: الـ **Webhook integration** اللي عندك (v0.2.3).
- الـ URL بتاعه = اللي حطيته في Railway: `BOTPRESS_WEBHOOK_URL=https://webhook.botpress.cloud/4e496ab3-…`
- ده **بداية الفلو**. (مهم: لازم يكون موصول بفلو فيه النودات اللي تحت — لو مفيش فلو، الرسالة بتوصل ومفيش رد = اللي بيحصل دلوقتي.)

### النود 2 — Execute Code: `captureIncoming`
```typescript
const w = workflow as any;
const c = conversation as any;

const body = (event as any).payload?.body || (event as any).payload || {};
const text = body.text || body.payload?.text || '';
const conv = body.conversationId || body.metadata?.chatwootConvId || '';

c.chatwootConvId = conv;            // "chatwoot-conv-55520"
c.trainee = body.userData || {};    // بيانات المتدرب (كورسات/تقدم)
w.userText = text;

// عشان الـ Autonomous Node يشوف رسالة العميل كـ input
(event as any).payload.text = text;
console.log('IN:', conv, '|', text);
```

### النود 3 — Autonomous Node: `Majed`
- **Allow Conversation = ON** (مهم جدًا، من غيرها البوت بيشتغل وميردش).
- **Instructions** (مثال):
```
انت «ماجد»، مستشار تعليمي لـ Engosoft، بتتكلم عربي بسيط وودود.
رسالة المتدرب: {{workflow.userText}}
بيانات المتدرب (لو متوفرة): {{conversation.trainee}}

- جاوب على سؤاله باختصار ووضوح.
- بعد ما تجاوب، خزّن نص ردّك بالكامل في المتغير workflow.replyText.
- لو طلب موظف بشري أو شكوى/ريسيل، حدّد workflow.handoffTeamId (3=مبيعات، 4=شكاوى)، غير كده خليه 0.
```
> ملاحظة من مرجع Botpress: الـ LLM أحيانًا بينسى يكتب المتغير (~70% نجاح). لو لقيت الرد بيتقطع، استخدم النسخة الأبسط تحت (القسم 4).

### النود 4 — Execute Code: `sendReplyToBridge`
```typescript
const w = workflow as any;
const c = conversation as any;
const BRIDGE = 'https://majed-production-dd41.up.railway.app/botpress/webhook';

const reply = (w.replyText || '').toString().trim();
const team = Number(w.handoffTeamId) || 0;

const out: any = { conversationId: c.chatwootConvId, messages: reply ? [{ text: reply }] : [] };
if (team > 0) out.actions = [{ type: 'handoff', team_id: team }];

try {
  await axios.post(BRIDGE, out, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
  console.log('OUT ->', c.chatwootConvId, '|', reply.slice(0, 40));
} catch (e: any) {
  console.log('bridge reply error:', e.message);
}
```

**ترتيب الفلو:** Trigger → captureIncoming → Majed (Autonomous) → sendReplyToBridge.

---

## 4) بديل أبسط وأضمن (لو الـ Autonomous Node بيلخبط)

من غير Autonomous Node — رد ثابت/KB بسيط للتجربة الأول، عشان تتأكد إن الحلقة شغّالة:

النود بعد captureIncoming = **Execute Code واحد** يرد على طول:
```typescript
const c = conversation as any;
const w = workflow as any;
const BRIDGE = 'https://majed-production-dd41.up.railway.app/botpress/webhook';
const reply = 'أهلاً 👋 أنا ماجد. وصلتني رسالتك: «' + (w.userText || '') + '». جاري المساعدة 💪';
try {
  await axios.post(BRIDGE, { conversationId: c.chatwootConvId, messages: [{ text: reply }] },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
} catch (e: any) { console.log('err', e.message); }
```
لو ده رجّع الرد للويدجت → الحلقة كاملة سليمة، وبعدها نحط الـ Autonomous Node مكانه.

---

## 5) Checklist تشخيص «مفيش رد»
- [ ] الـ Trigger Card موصول بفلو فيه النودات (مش طايف لوحده).
- [ ] `BOTPRESS_WEBHOOK_URL` في Railway = نفس URL الـ Trigger Card الحالي (`4e496ab3-…`).
- [ ] الـ Autonomous Node عنده **Allow Conversation = ON**.
- [ ] `sendReplyToBridge` بيبعت `conversationId` = `conversation.chatwootConvId` (مش فاضي).
- [ ] جرّب البديل البسيط (قسم 4) الأول لإثبات الحلقة.
- [ ] بعد النشر، شوف Botpress Logs: لازم تشوف `IN:` و `OUT ->`.

> الـ Agent Bot و Webhook integration في Chatwoot: **مش مطلوبين** — البريدج بيعمل دورهم.
