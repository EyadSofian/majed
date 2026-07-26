/**
 * Unit tests for the two new bridge modules — no server, no network:
 *   - takeover: parsing Chatwoot assignment payloads + the pause state machine
 *   - notify:   the alert wording (compose) + the send-decision matrix
 *
 *   node test/notify-takeover.test.js
 */
const assert = require('assert');
const { extractAssignee, Takeover } = require('../takeover');
const { chatwootSafeAttrs } = require('../cw-cards');
const notify = require('../notify');

// ───────────────────────── takeover: parsing ─────────────────────────
(function assigneeParsing() {
  // assignee_changed with a full assignee object
  assert.deepStrictEqual(
    extractAssignee({ event: 'assignee_changed', assignee: { id: 5, name: 'Sara' } }),
    { present: true, id: 5 });
  // explicit unassignment
  assert.deepStrictEqual(extractAssignee({ assignee: null }), { present: true, id: null });
  // meta.assignee shape (nested on conversation)
  assert.deepStrictEqual(
    extractAssignee({ conversation: { meta: { assignee: { id: 8 } } } }),
    { present: true, id: 8 });
  // conversation_updated carrying assignee_id in changed_attributes
  assert.deepStrictEqual(
    extractAssignee({ event: 'conversation_updated',
      changed_attributes: [{ assignee_id: { previous_value: null, current_value: 12 } }] }),
    { present: true, id: 12 });
  // conversation_updated about something else (a label) → says nothing
  assert.deepStrictEqual(
    extractAssignee({ event: 'conversation_updated',
      changed_attributes: [{ labels: { current_value: ['vip'] } }] }),
    { present: false, id: null });
  console.log('✅ takeover.extractAssignee: 5 shapes parsed (assign / unassign / meta / updated / noise)');
})();

// ─────────────────────── takeover: state machine ─────────────────────
(function takeoverStateMachine() {
  const t = new Takeover(true);
  assert.strictEqual(t.isAssigned('42'), false);
  assert.strictEqual(t.apply('42', 5), true);      // agent grabs it
  assert.strictEqual(t.isAssigned('42'), true);    // → bot paused
  assert.strictEqual(t.isAssigned(42), true);       // number/string agnostic
  assert.strictEqual(t.apply('42', 5), false);     // same assignee again → no change
  assert.strictEqual(t.apply('42', null), true);   // unassigned → resumes
  assert.strictEqual(t.isAssigned('42'), false);
  // clear() (resolved ticket)
  t.apply('43', 9);
  t.clear('43');
  assert.strictEqual(t.isAssigned('43'), false);
  // disabled instance never pauses
  const off = new Takeover(false);
  assert.strictEqual(off.apply('1', 5), false);
  assert.strictEqual(off.isAssigned('1'), false);
  console.log('✅ takeover.Takeover: assign pauses, unassign/clear resume, disabled is inert');
})();

// ──────────────── cw-cards: Chatwoot card sanitiser ───────────────────
(function chatwootCards() {
  // A rich نبراس course card: Chatwoot only accepts title/description/media_url/actions.
  const rich = {
    items: [
      { kind: 'course', course_id: 2107, title: 'Navisworks MEP', price_display: '4,815 EGP',
        currency: 'EGP', instructor: 'x', delivery: 'مسجّل', checkout_url: 'https://x',
        media_url: 'https://img', description: '4,815 EGP · مسجّل',
        actions: [{ type: 'link', text: 'اشترِ الآن', uri: 'https://x' }] },
      { kind: 'package', package_id: 6, title: 'Mechanical Track', price_from_display: 'يبدأ من 10,000 EGP',
        options: [{ label: 'مسجّل', price_display: '10,000 EGP' }], media_url: '',
        description: 'يبدأ من 10,000 EGP · 6 كورس', actions: [] },
    ],
  };
  const safe = chatwootSafeAttrs(rich);
  const allowed = new Set(['title', 'description', 'media_url', 'actions']);
  for (const it of safe.items) {
    for (const k of Object.keys(it)) assert.ok(allowed.has(k), `leaked key ${k}`);
    assert.ok(it.title, 'title kept');
  }
  // the widget-facing copy is never mutated
  assert.strictEqual(rich.items[0].course_id, 2107);
  // input_select choices pass through untouched (already Chatwoot-safe)
  const choices = { items: [{ title: 'ميكانيكا', value: 'أنا في تخصص Mechanical' }] };
  assert.deepStrictEqual(chatwootSafeAttrs(choices), choices);
  // non-card attrs (e.g. a plain bp_id) are returned as-is
  assert.deepStrictEqual(chatwootSafeAttrs({ bp_id: 'x' }), { bp_id: 'x' });
  console.log('✅ cw-cards.chatwootSafeAttrs: strips rich keys for Chatwoot, keeps choices/plain attrs');
})();

