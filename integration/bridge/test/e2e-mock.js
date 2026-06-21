/**
 * Mock end-to-end test for the Majed bridge (Chat API mode).
 * Spins up a fake Chatwoot + fake Botpress Chat API (with SSE), starts the bridge
 * against them, and verifies the full required test matrix — no real secrets.
 *
 * Run:  node test/e2e-mock.js
 */

const express = require('express');
const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const MOCK_PORT = 4801;
const BRIDGE_PORT = 4802;
const MOCK = `http://localhost:${MOCK_PORT}`;
const BRIDGE = `http://localhost:${BRIDGE_PORT}`;

// ─────────────────────────── mock server ───────────────────────────
const state = {
  cwMessages: [], // { convId, body, id }
  cwStatus: 'pending',
  cwAttrs: {},
  assignments: [],
  cwConversations: 0,
  cwUploads: 0,
  bpUsers: 0,
  bpConvs: 0,
  bpMessages: [], // { text, payload }
  sseRes: null, // botpress listen stream
  msgSeq: 1000,
};

function mockApp() {
  const m = express();
  m.use(express.json());

  // — Chatwoot —
  m.get('/api/v1/accounts/2/inboxes', (_q, r) =>
    r.json({ payload: [{ id: 29, inbox_identifier: 'IDENT', channel_type: 'Channel::Api', name: 'Majed ai' }] })
  );
  m.post('/api/v1/accounts/2/contacts', (q, r) =>
    r.json({ payload: { contact: { id: 1, contact_inboxes: [{ source_id: 'src-1' }] }, contact_inbox: { source_id: 'src-1' } } })
  );
  m.post('/api/v1/accounts/2/conversations', (_q, r) => {
    state.cwConversations++;
    r.json({ id: 9001 });
  });
  m.post('/api/v1/accounts/2/conversations/:id/messages', (q, r) => {
    // multipart = widget attachment upload (don't parse, just acknowledge like Chatwoot)
    if (String(q.headers['content-type'] || '').startsWith('multipart/')) {
      q.resume();
      q.on('end', () => {
        const id = ++state.msgSeq;
        state.cwUploads++;
        state.cwMessages.push({ convId: q.params.id, id, body: { message_type: 'incoming', content: '', attachment: true } });
        setTimeout(() => {
          axios.post(`${BRIDGE}/chatwoot/webhook`, {
            event: 'message_created', id, message_type: 'incoming', content: '',
            conversation: { id: Number(q.params.id), status: state.cwStatus }, sender: { name: 'Echo' },
          }).catch(() => {});
        }, 0);
        r.json({ id, content: '', attachments: [{ id: 1, file_type: 'image', data_url: `${MOCK}/up/${id}.png`, thumb_url: '', file_size: 321 }] });
      });
      return;
    }
    const id = ++state.msgSeq;
    state.cwMessages.push({ convId: q.params.id, id, body: q.body });
    if (q.body.message_type === 'incoming') {
      setTimeout(() => {
        axios.post(`${BRIDGE}/chatwoot/webhook`, {
          event: 'message_created',
          id,
          message_type: 'incoming',
          content: q.body.content,
          conversation: { id: Number(q.params.id), status: state.cwStatus },
          sender: { name: 'Echo' },
        }).catch(() => {});
      }, 0);
    }
    r.json({ id, content: q.body.content, message_type: q.body.message_type, content_type: q.body.content_type, content_attributes: q.body.content_attributes });
  });
  m.get('/api/v1/accounts/2/conversations/:id/messages', (q, r) => {
    const msgs = state.cwMessages
      .filter((x) => String(x.convId) === String(q.params.id))
      .map((x) => ({
        id: x.id,
        content: x.body.content || '',
        message_type: x.body.message_type === 'outgoing' ? 1 : 0,
        content_type: x.body.content_type || 'text',
        content_attributes: x.body.content_attributes || {},
        created_at: 1760000000,
        private: !!x.body.private,
        attachments: x.body.attachment ? [{ file_type: 'image', data_url: `${MOCK}/up/${x.id}.png`, file_size: 321 }] : [],
      }));
    r.json({ payload: msgs.slice(-20) });
  });
  m.get('/api/v1/accounts/2/conversations/:id', (_q, r) => {
    const lastMsg = state.cwMessages[state.cwMessages.length - 1];
    r.json({
      id: 9001,
      status: state.cwStatus,
      custom_attributes: state.cwAttrs,
      last_non_activity_message: lastMsg
        ? { content: lastMsg.body.content || '', created_at: 1760000000, attachments: lastMsg.body.attachment ? [{}] : [] }
        : null,
      last_activity_at: 1760000001,
    });
  });
  m.post('/api/v1/accounts/2/conversations/:id/custom_attributes', (q, r) => {
    Object.assign(state.cwAttrs, q.body.custom_attributes || {});
    r.json({ ok: true });
  });
  m.post('/api/v1/accounts/2/conversations/:id/toggle_status', (q, r) => {
    state.cwStatus = q.body.status;
    r.json({ ok: true });
  });
  m.post('/api/v1/accounts/2/conversations/:id/assignments', (q, r) => {
    state.assignments.push(q.body);
    r.json({ ok: true });
  });

  // — Botpress Chat API —
  m.post('/bp/wh1/users', (_q, r) => {
    state.bpUsers++;
    r.json({ user: { id: 'user-widget' }, key: 'key-1' });
  });
  m.post('/bp/wh1/conversations', (_q, r) => {
    state.bpConvs++;
    r.json({ conversation: { id: 'bpconv-1' } });
  });
  m.post('/bp/wh1/messages', (q, r) => {
    const text = q.body?.payload?.text || '';
    state.bpMessages.push({ text, payload: q.body?.payload });
    r.status(201).json({ message: { id: 'm' + state.bpMessages.length } });
    // bot "thinks" then replies over SSE. Like a real LLM, it answers the customer's
    // message (the last block) — the injected context preamble is background info.
    const userText = text.split('\n\n').pop();
    setTimeout(() => {
      let payload;
      if (userText.includes('موظف')) payload = { type: 'text', text: '[[HANDOFF:3]] حوّلتك لزميل بشري' };
      else if (userText.includes('اختيارات')) payload = { type: 'choice', text: 'اختار اللي يناسبك:', options: [{ label: 'مسار هندسي', value: 'engineering' }, { label: 'مسار إداري', value: 'management' }] };
      else if (userText.includes('بدون امتداد')) payload = { type: 'image', imageUrl: 'https://files.bpcontent.cloud/2026/06/10/img-no-ext' };
      else if (userText.includes('صورة')) payload = { type: 'image', imageUrl: 'https://example.com/majed.png', title: 'صورة توضيحية' };
      else payload = { type: 'text', text: 'رد البوت: ' + userText };
      sseSend({ type: 'message_created', data: { id: 'bot-' + Date.now(), userId: 'bot-1', conversationId: 'bpconv-1', payload } });
    }, 120);
  });
  m.get('/bp/wh1/conversations/bpconv-1/listen', (q, r) => {
    r.setHeader('Content-Type', 'text/event-stream');
    r.flushHeaders();
    r.write('retry: 1000\n\n');
    state.sseRes = r;
  });

  m.get('/__state', (_q, r) => r.json({ ...state, sseRes: undefined }));
  return m;
}

