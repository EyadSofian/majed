const assert = require('assert');
const { extractAssignee, Takeover } = require('../takeover');
const { notify, compose, setHttp } = require('../notify');

assert.deepStrictEqual(
  extractAssignee({ event: 'assignee_changed', assignee: { id: 17 } }),
  { present: true, id: 17 }
);
assert.deepStrictEqual(
  extractAssignee({ event: 'assignee_changed', assignee: null }),
  { present: true, id: null }
);
assert.deepStrictEqual(
  extractAssignee({ event: 'conversation_updated', changed_attributes: [
    { assignee_id: { previous_value: null, current_value: 23 } },
  ] }),
  { present: true, id: 23 }
);
assert.deepStrictEqual(
  extractAssignee({ event: 'conversation_updated', changed_attributes: [{ labels: [] }] }),
  { present: false, id: null }
);

const takeover = new Takeover(true);
assert.strictEqual(takeover.isAssigned('9001'), false);
assert.strictEqual(takeover.apply('9001', 17), true);
assert.strictEqual(takeover.isAssigned(9001), true);
assert.strictEqual(takeover.apply('9001', 17), false);
assert.strictEqual(takeover.apply('9001', null), true);
assert.strictEqual(takeover.isAssigned('9001'), false);

const live = compose('live_chat', { name: 'أحمد', message: 'عايز مساعدة', convId: 9001 });
assert.ok(live.subject.includes('أحمد'));
assert.ok(live.text.includes('عايز مساعدة'));

(async () => {
  const requests = [];
  setHttp(async (url, body, options) => {
    requests.push({ url, body, options });
    return { status: 200 };
  });
  const config = {
    notifyWebhookUrl: 'https://n8n.example/webhook/majed',
    notifyWebhookToken: 'token',
    notifyOnLiveChat: true,
    notifyOnHandoff: true,
  };
  const result = await notify(config, 'live_chat', { name: 'أحمد', convId: 9001 });
  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.via, 'webhook');
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].body.kind, 'live_chat');
  assert.strictEqual(requests[0].options.headers['X-Notify-Token'], 'token');

  const disabled = await notify({ ...config, notifyOnLiveChat: false }, 'live_chat', {});
  assert.strictEqual(disabled.reason, 'disabled');
  assert.strictEqual(requests.length, 1);

  setHttp(undefined);
  console.log('✅ takeover + notification tests passed');
})().catch((error) => {
  console.error('❌', error.message);
  process.exit(1);
});
