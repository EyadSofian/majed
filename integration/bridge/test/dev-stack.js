/**
 * Local dev stack for browser-testing the «نور» widget against a fake
 * Chatwoot + fake Botpress Chat API — no real secrets, no real services.
 *
 *   node test/dev-stack.js     → http://localhost:4810/test.html
 *
 * The fake bot replies "رد البوت: <text>"; sending "اختيارات" returns choice
 * buttons (to verify label-vs-value behaviour in the bubble).
 */

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');

const MOCK_PORT = 4811;
const BRIDGE_PORT = 4812;
const PAGE_PORT = process.env.PORT || 4810;

let sseRes = null;
let msgSeq = 5000;

// ── fake Chatwoot + fake Botpress Chat API ──
const mock = express();
mock.use(express.json());
mock.get('/api/v1/accounts/2/inboxes', (_q, r) =>
  r.json({ payload: [{ id: 29, inbox_identifier: 'IDENT', channel_type: 'Channel::Api', name: 'Majed ai' }] }));
mock.post('/api/v1/accounts/2/contacts', (_q, r) =>
  r.json({ payload: { contact: { id: 1, contact_inboxes: [{ source_id: 'src-1' }] }, contact_inbox: { source_id: 'src-1' } } }));
mock.post('/api/v1/accounts/2/conversations', (_q, r) => r.json({ id: 9001 }));
mock.post('/api/v1/accounts/2/conversations/:id/messages', (q, r) =>
  r.json({ id: ++msgSeq, content: q.body.content, message_type: q.body.message_type, content_type: q.body.content_type, content_attributes: q.body.content_attributes }));
mock.get('/api/v1/accounts/2/conversations/:id', (_q, r) => r.json({ id: 9001, status: 'pending', custom_attributes: {} }));
mock.post('/api/v1/accounts/2/conversations/:id/custom_attributes', (_q, r) => r.json({ ok: true }));
mock.post('/api/v1/accounts/2/conversations/:id/toggle_status', (_q, r) => r.json({ ok: true }));
mock.post('/api/v1/accounts/2/conversations/:id/assignments', (_q, r) => r.json({ ok: true }));
mock.post('/bp/wh1/users', (_q, r) => r.json({ user: { id: 'user-widget' }, key: 'key-1' }));
mock.post('/bp/wh1/conversations', (_q, r) => r.json({ conversation: { id: 'bpconv-1' } }));
mock.post('/bp/wh1/messages', (q, r) => {
  const text = q.body?.payload?.text || '';
  const userText = text.split('\n\n').pop();
  r.status(201).json({ message: { id: 'm' + Date.now() } });
  setTimeout(() => {
    let payload;
    if (userText.includes('اختيارات')) payload = { type: 'choice', text: 'اختار اللي يناسبك:', options: [{ label: 'مسار هندسي', value: 'engineering' }, { label: 'مسار إداري', value: 'management' }] };
    else payload = { type: 'text', text: 'رد البوت: ' + userText };
    if (sseRes) sseRes.write(`data: ${JSON.stringify({ type: 'message_created', data: { id: 'bot-' + Date.now(), userId: 'bot-1', conversationId: 'bpconv-1', payload } })}\n\n`);
  }, 150);
});
mock.get('/bp/wh1/conversations/bpconv-1/listen', (_q, r) => {
  r.setHeader('Content-Type', 'text/event-stream');
  r.flushHeaders();
  r.write('retry: 1000\n\n');
  sseRes = r;
});
mock.listen(MOCK_PORT, () => console.log(`mock chatwoot+botpress on :${MOCK_PORT}`));

// ── bridge (spawned with mock env) ──
const bridge = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
  env: {
    ...process.env,
    PORT: String(BRIDGE_PORT),
    CHATWOOT_BASE_URL: `http://localhost:${MOCK_PORT}`,
    CHATWOOT_ACCOUNT_ID: '2',
    CHATWOOT_API_TOKEN: 'dev-token',
    CHATWOOT_INBOX_ID: '29',
    BOTPRESS_CHAT_API_BASE: `http://localhost:${MOCK_PORT}/bp`,
    BOTPRESS_CHAT_WEBHOOK_ID: 'wh1',
    WIDGET_ORIGIN: '*',
    WELCOME_ENABLED: 'true',
  },
  stdio: 'inherit',
});
process.on('exit', () => bridge.kill());

// ── test page ──
const page = express();
page.get('/test.html', (_q, r) => {
  r.type('html').send(`<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"/><title>Majed widget dev</title></head>
<body style="height:100vh;margin:0;background:#eef2f9">
<h3 style="font-family:sans-serif;padding:16px">صفحة اختبار ويدجت ماجد (mock كامل) — افتح الشات وجرّب «اختيارات»</h3>
<script>
  window.MajedConfig = {
    bridgeUrl: 'http://localhost:${BRIDGE_PORT}',
    userContextUrl: '/fake-user-context',
    theme: 'light'
  };
</script>
<script src="http://localhost:${BRIDGE_PORT}/majed-widget.js"></script>
</body></html>`);
});
// fake logged-in Odoo user context (same shape as /ai_webhook/user_context)
page.get('/fake-user-context', (_q, r) =>
  r.json({
    user: { name: 'إياد سفيان', email: 'eyad@example.com', user_id: 7 },
    learning_progress: { total_courses_enrolled: 2, total_remaining_lessons: 7, average_progress: 64 },
    courses: [{ course_name: 'التصميم الداخلي', progress_percentage: 64, remaining_lessons: 7 }],
  }));
page.listen(PAGE_PORT, () => console.log(`test page on http://localhost:${PAGE_PORT}/test.html`));