function sseSend(obj) {
  if (state.sseRes) state.sseRes.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// ─────────────────────────── helpers ───────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// minimal SSE client for the widget stream
function widgetStream(convId) {
  const events = [];
  const req = http.get(`${BRIDGE}/widget/stream?conversationId=${convId}`, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (data) { try { events.push(JSON.parse(data)); } catch (_) {} }
      }
    });
  });
  return { events, close: () => req.destroy() };
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

// ─────────────────────────── run ───────────────────────────
(async () => {
  const mock = mockApp().listen(MOCK_PORT);
  const subscribeStore = path.join(__dirname, 'tmp-subscribers.jsonl');
  try { fs.unlinkSync(subscribeStore); } catch (_) {}

  const bridge = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(BRIDGE_PORT),
      CHATWOOT_BASE_URL: MOCK,
      CHATWOOT_ACCOUNT_ID: '2',
      CHATWOOT_API_TOKEN: 'test-token',
      CHATWOOT_INBOX_ID: '29',
      BOTPRESS_CHAT_API_BASE: `${MOCK}/bp`,
      BOTPRESS_CHAT_WEBHOOK_ID: 'wh1',
      WIDGET_ORIGIN: 'https://demo.engosoft.com',
      WELCOME_ENABLED: 'false',
      SUBSCRIBE_ADMIN_TOKEN: 'admin-token',
      SUBSCRIBE_STORE_FILE: subscribeStore,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stdout.on('data', (d) => process.stdout.write('  [bridge] ' + d));
  bridge.stderr.on('data', (d) => process.stdout.write('  [bridge!] ' + d));
  await sleep(900);

  try {
    console.log('TEST 1 — health');
    const h = (await axios.get(`${BRIDGE}/`)).data;
    check('mode = chatwoot-botpress-chat-api', h.mode === 'chatwoot-botpress-chat-api', JSON.stringify(h));
    const dbg = (await axios.get(`${BRIDGE}/debug/config`)).data;
    check('debug shows no secrets, chatWebhookId=true', dbg.botpress.chatWebhookId === true && !JSON.stringify(dbg).includes('test-token'));

    console.log('TEST 2 — widget session + stream');
    state.cwStatus = 'open';
    const s = (await axios.post(`${BRIDGE}/widget/session`, { name: 'إياد', userData: { progress: '64' } })).data;
    check('session returns conversationId', s.conversationId === '9001', JSON.stringify(s));
    check('new widget conversation is forced to pending', state.cwStatus === 'pending', `status=${state.cwStatus}`);
    const createsAfterFirstSession = state.cwConversations;
    const s2 = (await axios.post(`${BRIDGE}/widget/session`, { existingConversationId: s.conversationId, name: 'إياد', userData: { progress: '64' } })).data;
    check('existing conversation is reused', s2.conversationId === s.conversationId && s2.reused === true);
    check('reuse does not create a new Chatwoot conversation', state.cwConversations === createsAfterFirstSession);
    const ws = widgetStream('9001');
    await sleep(300);

    console.log('TEST 3 — customer message → Chatwoot + Botpress Chat API → bot reply round-trip');
    await axios.post(`${BRIDGE}/widget/message`, {
      conversationId: '9001',
      text: 'مرحبا',
      userData: {
        name: 'إياد',
        email: 'eyad@example.com',
        enrolled_courses: '2',
        remaining_lessons: '7',
        progress_percent: '64',
        courses_json: JSON.stringify([{ course_name: 'التصميم الداخلي', progress_percentage: 64, remaining_lessons: 7 }]),
      },
    });
    await sleep(900);
    let st = (await axios.get(`${MOCK}/__state`)).data;
    check('incoming written to Chatwoot', st.cwMessages.some((m) => m.body.message_type === 'incoming' && m.body.content === 'مرحبا'));
    check('real Chat API used (user+conversation created)', st.bpUsers === 1 && st.bpConvs === 1, `users=${st.bpUsers} convs=${st.bpConvs}`);
    check('message sent to Botpress once despite Chatwoot echo', st.bpMessages.length === 1 && st.bpMessages[0].text.endsWith('مرحبا'), `count=${st.bpMessages.length}`);
    check('trainee context (name+courses) injected into first bot message',
      st.bpMessages[0].text.includes('معلومات المتدرب') && st.bpMessages[0].text.includes('إياد') && st.bpMessages[0].text.includes('التصميم الداخلي'));
    check('context NOT written to Chatwoot transcript', !st.cwMessages.some((m) => (m.body.content || '').includes('معلومات المتدرب')));
    check('bot reply written to Chatwoot as outgoing', st.cwMessages.some((m) => m.body.message_type === 'outgoing' && m.body.content === 'رد البوت: مرحبا'));
    check('bot reply reached widget via SSE', ws.events.some((e) => e.content === 'رد البوت: مرحبا'));
    check('mapping persisted in conversation attrs', st.cwAttrs.bp_conv_id === 'bpconv-1' && !!st.cwAttrs.bp_user_key && !!st.cwAttrs.bp_ctx_sig);

    console.log('TEST 4 — agent outgoing via Chatwoot webhook → widget (no re-forward to bot)');
    const bpCountBefore = st.bpMessages.length;
    await axios.post(`${BRIDGE}/chatwoot/webhook`, { event: 'message_created', id: 777, message_type: 'outgoing', content: 'رد الموظف', conversation: { id: 9001, status: 'pending' } });
    await sleep(200);
    st = (await axios.get(`${MOCK}/__state`)).data;
    check('agent reply pushed to widget', ws.events.some((e) => e.content === 'رد الموظف'));
    check('outgoing NOT forwarded to Botpress', st.bpMessages.length === bpCountBefore);

    console.log('TEST 5 — private note skipped');
    await axios.post(`${BRIDGE}/chatwoot/webhook`, { event: 'message_created', id: 778, message_type: 'outgoing', private: true, content: 'ملاحظة سرية', conversation: { id: 9001 } });
    await sleep(150);
    check('private note never reaches widget', !ws.events.some((e) => e.content === 'ملاحظة سرية'));

    console.log('TEST 6 — duplicate message id deduped');
    const seen = ws.events.filter((e) => e.content === 'رد الموظف').length;
    await axios.post(`${BRIDGE}/chatwoot/webhook`, { event: 'message_created', id: 777, message_type: 'outgoing', content: 'رد الموظف', conversation: { id: 9001 } });
    await sleep(150);
    check('same id not delivered twice', ws.events.filter((e) => e.content === 'رد الموظف').length === seen);

    console.log('TEST 7 — status=open pauses bot, pending resumes');
    await axios.post(`${BRIDGE}/chatwoot/webhook`, { event: 'conversation_status_changed', id: 9001, status: 'open' });
    await axios.post(`${BRIDGE}/widget/message`, { conversationId: '9001', text: 'رسالة أثناء الموظف', userData: {} });
    await sleep(300);
    st = (await axios.get(`${MOCK}/__state`)).data;
    check('message written to Chatwoot but NOT sent to bot while open',
      st.cwMessages.some((m) => m.body.content === 'رسالة أثناء الموظف') && !st.bpMessages.some((m) => m.text === 'رسالة أثناء الموظف'));
    await axios.post(`${BRIDGE}/chatwoot/webhook`, { event: 'conversation_status_changed', id: 9001, status: 'pending' });
    await axios.post(`${BRIDGE}/widget/message`, { conversationId: '9001', text: 'رجعنا للبوت', userData: {} });
    await sleep(900);
    st = (await axios.get(`${MOCK}/__state`)).data;
    check('bot resumed after pending', st.bpMessages.some((m) => m.text === 'رجعنا للبوت'));

    console.log('TEST 8 — bridge-echo incoming skipped, external incoming forwarded');
    const echoId = st.cwMessages.find((m) => m.body.content === 'رجعنا للبوت');
    const bpCount2 = st.bpMessages.length;
    await axios.post(`${BRIDGE}/chatwoot/webhook`, { event: 'message_created', id: echoId.id, message_type: 'incoming', content: 'رجعنا للبوت', conversation: { id: 9001, status: 'pending' } });
    await sleep(300);
    st = (await axios.get(`${MOCK}/__state`)).data;
    check('bridge echo NOT re-forwarded', st.bpMessages.length === bpCount2);
    await axios.post(`${BRIDGE}/chatwoot/webhook`, { event: 'message_created', id: 999999, message_type: 'incoming', content: 'رسالة خارجية', conversation: { id: 9001, status: 'pending' }, sender: { name: 'X' } });
    await sleep(400);
    st = (await axios.get(`${MOCK}/__state`)).data;
    check('external incoming forwarded to bot', st.bpMessages.some((m) => m.text === 'رسالة خارجية'));

    console.log('TEST 9 — handoff marker from bot');
    await axios.post(`${BRIDGE}/widget/message`, { conversationId: '9001', text: 'عايز موظف', userData: {} });
    await sleep(900);
    st = (await axios.get(`${MOCK}/__state`)).data;
    check('status flipped to open', st.cwStatus === 'open');
    check('team 3 assigned', st.assignments.some((a) => a.team_id === 3), JSON.stringify(st.assignments));
    check('marker stripped from customer-visible text',
      st.cwMessages.some((m) => m.body.content === 'حوّلتك لزميل بشري') && !st.cwMessages.some((m) => (m.body.content || '').includes('HANDOFF')));

    console.log('TEST 10 — Botpress choice + media payloads');
    await axios.post(`${BRIDGE}/chatwoot/webhook`, { event: 'conversation_status_changed', id: 9001, status: 'pending' });
    await axios.post(`${BRIDGE}/widget/message`, { conversationId: '9001', text: 'اختيارات', userData: {} });
    await sleep(900);
    st = (await axios.get(`${MOCK}/__state`)).data;
    check('choice payload written as Chatwoot input_select', st.cwMessages.some((m) => m.body.content_type === 'input_select'));
    check('choice payload reached widget', ws.events.some((e) => e.content_type === 'input_select'));
    await axios.post(`${BRIDGE}/widget/message`, { conversationId: '9001', text: 'صورة', userData: {} });
    await sleep(900);
    check('media payload reached widget as media', ws.events.some((e) => e.content_type === 'media' && e.content_attributes?.media_type === 'image'));
    await axios.post(`${BRIDGE}/chatwoot/webhook`, {
      event: 'message_created',
      id: 888001,
      message_type: 'outgoing',
      content: 'image note\nhttps://files.bpcontent.cloud/2026/04/05/pic.png',
      conversation: { id: 9001, status: 'pending' },
    });
    await sleep(200);
    check('raw image URL outgoing webhook is rendered as media',
      ws.events.some((e) => e.id === 888001 && e.content_type === 'media' && e.content_attributes?.url?.includes('pic.png')));

    state.cwMessages.push({
      convId: '9001',
      id: 888002,
      body: { message_type: 'outgoing', content: 'history image\nhttps://files.bpcontent.cloud/2026/04/05/history.png' },
    });
    const richHistory = (await axios.get(`${BRIDGE}/widget/messages?conversationId=9001`)).data;
    check('transcript converts raw image URL to media',
      richHistory.messages.some((m) => m.id === 888002 && m.content_type === 'media' && m.content_attributes?.url?.includes('history.png')));

    console.log('TEST 11 — legacy /botpress/webhook still works (flow compat)');
    await axios.post(`${BRIDGE}/chatwoot/webhook`, { event: 'conversation_status_changed', id: 9001, status: 'pending' });
    const r10 = await axios.post(`${BRIDGE}/botpress/webhook`, { conversationId: 'chatwoot-conv-9001', messages: [{ text: 'رد من فلو قديم' }] });
    await sleep(200);
    st = (await axios.get(`${MOCK}/__state`)).data;
    check('legacy reply written + 200', r10.status === 200 && st.cwMessages.some((m) => m.body.content === 'رد من فلو قديم'));
    const r10b = await axios.post(`${BRIDGE}/botpress/webhook`, {});
    check('empty validation body returns 200 skipped', r10b.status === 200 && r10b.data.status === 'skipped');

    console.log('TEST 12 — widget attachment upload → Chatwoot multipart + Botpress media payload');
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])], { type: 'image/png' }), 'صورة-تمرين.png');
    fd.append('conversationId', '9001');
    fd.append('caption', 'شوف الصورة دي');
    fd.append('userData', '{}');
    const up = await fetch(`${BRIDGE}/widget/upload`, { method: 'POST', body: fd });
    const upd = await up.json();
    check('upload returns 200 + hosted url', up.status === 200 && upd.status === 'ok' && /\/up\//.test(upd.message.url), JSON.stringify(upd));
    check('arabic filename survives multipart (utf8 restore)', upd.message.name === 'صورة-تمرين.png', upd.message.name);
    check('attachment written to Chatwoot via multipart', state.cwUploads === 1, `uploads=${state.cwUploads}`);
    await sleep(500);
    st = (await axios.get(`${MOCK}/__state`)).data;
    check('Botpress got a real image payload (vision-ready)',
      st.bpMessages.some((m) => m.payload && m.payload.type === 'image' && m.payload.imageUrl === upd.message.url));
    check('caption forwarded to bot as text', st.bpMessages.some((m) => m.text === 'شوف الصورة دي'));

    const badFd = new FormData();
    badFd.append('file', new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' }), 'x.exe');
    badFd.append('conversationId', '9001');
    const badUp = await fetch(`${BRIDGE}/widget/upload`, { method: 'POST', body: badFd });
    check('unsupported file type rejected with 415', badUp.status === 415);

    console.log('TEST 13 — transcript endpoint for restore/history');
    const tr = (await axios.get(`${BRIDGE}/widget/messages?conversationId=9001`)).data;
    check('transcript returns mapped messages', Array.isArray(tr.messages) && tr.messages.length > 0);
    check('both senders present + valid', tr.messages.every((m) => m.sender === 'agent' || m.sender === 'contact')
      && tr.messages.some((m) => m.sender === 'contact') && tr.messages.some((m) => m.sender === 'agent'));
    check('attachment surfaced in transcript', tr.messages.some((m) => (m.attachments || []).length > 0));

    console.log('TEST 14 — conversation summaries for the history list');
    const cv = (await axios.get(`${BRIDGE}/widget/conversations?ids=9001,abc,9001`)).data;
    check('summaries deduped + mapped', cv.conversations.length === 1 && cv.conversations[0].id === '9001'
      && typeof cv.conversations[0].last_message === 'string' && !!cv.conversations[0].last_at, JSON.stringify(cv));
    const cvEmpty = (await axios.get(`${BRIDGE}/widget/conversations?ids=`)).data;
    check('empty ids → empty list', Array.isArray(cvEmpty.conversations) && cvEmpty.conversations.length === 0);

    console.log('TEST 15 — resolved conversation revived to pending on new customer message');
    state.cwStatus = 'resolved';
    await axios.post(`${BRIDGE}/chatwoot/webhook`, { event: 'conversation_status_changed', id: 9001, status: 'resolved' });
    await axios.post(`${BRIDGE}/widget/message`, { conversationId: '9001', text: 'رجعت تاني', userData: {} });
    await sleep(500);
    st = (await axios.get(`${MOCK}/__state`)).data;
    check('status flipped back to pending', st.cwStatus === 'pending', `status=${st.cwStatus}`);
    check('bot received the message after revive', st.bpMessages.some((m) => m.text === 'رجعت تاني'));

    console.log('TEST 16 — asset cache busting: headers + baked avatar hash');
    const fsMod = require('fs');
    const cryptoMod = require('crypto');
    const avatarBuf = fsMod.readFileSync(path.join(__dirname, '..', 'public', 'majed-avatar.png'));
    const avatarSha = cryptoMod.createHash('sha256').update(avatarBuf).digest('hex');
    const av1 = await axios.get(`${BRIDGE}/majed-avatar.png`, { responseType: 'arraybuffer' });
    check('bare avatar URL → 200 png + no-cache (revalidates after redeploy)',
      av1.status === 200 && String(av1.headers['content-type']).includes('image/png') &&
      av1.headers['cache-control'] === 'no-cache' && av1.data.length === avatarBuf.length);
    const av2 = await axios.get(`${BRIDGE}/majed-avatar.png?v=${avatarSha.slice(0, 16)}`, { responseType: 'arraybuffer' });
    check('versioned avatar URL → immutable long cache', String(av2.headers['cache-control']).includes('immutable'));
    const wjs = await axios.get(`${BRIDGE}/majed-widget.js`);
    check('majed-widget.js served with no-cache (clients always revalidate)',
      wjs.status === 200 && wjs.headers['cache-control'] === 'no-cache');
    const baked = String(wjs.data).match(/AVATAR_VERSION\s*=\s*'([0-9a-f]+)'/);
    check('AVATAR_VERSION baked into the widget matches the real image sha256',
      !!baked && avatarSha.startsWith(baked[1]), `baked=${baked && baked[1]} file=${avatarSha.slice(0, 16)}`);
    const dbg16 = (await axios.get(`${BRIDGE}/debug/config`)).data;
    check('debug/config exposes asset hashes', dbg16.assets && dbg16.assets.avatarSha === avatarSha.slice(0, 16));

    console.log('TEST 17 — extension-less bpcontent.cloud image keeps its type end-to-end');
    await axios.post(`${BRIDGE}/widget/message`, { conversationId: '9001', text: 'صورة بدون امتداد', userData: {} });
    await sleep(900);
    st = (await axios.get(`${MOCK}/__state`)).data;
    const noExtUrl = 'https://files.bpcontent.cloud/2026/06/10/img-no-ext';
    check('Chatwoot stored text carries the #mjd-media tag (type survives restarts)',
      st.cwMessages.some((m) => (m.body.content || '').includes(`${noExtUrl}#mjd-media=image`)));
    const evNoExt = ws.events.find((e) => e.content_type === 'media' && e.content_attributes?.url === noExtUrl);
    check('SSE delivers media/image with a CLEAN url (marker stripped)',
      !!evNoExt && evNoExt.content_attributes.media_type === 'image');
    check('marker never leaks into widget-visible content',
      ws.events.every((e) => !(e.content || '').includes('#mjd-media') && !((e.content_attributes || {}).url || '').includes('#mjd-media')));
    const trNoExt = (await axios.get(`${BRIDGE}/widget/messages?conversationId=9001`)).data;
    const trMsg = trNoExt.messages.find((m) => (m.content_attributes || {}).url === noExtUrl);
    check('transcript restores it as media/image (not a text link)',
      !!trMsg && trMsg.content_type === 'media' && trMsg.content_attributes.media_type === 'image');

    console.log('TEST 18 — SSE reconnect: catchup re-delivers with stable ids for widget de-dup');
    const ws2 = widgetStream('9001');
    await sleep(700);
    check('catchup sends recent outgoing messages on reconnect', ws2.events.length > 0, `events=${ws2.events.length}`);
    check('catchup keeps media shape after reconnect',
      ws2.events.some((e) => e.content_type === 'media' && (e.content_attributes || {}).media_type === 'image'));
    check('every catchup event carries an id (the widget de-dup key)', ws2.events.every((e) => e.id != null));
    const ids18 = ws2.events.map((e) => String(e.id));
    check('no duplicate ids inside one catchup batch', new Set(ids18).size === ids18.length);
    ws2.close();

    console.log('TEST 19 — newsletter subscribe endpoint + protected export');
    const sub = await axios.post(`${BRIDGE}/widget/subscribe`, {
      conversationId: '9001',
      email: 'Lead@Example.com',
      name: 'Lead User',
      source: 'after_reply',
    });
    st = (await axios.get(`${MOCK}/__state`)).data;
    check('subscribe returns ok', sub.data.status === 'ok');
    check('subscriber saved in JSONL', fs.existsSync(subscribeStore) && fs.readFileSync(subscribeStore, 'utf8').includes('lead@example.com'));
    check('subscriber creates private Chatwoot note',
      st.cwMessages.some((m) => m.body.private === true && String(m.body.content || '').includes('lead@example.com')));
    const csv = await axios.get(`${BRIDGE}/admin/subscribers.csv?token=admin-token`);
    check('subscriber CSV protected export works', csv.data.includes('lead@example.com') && csv.data.includes('after_reply'));
    let blocked = false;
    try { await axios.get(`${BRIDGE}/admin/subscribers.csv`); } catch (e) { blocked = e.response?.status === 404; }
    check('subscriber CSV without token is hidden', blocked);

    ws.close();
  } catch (e) {
    fail++;
    console.error('FATAL test error:', e.response ? `${e.response.status} ${JSON.stringify(e.response.data)}` : e.message);
  } finally {
    bridge.kill();
    mock.close();
    try { fs.unlinkSync(subscribeStore); } catch (_) {}
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