// ─────────────────────────── notify: compose ─────────────────────────
(function composeWording() {
  const live = notify.compose('live_chat', { name: 'منى', message: 'عايزة كورس', convId: 9001 });
  assert.ok(live.subject.includes('منى') && live.subject.includes('🟢'));
  assert.ok(live.text.includes('عايزة كورس'));

  const lead = notify.compose('lead', {
    name: 'أحمد', phone: '0100', field: 'Mechanical',
    specialization: 'HVAC', experience: '3',
  });
  assert.ok(lead.subject.includes('أحمد'));
  assert.ok(lead.text.includes('المجال: Mechanical'));
  assert.ok(lead.text.includes('التخصص: HVAC'));
  assert.ok(lead.text.includes('سنوات الخبرة: 3'));

  const h = notify.compose('handoff', { reason: 'price_objection', summary: 'اعترض على السعر' });
  assert.ok(h.subject.includes('price_objection'));
  assert.ok(h.text.includes('اعترض على السعر'));
  // absent fields are simply omitted, never printed as "undefined"
  assert.ok(!notify.compose('lead', { name: 'x' }).text.includes('undefined'));
  console.log('✅ notify.compose: live_chat / lead / handoff wording, no undefined leakage');
})();

// ──────────────────────── notify: send decision ──────────────────────
(async function sendDecision() {
  const base = {
    notifyEmailTo: 'ops@engosoft.com', notifyEmailFrom: 'majed@engosoft.com',
    notifyOnLiveChat: true, notifyOnLead: true, notifyOnHandoff: true,
  };
  const sent = [];
  notify.setTransport({ sendMail: async (m) => { sent.push(m); return { messageId: '1' }; } });

  // happy path → sent, and the recipient/subject are wired through
  let r = await notify.notify(base, 'lead', { name: 'أحمد', phone: '0100' });
  assert.strictEqual(r.sent, true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, 'ops@engosoft.com');
  assert.strictEqual(sent[0].from, 'majed@engosoft.com');
  assert.ok(sent[0].subject.includes('أحمد'));

  // this kind toggled off → not sent
  r = await notify.notify({ ...base, notifyOnLead: false }, 'lead', { name: 'x', phone: '1' });
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.reason, 'disabled');

  // no recipient configured → not sent
  r = await notify.notify({ ...base, notifyEmailTo: '' }, 'handoff', {});
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.reason, 'no_recipient');

  // a transport failure never throws — it comes back as a reason
  notify.setTransport({ sendMail: async () => { throw new Error('smtp down'); } });
  r = await notify.notify(base, 'live_chat', { name: 'x' });
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.reason, 'smtp down');

  // no SMTP host + no injected transport → inert (no_transport), still no throw
  notify.setTransport(undefined);
  r = await notify.notify(base, 'live_chat', { name: 'x' });
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.reason, 'no_transport');

  console.log('✅ notify.notify: sends when on, respects toggles/recipient, never throws');
})()
// ─────────────── notify: n8n webhook path takes priority ──────────────
.then(async function webhookPath() {
  const posted = [];
  notify.setHttp(async (url, body, opts) => { posted.push({ url, body, opts }); return { status: 200 }; });
  const cfg = {
    notifyWebhookUrl: 'https://n8n.example/webhook/majed',
    notifyWebhookToken: 'secret',
    notifyOnLead: true, notifyOnHandoff: true, notifyOnLiveChat: true,
    // SMTP is also present, but the webhook must win — no email is built
    notifyEmailTo: 'ops@x.com', smtpHost: 'smtp.x.com',
  };
  let r = await notify.notify(cfg, 'lead', { name: 'أحمد', phone: '0100', field: 'BIM' });
  assert.strictEqual(r.sent, true);
  assert.strictEqual(r.via, 'webhook');
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].url, 'https://n8n.example/webhook/majed');
  assert.strictEqual(posted[0].body.kind, 'lead');
  assert.strictEqual(posted[0].body.field, 'BIM');           // raw data travels too
  assert.ok(posted[0].body.subject.includes('أحمد'));
  assert.strictEqual(posted[0].opts.headers['X-Notify-Token'], 'secret');

  // a disabled kind never posts, even with a webhook set
  r = await notify.notify({ ...cfg, notifyOnLead: false }, 'lead', { name: 'x' });
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.reason, 'disabled');
  assert.strictEqual(posted.length, 1);

  // a webhook failure is swallowed, never thrown
  notify.setHttp(async () => { throw new Error('n8n 500'); });
  r = await notify.notify(cfg, 'handoff', { reason: 'x' });
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.reason, 'n8n 500');

  notify.setHttp(undefined); // restore
  console.log('✅ notify.notify: n8n webhook path wins over SMTP, carries data, never throws');
}).then(() => {
  console.log('\nRESULT: notify + takeover unit tests passed');
}).catch((e) => {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
});
