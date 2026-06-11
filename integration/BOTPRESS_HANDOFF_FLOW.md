# Botpress Handoff Flow — Majed

> Complaint and sales handoff: Botpress calls Chatwoot API directly (private note + assign team + open).
> No bridge involvement. No Railway env vars needed for this flow.

---

## Flow Structure

```
Start Node
    ↓ (once, first message only)
Standard Node "init"
    └── Execute Code "setCwConvId"
    ↓
Autonomous Node "Majed"
    ├── Transition 1: handoffComplaint  ← most specific, TOP
    ├── Transition 2: handoffSales
    └── (stays here for all normal messages)
         ↓ (on any transition)
Standard Node "handoffToAgent"
    ├── Execute Code "buildSummary"
    ├── Execute Code "sendPrivateNote"
    ├── Execute Code "openAndAssign"
    └── Text Card (user-facing confirmation)
         ↓
    back to Autonomous Node (bot stays in standby, bridge blocks it while status=open)
```

---

## Required Workflow Variables

Declare these in the workflow before using them (Botpress Studio → Variables):

| Name | Type | Set by |
|------|------|--------|
| `cwConvId` | string | Execute Code (init) |
| `handoffSummary` | string | Autonomous Node (LLM) |
| `salesCourseName` | string | Autonomous Node (LLM) |
| `chatwootPrivateNote` | string | Execute Code (buildSummary) |

---

## 1. Standard Node "init" — Execute Code "setCwConvId"

Runs once at conversation start. Reads `_cw` from the Botpress user profile
(the bridge embeds it there at user-creation time).

```typescript
const u = user as any;
const w = workflow as any;

let cwConvId = '';
try {
  const profile = JSON.parse(u?.tags?.['chat:profile'] || '{}');
  cwConvId = profile._cw || '';
} catch (_) {}

if (cwConvId) {
  w.cwConvId = cwConvId;
  console.log('cwConvId set:', cwConvId);
} else {
  console.log('cwConvId not in profile — Chatwoot calls will be skipped');
}
```

Transition after this node: always → Autonomous Node "Majed".

---

## 2. Autonomous Node "Majed" — Transitions

Add these two transitions. **Order matters — put handoffComplaint first.**

### Transition 1 — `handoffComplaint` (TOP, most specific)

**Condition (natural language):**
```
The user has a complaint, reports a technical problem, requests a refund,
has a certificate issue, cannot log in, has a lecture or instructor problem,
or any issue that requires human intervention.

Before transitioning:
- Store a one-sentence Arabic summary of the issue in {{workflow.handoffSummary}}.
- Do NOT send any message to the user before transitioning.
- Transition IMMEDIATELY once handoffSummary is set.
```

### Transition 2 — `handoffSales`

**Condition (natural language):**
```
The user explicitly wants to purchase a course, complete enrollment,
or asks to speak with a sales advisor.

Before transitioning:
- Store the course name in {{workflow.salesCourseName}}.
- Store a one-sentence Arabic summary in {{workflow.handoffSummary}}.
- Do NOT send any message before transitioning.
- Transition IMMEDIATELY once both variables are set.
```

---

## 3. Standard Node "handoffToAgent" — 4 Cards

### Card 1 — Execute Code "buildSummary"

Builds the private note text from conversation history + LLM summary.

```typescript
const u = user as any;
const w = workflow as any;

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

const llmSummary = w.handoffSummary || '';
const courseName  = w.salesCourseName || '';

const lines: string[] = ['📋 Majed Bot Summary:'];
if (llmSummary) lines.push(`Issue: ${llmSummary}`);
if (courseName)  lines.push(`Course Interest: ${courseName}`);
if (transcript)  { lines.push(''); lines.push('📝 Last Messages:'); lines.push(transcript); }

w.chatwootPrivateNote = lines.join('\n').slice(0, 2000);
console.log('Summary built:', w.chatwootPrivateNote.length, 'chars');
```

---

### Card 2 — Execute Code "sendPrivateNote"

Posts the private note to the Chatwoot conversation (visible only to agents).

```typescript
const u = user as any;
const w = workflow as any;

const cwConvId = w.cwConvId || '';
if (!cwConvId) {
  console.log('No cwConvId — skipping private note');
} else {
  const BASE  = 'https://chat.engosoft.com/api/v1/accounts/2';
  // ⚠ Replace with your token (Profile → Access Token → Regenerate in Chatwoot)
  const TOKEN = 'REPLACE_WITH_CHATWOOT_API_TOKEN';

  try {
    await axios.post(
      `${BASE}/conversations/${cwConvId}/messages`,
      {
        content:      w.chatwootPrivateNote || w.handoffSummary || 'Customer requested human agent.',
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

---

### Card 3 — Execute Code "openAndAssign"

Assigns to Moderation Team (id=2) then opens the conversation.
**Always assign first, then open** — so the team sees it as assigned from the start.

```typescript
const u = user as any;
const w = workflow as any;

const cwConvId = w.cwConvId || '';
if (!cwConvId) {
  console.log('No cwConvId — skipping assign+open');
} else {
  const BASE    = 'https://chat.engosoft.com/api/v1/accounts/2';
  const TOKEN   = 'REPLACE_WITH_CHATWOOT_API_TOKEN'; // same token as Card 2
  const TEAM_ID = 2;                                 // Moderation Team
  const headers = { 'api_access_token': TOKEN, 'Content-Type': 'application/json' };

  // Step 1 — assign to team
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

  // Step 2 — open conversation (bridge will stop forwarding to bot while status=open)
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

---

### Card 4 — Text Card (user-facing)

```
تم تحويلك لفريق خدمة العملاء، سيتواصل معك أحد المختصين قريبًا. 🙌
```

---

## 4. Transition from "handoffToAgent" back to Autonomous Node

After Card 4 runs, add a transition (Standard Node → Autonomous Node).
Condition: `true` (always).

The bot stays in the Autonomous Node but receives no messages while the Chatwoot
conversation is `open` — the bridge skips forwarding to Botpress when status=open.
When an agent closes/resolves the conversation and it goes back to `pending`,
the bridge resumes forwarding and the Autonomous Node responds normally.

---

## 5. What needs to be done in Railway / Repo

| Location | Change | Status |
|----------|--------|--------|
| `integration/bridge/index.js` | `bpCreateUser` embeds `_cw` in user profile | ✅ Done (June 11) |
| `integration/bridge/index.js` | `ensureBotpress` passes `cwConvId` to `bpCreateUser` | ✅ Done (June 11) |
| Railway | Push → auto-redeploy (Root Dir = `integration/bridge`) | ⏳ Push needed |
| Botpress Studio | Add init Standard Node + Autonomous Node transitions + handoffToAgent node | ⏳ Manual in Studio |

**No new Railway env vars needed for this flow.**
The Chatwoot token is hardcoded in Execute Code (replace `REPLACE_WITH_CHATWOOT_API_TOKEN`).

---

## 6. Debugging checklist

After deploying, test by triggering a complaint:

- [ ] Botpress Logs → see `cwConvId set: <number>` on first message.
- [ ] Trigger handoff → see `Private note sent, conv: <number>` + `Assigned team: 2` + `Conversation opened: <number>`.
- [ ] In Chatwoot → conversation should show the private note, assigned to Moderation Team, status=open.
- [ ] If `cwConvId not in profile` appears in logs: push the bridge changes and redeploy Railway first.
