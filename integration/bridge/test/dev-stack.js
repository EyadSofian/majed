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
const zlib = require('zlib');
const { spawn } = require('child_process');

const MOCK_PORT = 4811;
const BRIDGE_PORT = 4812;
const PAGE_PORT = process.env.PORT || 4810;

// ── tiny PNG generator (no deps) — wide/tall gradient images for crop testing ──
function crc32(buf) {
  if (!crc32.t) {
    crc32.t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.t[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crc32.t[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc((1 + w * 3) * h);
  for (let y = 0; y < h; y++) {
    const rowAt = y * (1 + w * 3);
    for (let x = 0; x < w; x++) {
      const o = rowAt + 1 + x * 3;
      const grid = (Math.floor(x / 40) + Math.floor(y / 40)) % 2 ? 30 : 0; // شطرنج يبيّن أي قص/تشويه
      raw[o] = 90 + Math.round((x / w) * 140) + grid;
      raw[o + 1] = 70 + Math.round((y / h) * 150) + grid;
      raw[o + 2] = 220 - grid;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNG_WIDE = makePng(1600, 480);
const PNG_TALL = makePng(480, 1700);

let sseRes = null;
let msgSeq = 5000;
const cwMessages = []; // { convId, id, body } — feeds the widget transcript/history endpoints

// ── fake Chatwoot + fake Botpress Chat API ──
const mock = express();
mock.use(express.json());
mock.get('/api/v1/accounts/2/inboxes', (_q, r) =>
  r.json({ payload: [{ id: 29, inbox_identifier: 'IDENT', channel_type: 'Channel::Api', name: 'Majed ai' }] }));
mock.post('/api/v1/accounts/2/contacts', (_q, r) =>
  r.json({ payload: { contact: { id: 1, contact_inboxes: [{ source_id: 'src-1' }] }, contact_inbox: { source_id: 'src-1' } } }));
mock.post('/api/v1/accounts/2/conversations', (_q, r) => r.json({ id: 9001 }));
mock.post('/api/v1/accounts/2/conversations/:id/messages', (q, r) => {
  // multipart = attachment from the widget («اضافة ملفات»)
  if (String(q.headers['content-type'] || '').startsWith('multipart/')) {
    q.resume();
    q.on('end', () => {
      const id = ++msgSeq;
      cwMessages.push({ convId: q.params.id, id, body: { message_type: 'incoming', content: '', attachment: true } });
      r.json({ id, content: '', attachments: [{ id, file_type: 'image', data_url: `http://localhost:${MOCK_PORT}/up/${id}.png`, thumb_url: '', file_size: 4096 }] });
    });
    return;
  }
  const id = ++msgSeq;
  cwMessages.push({ convId: q.params.id, id, body: q.body });
  r.json({ id, content: q.body.content, message_type: q.body.message_type, content_type: q.body.content_type, content_attributes: q.body.content_attributes });
});
mock.get('/up/:f', (_q, r) => r.sendFile(path.join(__dirname, '..', 'public', 'majed-avatar.png')));
// صور اختبار العرض: عريضة/طويلة/بدون امتداد (نفس شكل روابط bpcontent) — و404 لاختبار الـ fallback
mock.get('/img/wide.png', (_q, r) => r.type('png').send(PNG_WIDE));
mock.get('/img/tall.png', (_q, r) => r.type('png').send(PNG_TALL));
mock.get('/img/noext', (_q, r) => r.type('png').send(PNG_WIDE));
mock.get('/api/v1/accounts/2/conversations/:id/messages', (q, r) => {
  const msgs = cwMessages
    .filter((x) => String(x.convId) === String(q.params.id))
    .map((x) => ({
      id: x.id,
      content: x.body.content || '',
      message_type: x.body.message_type === 'outgoing' ? 1 : 0,
      content_type: x.body.content_type || 'text',
      content_attributes: x.body.content_attributes || {},
      created_at: Math.floor(Date.now() / 1000),
      attachments: x.body.attachment ? [{ file_type: 'image', data_url: `http://localhost:${MOCK_PORT}/up/${x.id}.png`, file_size: 4096 }] : [],
    }));
  r.json({ payload: msgs.slice(-20) });
});
mock.get('/api/v1/accounts/2/conversations/:id', (_q, r) => {
  const last = cwMessages[cwMessages.length - 1];
  r.json({
    id: 9001, status: 'pending', custom_attributes: {},
    last_non_activity_message: last ? { content: last.body.content || '', created_at: Math.floor(Date.now() / 1000), attachments: last.body.attachment ? [{}] : [] } : null,
    last_activity_at: Math.floor(Date.now() / 1000),
  });
});
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
    const M = `http://localhost:${MOCK_PORT}`;
    if (userText.includes('اختيارات')) payload = { type: 'choice', text: 'اختار اللي يناسبك:', options: [{ label: 'مسار هندسي', value: 'engineering' }, { label: 'مسار إداري', value: 'management' }] };
    else if (userText.includes('صورة عريضة')) payload = { type: 'image', imageUrl: `${M}/img/wide.png`, title: 'صورة عريضة 1600×480' };
    else if (userText.includes('صورة طويلة')) payload = { type: 'image', imageUrl: `${M}/img/tall.png`, title: 'صورة طويلة 480×1700' };
    else if (userText.includes('بدون امتداد')) payload = { type: 'image', imageUrl: `${M}/img/noext` };
    else if (userText.includes('صورة مكسورة')) payload = { type: 'image', imageUrl: `${M}/img/missing-404.png`, title: 'صورة مكسورة' };
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
page.get('/test.html', (q, r) => {
  // ?avatar=broken → رابط مكسور كـ primary لاختبار سقوط الأفاتار على نسخة البريدج
  const avatarLine = q.query.avatar === 'broken'
    ? `avatarUrl: 'http://localhost:${MOCK_PORT}/img/missing-avatar.png',`
    : q.query.avatar === 'odoo'
      ? `avatarUrl: '/ai_user_context_webhook/static/src/img/majed-avatar.png',`
      : '';
  const blocks = Array.from({ length: 14 }, (_, i) =>
    `<section style="padding:42px 24px;background:${i % 2 ? '#dfe7f5' : '#eef2f9'}"><h2 style="font-family:sans-serif;margin:0 0 8px">قسم تجريبي ${i + 1}</h2><p style="font-family:sans-serif;color:#475569;max-width:680px;line-height:1.9">محتوى طويل لاختبار شفافية الويدجت أثناء تمرير الصفحة (Liquid Glass) — جرّب: «صورة عريضة» · «صورة طويلة» · «صورة بدون امتداد» · «صورة مكسورة» · «اختيارات»، واسحب الزر العائم أو الهيدر لتغيير المكان.</p></section>`
  ).join('');
  r.type('html').send(`<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Majed widget dev</title></head>
<body style="margin:0;background:#eef2f9">
<h3 style="font-family:sans-serif;padding:16px;margin:0">صفحة اختبار ويدجت ماجد (mock كامل)</h3>
${blocks}
<script>
  window.MajedConfig = {
    bridgeUrl: 'http://localhost:${BRIDGE_PORT}',
    userContextUrl: '/fake-user-context',
    ${avatarLine}
    theme: 'light'
  };
</script>
<script src="http://localhost:${BRIDGE_PORT}/majed-widget.js?v=dev"></script>
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
