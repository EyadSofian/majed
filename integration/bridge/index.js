/**
 * Majed Bridge — Chatwoot (API Channel) ↔ Botpress (real Chat API)
 * -----------------------------------------------------------------
 *   Custom widget ──POST /widget/message──▶ BRIDGE ──▶ Chatwoot (incoming, source of truth)
 *                                              │
 *                                              ├──▶ Botpress Chat API  (real user/conversation/message)
 *                                              │      POST {base}/{webhookId}/users | /conversations | /messages
 *                                              │      GET  {base}/{webhookId}/conversations/{id}/listen  (SSE)
 *                                              │
 *   Custom widget ◀── SSE /widget/stream ──────┤ ◀── bot replies (Botpress SSE) → written to Chatwoot outgoing
 *                                              │ ◀── human agent replies (Chatwoot inbox Webhook URL)
 *
 * Bot gating: while the Chatwoot conversation status is "open" (human handling),
 * customer messages are NOT forwarded to Botpress. Back to "pending" → bot resumes.
 *
 * Handoff (bot → human), three supported signals:
 *   1. text marker in a bot reply:  [[HANDOFF]] or [[HANDOFF:3]]  (stripped, never shown)
 *   2. Chat API custom event with payload { type|action: "handoff", team_id }
 *   3. legacy POST /botpress/webhook { conversationId, actions:[{type:"handoff",team_id}] }
 *
 * De-dup: per Chatwoot message id (widget pushes) + per Botpress message id (SSE reconnects)
 * + bridge-created incoming ids (so the Chatwoot webhook echo is never re-forwarded to the bot).
 *
 * Secrets: env vars only. Never hardcode tokens.
 */

const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json({ limit: '256kb' }));

// ── Config ─────────────────────────────────────────────────────────
const config = {
  chatwootBaseUrl: (process.env.CHATWOOT_BASE_URL || '').replace(/\/$/, ''),
  chatwootAccountId: process.env.CHATWOOT_ACCOUNT_ID || '',
  chatwootApiToken: process.env.CHATWOOT_API_TOKEN || '',
  inboxIdentifier: process.env.CHATWOOT_INBOX_IDENTIFIER || '',
  inboxId: process.env.CHATWOOT_INBOX_ID || '',

  // Botpress Chat API (the REAL messaging path — requires the "Chat" integration
  // installed on the bot; its webhook id is the last segment of the integration's
  // Webhook URL: https://chat.botpress.cloud/<id>).
  botpressChatBase: (process.env.BOTPRESS_CHAT_API_BASE || 'https://chat.botpress.cloud').replace(/\/$/, ''),
  botpressChatWebhookId: process.env.BOTPRESS_CHAT_WEBHOOK_ID || '',

  // CORS — the Odoo site origin that hosts the widget.
  widgetOrigin: process.env.WIDGET_ORIGIN || '*',

  // «نور» welcome
  welcomeEnabled: (process.env.WELCOME_ENABLED || 'true').toLowerCase() !== 'false',
  welcomeCardEnabled: (process.env.WELCOME_CARD_ENABLED || 'false').toLowerCase() === 'true',
  welcomeText:
    process.env.WELCOME_TEXT ||
    'أهلاً 👋 أنا ماجد، مستشارك التعليمي في Engosoft. اسألني عن دوراتك وتقدّمك، أو اختر وسيلة تواصل 👇',
  waNumber: (process.env.WA_NUMBER || '966920016295').replace(/[^\d]/g, ''),
  supportEmail: process.env.SUPPORT_EMAIL || 'aibot@engosoft.com',
  welcomeCardTitle: process.env.WELCOME_CARD_TITLE || 'تواصل مع Engosoft',
};

// Legacy var: if someone still sets BOTPRESS_WEBHOOK_URL, try to salvage a chat id
// from a chat.botpress.cloud URL — and warn loudly if it points at the wrong product.
if (!config.botpressChatWebhookId && process.env.BOTPRESS_WEBHOOK_URL) {
  const legacy = process.env.BOTPRESS_WEBHOOK_URL;
  const m = legacy.match(/chat\.botpress\.cloud\/([\w-]+)/);
  if (m) {
    config.botpressChatWebhookId = m[1];
    console.warn('Using BOTPRESS_CHAT_WEBHOOK_ID extracted from legacy BOTPRESS_WEBHOOK_URL.');
  } else if (/webhook\.botpress\.cloud/.test(legacy)) {
    console.warn(
      '⚠ BOTPRESS_WEBHOOK_URL points to webhook.botpress.cloud (Webhook integration). ' +
        'That is NOT the Chat API. Install the "Chat" integration on the bot and set ' +
        'BOTPRESS_CHAT_WEBHOOK_ID to the id from https://chat.botpress.cloud/<id>.'
    );
  }
}

let resolvedInboxId = config.inboxId ? String(config.inboxId) : '';

// ── tiny LRU set (bounded de-dup memory) ───────────────────────────
function lruSet(max) {
  const set = new Set();
  return {
    has: (k) => set.has(k),
    add(k) {
      if (set.has(k)) return;
      set.add(k);
      if (set.size > max) set.delete(set.values().next().value);
    },
  };
}

// ── CORS ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', config.widgetOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// «نور» widget static files: GET /majed-widget.js , /majed-avatar.png
app.use(express.static(path.join(__dirname, 'public')));

// ── Chatwoot Application API ───────────────────────────────────────
function cwHeaders() {
  return { 'Content-Type': 'application/json', api_access_token: config.chatwootApiToken };
}
function cwUrl(suffix) {
  return `${config.chatwootBaseUrl}/api/v1/accounts/${config.chatwootAccountId}/${suffix}`;
}

async function resolveInboxId() {
  if (resolvedInboxId) return resolvedInboxId;
  const { data } = await axios.get(cwUrl('inboxes'), { headers: cwHeaders(), timeout: 15000 });
  const list = data?.payload || [];
  const match =
    list.find((i) => config.inboxIdentifier && i.inbox_identifier === config.inboxIdentifier) ||
    list.find((i) => i.channel_type === 'Channel::Api');
  if (!match) throw new Error('Could not resolve API inbox id — check CHATWOOT_INBOX_IDENTIFIER');
  resolvedInboxId = String(match.id);
  console.log(`Resolved inbox id = ${resolvedInboxId} (${match.name})`);
  return resolvedInboxId;
}

// Chatwoot enforces unique email per account → retry without the email field on failure
// (email stays visible inside custom_attributes). Guarantees sessions never 500 on duplicates.
async function cwCreateContact({ name, email, customAttributes }) {
  const inboxId = await resolveInboxId();

  async function create(withEmailField) {
    const attrs = Object.assign({}, customAttributes || {});
    if (email) attrs.email = email;
    const body = { inbox_id: Number(inboxId), name: name || 'زائر', custom_attributes: attrs };
    if (withEmailField && email) body.email = email;
    const { data } = await axios.post(cwUrl('contacts'), body, { headers: cwHeaders(), timeout: 15000 });
    return data;
  }

  let data;
  try {
    data = await create(true);
  } catch (err) {
    console.warn('contact create with email failed (', err.response?.status, ') — retry without email');
    data = await create(false);
  }

  const payload = data?.payload || data;
  const contact = payload?.contact || payload;
  const sourceId =
    payload?.contact_inbox?.source_id ||
    contact?.contact_inboxes?.[0]?.source_id ||
    contact?.contact_inbox?.source_id;
  if (!sourceId) throw new Error('No source_id returned from contact creation');
  return { contactId: contact.id, sourceId };
}

async function cwCreateConversation(sourceId) {
  const inboxId = await resolveInboxId();
  const { data } = await axios.post(
    cwUrl('conversations'),
    { source_id: sourceId, inbox_id: Number(inboxId) },
    { headers: cwHeaders(), timeout: 15000 }
  );
  return String(data.id);
}

async function cwSendMessage(convId, { content, messageType, contentType, contentAttributes, isPrivate }) {
  const body = { content: content || '', message_type: messageType || 'outgoing', private: !!isPrivate };
  if (contentType && contentType !== 'text') {
    body.content_type = contentType;
    body.content_attributes = contentAttributes || {};
  }
  const { data } = await axios.post(cwUrl(`conversations/${convId}/messages`), body, {
    headers: cwHeaders(),
    timeout: 15000,
  });
  return data; // { id, content, ... }
}

async function cwGetConversation(convId) {
  const { data } = await axios.get(cwUrl(`conversations/${convId}`), { headers: cwHeaders(), timeout: 15000 });
  return data;
}

async function cwSetConversationAttrs(convId, attrs) {
  await axios.post(
    cwUrl(`conversations/${convId}/custom_attributes`),
    { custom_attributes: attrs },
    { headers: cwHeaders(), timeout: 15000 }
  );
}

async function cwSetStatus(convId, status) {
  await axios.post(cwUrl(`conversations/${convId}/toggle_status`), { status }, { headers: cwHeaders(), timeout: 15000 });
}
async function cwAssign(convId, { team_id, assignee_id }) {
  const body = {};
  if (assignee_id) body.assignee_id = assignee_id;
  if (team_id) body.team_id = team_id;
  if (!Object.keys(body).length) return;
  await axios.post(cwUrl(`conversations/${convId}/assignments`), body, { headers: cwHeaders(), timeout: 15000 });
}

// ── «نور» welcome card ─────────────────────────────────────────────
function welcomeCard() {
  return {
    content: 'طرق التواصل المباشر:',
    contentType: 'cards',
    contentAttributes: {
      items: [
        {
          title: config.welcomeCardTitle,
          description: 'اختر الوسيلة اللي تناسبك',
          actions: [
            { type: 'link', text: '💬 واتساب', uri: `https://wa.me/${config.waNumber}` },
            { type: 'link', text: '✉️ إيميل', uri: `mailto:${config.supportEmail}` },
            { type: 'postback', text: '🎙️ ماجد فويس (قريبًا)', payload: 'voice_soon' },
          ],
        },
      ],
    },
    messageType: 'outgoing',
  };
}

// ── widget SSE registry + de-dup ───────────────────────────────────
const sseClients = new Map(); // cwConvId -> Set<res>
const pushedIds = lruSet(5000); // chatwoot message ids already delivered to widget
const bridgeIncomingIds = lruSet(5000); // incoming cw msg ids the bridge itself created (skip webhook echo)
const bridgeIncomingEchoes = new Map(); // short-lived conv+content keys for Chatwoot echo skip
const welcomedConvs = new Set();

function echoKey(convId, content) {
  return `${convId}:${String(content || '').trim()}`;
}

function markBridgeIncoming(convId, msg, content) {
  if (msg?.id != null) bridgeIncomingIds.add(`cw-${msg.id}`);
  bridgeIncomingEchoes.set(echoKey(convId, content), Date.now() + 30000);
}

function isBridgeIncomingEcho(convId, msg) {
  if (msg?.id != null && bridgeIncomingIds.has(`cw-${msg.id}`)) return true;
  const key = echoKey(convId, msg?.content);
  const until = bridgeIncomingEchoes.get(key);
  if (!until) return false;
  if (until < Date.now()) {
    bridgeIncomingEchoes.delete(key);
    return false;
  }
  bridgeIncomingEchoes.delete(key);
  return true;
}

function addClient(convId, res) {
  if (!sseClients.has(convId)) sseClients.set(convId, new Set());
  sseClients.get(convId).add(res);
}
function removeClient(convId, res) {
  const set = sseClients.get(convId);
  if (set) {
    set.delete(res);
    if (!set.size) sseClients.delete(convId);
  }
}
function pushToWidget(convId, msg) {
  if (!msg) return;
  if (msg.id != null) {
    const key = `cw-${msg.id}`;
    if (pushedIds.has(key)) return;
    pushedIds.add(key);
  }
  const set = sseClients.get(String(convId));
  if (!set || !set.size) return;
  const data = JSON.stringify({
    id: msg.id,
    content: msg.content || '',
    content_type: msg.content_type || 'text',
    content_attributes: msg.content_attributes || {},
    sender: msg.sender?.type || (msg.message_type === 1 || msg.message_type === 'outgoing' ? 'agent' : 'contact'),
  });
  for (const res of set) {
    try {
      res.write(`event: message\ndata: ${data}\n\n`);
    } catch (_) {}
  }
}

// ── Conversation status cache (bot gating) ─────────────────────────
const convStatus = new Map(); // cwConvId -> 'pending' | 'open' | 'resolved' | 'snoozed'

async function getConvStatus(cwConvId) {
  if (convStatus.has(cwConvId)) return convStatus.get(cwConvId);
  try {
    const conv = await cwGetConversation(cwConvId);
    const st = conv?.status || conv?.payload?.status || 'pending';
    convStatus.set(cwConvId, st);
    return st;
  } catch (e) {
    console.warn('status fetch failed for', cwConvId, '-', e.message);
    return 'pending'; // fail open for the bot rather than dropping the message
  }
}

// ── Botpress Chat API ──────────────────────────────────────────────
const BP_IDLE_MS = 30 * 60 * 1000; // stop SSE listeners after 30 min inactivity
const bpMap = new Map(); // cwConvId -> { userId, userKey, bpConvId, lastActivity, stream, seen }

function bpConfigured() {
  return Boolean(config.botpressChatWebhookId);
}
function bpUrl(suffix) {
  return `${config.botpressChatBase}/${config.botpressChatWebhookId}${suffix}`;
}

function compactProfile(userData) {
  const data = userData || {};
  const compact = {
    isLoggedIn: data.isLoggedIn,
    name: data.name || data.userFullName || data.fullName,
    email: data.email || data.userEmail,
    phone: data.phone || data.userPhone,
    course: data.extractedCourseName || data.course_name || data.current_course,
    progress: data.progress_percent || data.progress_percentage,
    remainingLessons: data.remaining_lessons || data.remainingLessons,
  };
  for (const key of Object.keys(compact)) {
    if (compact[key] == null || compact[key] === '') delete compact[key];
  }
  return JSON.stringify(compact).slice(0, 450);
}

async function bpCreateUser({ name, userData }) {
  // Botpress stores this under tags.profile and currently enforces a 500-char cap.
  let profile = '';
  try {
    profile = compactProfile(userData);
  } catch (_) {}
  const { data } = await axios.post(
    bpUrl('/users'),
    { name: (name || 'زائر').slice(0, 100), profile },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return { userId: data.user.id, userKey: data.key };
}

async function bpCreateConversation(userKey) {
  const { data } = await axios.post(
    bpUrl('/conversations'),
    {},
    { headers: { 'Content-Type': 'application/json', 'x-user-key': userKey }, timeout: 15000 }
  );
  return data.conversation.id;
}

async function bpSendText(mapping, text) {
  await axios.post(
    bpUrl('/messages'),
    { conversationId: mapping.bpConvId, payload: { type: 'text', text } },
    { headers: { 'Content-Type': 'application/json', 'x-user-key': mapping.userKey }, timeout: 20000 }
  );
}

// Handoff marker in bot replies: [[HANDOFF]] or [[HANDOFF:3]]
const HANDOFF_RE = /\[\[\s*HANDOFF(?::(\d+))?\s*\]\]/i;

async function performHandoff(cwConvId, teamId) {
  await cwSetStatus(cwConvId, 'open');
  convStatus.set(cwConvId, 'open');
  if (teamId) await cwAssign(cwConvId, { team_id: Number(teamId) });
  console.log(`HANDOFF conv ${cwConvId}${teamId ? ` → team ${teamId}` : ''} (status: open)`);
}

// A bot reply arrived from Botpress (via SSE) → write to Chatwoot + push to widget.
async function handleBotReply(cwConvId, payload) {
  const type = payload?.type || 'text';
  let text = typeof payload?.text === 'string' ? payload.text : '';

  // handoff marker
  const hm = text.match(HANDOFF_RE);
  if (hm) {
    text = text.replace(HANDOFF_RE, '').trim();
    try {
      await performHandoff(cwConvId, hm[1]);
    } catch (e) {
      console.error('handoff failed:', e.response?.data || e.message);
    }
  }

  if (type === 'text') {
    if (!text) return;
    const created = await cwSendMessage(cwConvId, { content: text, messageType: 'outgoing' });
    console.log(`OUT Chatwoot conv ${cwConvId} (bot): ${text.slice(0, 60)}`);
    pushToWidget(cwConvId, created);
    return;
  }

  // Non-text payloads (choice/card/...) → map basic ones to Chatwoot interactive messages.
  if (type === 'choice' && Array.isArray(payload.options)) {
    const created = await cwSendMessage(cwConvId, {
      content: payload.text || '',
      messageType: 'outgoing',
      contentType: 'input_select',
      contentAttributes: { items: payload.options.map((o) => ({ title: o.label || o.value, value: o.value })) },
    });
    pushToWidget(cwConvId, created);
    return;
  }

  // Fallback: stringify unknown payloads as text so nothing is silently lost.
  const fallback = payload?.text || payload?.title || '';
  if (fallback) {
    const created = await cwSendMessage(cwConvId, { content: fallback, messageType: 'outgoing' });
    pushToWidget(cwConvId, created);
  }
}

// SSE listener on the Botpress conversation (bot replies arrive here).
function bpStartListener(cwConvId, mapping) {
  if (mapping.stream) return;
  let retry = 0;

  async function connect() {
    if (Date.now() - mapping.lastActivity > BP_IDLE_MS) {
      mapping.stream = null;
      return; // idle — let it die; recreated on next customer message
    }
    try {
      const resp = await axios.get(bpUrl(`/conversations/${mapping.bpConvId}/listen`), {
        headers: { 'x-user-key': mapping.userKey, Accept: 'text/event-stream' },
        responseType: 'stream',
        timeout: 0,
      });
      retry = 0;
      mapping.stream = resp.data;
      console.log(`BOTPRESS listen open (cw ${cwConvId} ↔ bp ${mapping.bpConvId})`);

      let buf = '';
      resp.data.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
          if (!dataLine) continue;
          let ev;
          try {
            ev = JSON.parse(dataLine);
          } catch (_) {
            continue;
          }
          handleSseEvent(cwConvId, mapping, ev).catch((e) =>
            console.error('sse handle error:', e.response?.data || e.message)
          );
        }
      });
      const reconnect = () => {
        mapping.stream = null;
        const delay = Math.min(30000, 1000 * Math.pow(2, retry++));
        setTimeout(connect, delay);
      };
      resp.data.on('end', reconnect);
      resp.data.on('error', reconnect);
    } catch (e) {
      mapping.stream = null;
      const delay = Math.min(30000, 1000 * Math.pow(2, retry++));
      console.warn(`BOTPRESS listen failed (cw ${cwConvId}): ${e.response?.status || e.message} — retry in ${delay}ms`);
      setTimeout(connect, delay);
    }
  }
  connect();
}

async function handleSseEvent(cwConvId, mapping, ev) {
  // Tolerant parsing: {type,data} envelope or bare object.
  const type = ev?.type || ev?.event || '';
  const data = ev?.data || ev;

  if (type === 'message_created' || (data && data.payload && data.conversationId)) {
    const msg = data;
    if (!msg || !msg.id) return;
    if (msg.userId && msg.userId === mapping.userId) return; // our own echo
    if (mapping.seen.has(msg.id)) return; // SSE reconnect duplicates
    mapping.seen.add(msg.id);
    mapping.lastActivity = Date.now();
    console.log(`BOTPRESS reply (cw ${cwConvId}): ${(msg.payload?.text || msg.payload?.type || '').toString().slice(0, 60)}`);
    await handleBotReply(cwConvId, msg.payload || {});
    return;
  }

  if (type === 'event_created') {
    const p = data?.payload || {};
    const action = (p.action || p.type || '').toString().toLowerCase();
    if (action === 'handoff') {
      await performHandoff(cwConvId, p.team_id || p.teamId);
    }
    return;
  }
}

// Ensure a Botpress user+conversation exists for this Chatwoot conversation.
// Persistence: mapping is stored in the Chatwoot conversation's custom_attributes
// (bp_user_id / bp_user_key / bp_conv_id) so it survives bridge restarts.
async function ensureBotpress(cwConvId, { name, userData }) {
  if (!bpConfigured()) return null;

  let mapping = bpMap.get(cwConvId);
  if (mapping) {
    mapping.lastActivity = Date.now();
    if (!mapping.stream) bpStartListener(cwConvId, mapping);
    return mapping;
  }

  // recovery after restart: read mapping back from Chatwoot
  try {
    const conv = await cwGetConversation(cwConvId);
    const attrs = conv?.custom_attributes || conv?.payload?.custom_attributes || {};
    if (attrs.bp_user_key && attrs.bp_conv_id) {
      mapping = {
        userId: attrs.bp_user_id || '',
        userKey: attrs.bp_user_key,
        bpConvId: attrs.bp_conv_id,
        lastActivity: Date.now(),
        stream: null,
        seen: lruSet(500),
      };
      bpMap.set(cwConvId, mapping);
      bpStartListener(cwConvId, mapping);
      console.log(`BOTPRESS mapping recovered for cw ${cwConvId} (bp ${mapping.bpConvId})`);
      return mapping;
    }
  } catch (e) {
    console.warn('mapping recovery failed:', e.message);
  }

  // fresh: create real Botpress user + conversation (Chat API)
  const { userId, userKey } = await bpCreateUser({ name, userData });
  const bpConvId = await bpCreateConversation(userKey);
  mapping = { userId, userKey, bpConvId, lastActivity: Date.now(), stream: null, seen: lruSet(500) };
  bpMap.set(cwConvId, mapping);
  bpStartListener(cwConvId, mapping);
  console.log(`BOTPRESS created user ${userId} + conv ${bpConvId} (cw ${cwConvId})`);

  // persist (best-effort; messaging continues even if this fails)
  cwSetConversationAttrs(cwConvId, {
    bp_user_id: userId,
    bp_user_key: userKey,
    bp_conv_id: bpConvId,
  }).catch((e) => console.warn('mapping persist failed:', e.response?.status || e.message));

  return mapping;
}

// Forward one customer message to Botpress (status-gated).
async function forwardToBot(cwConvId, text, { name, userData }) {
  if (!bpConfigured()) {
    console.warn('SKIP Botpress (not configured) — set BOTPRESS_CHAT_WEBHOOK_ID');
    return;
  }
  const status = await getConvStatus(cwConvId);
  if (status === 'open') {
    console.log(`SKIP bot (agent handling, status=open) conv ${cwConvId}`);
    return;
  }
  const mapping = await ensureBotpress(cwConvId, { name, userData });
  if (!mapping) return;
  await bpSendText(mapping, text);
  console.log(`SEND Botpress (cw ${cwConvId} → bp ${mapping.bpConvId}): ${text.slice(0, 60)}`);
}

// Reap idle Botpress listeners.
setInterval(() => {
  const now = Date.now();
  for (const [cwConvId, m] of bpMap) {
    if (now - m.lastActivity > BP_IDLE_MS && m.stream) {
      try { m.stream.destroy(); } catch (_) {}
      m.stream = null;
      console.log(`BOTPRESS listen idle-closed (cw ${cwConvId})`);
    }
  }
}, 5 * 60 * 1000).unref();

// ════════════════════════════ ROUTES ════════════════════════════

app.get('/', (_req, res) => {
  res.json({
    status: 'running',
    mode: 'chatwoot-botpress-chat-api',
    inboxId: resolvedInboxId || 'unresolved',
    botpress: bpConfigured() ? 'chat-api' : 'NOT CONFIGURED',
  });
});

// Safe config visibility — booleans only, never secrets.
app.get('/debug/config', (_req, res) => {
  res.json({
    chatwoot: {
      baseUrl: Boolean(config.chatwootBaseUrl),
      accountId: Boolean(config.chatwootAccountId),
      apiToken: Boolean(config.chatwootApiToken),
      inboxId: resolvedInboxId || null,
      inboxIdentifier: Boolean(config.inboxIdentifier),
    },
    botpress: {
      chatApiBase: config.botpressChatBase,
      chatWebhookId: bpConfigured(),
      activeMappings: bpMap.size,
    },
    widgetOrigin: config.widgetOrigin,
    welcome: { enabled: config.welcomeEnabled, card: config.welcomeCardEnabled },
  });
});

// 1) Widget opens → Chatwoot contact + conversation (Botpress side is created lazily
//    on first message, so sessions stay fast and Botpress outages can't block opening).
app.post('/widget/session', async (req, res) => {
  try {
    const { name, email, userData } = req.body || {};
    const { contactId, sourceId } = await cwCreateContact({ name, email, customAttributes: userData || {} });
    const convId = await cwCreateConversation(sourceId);
    convStatus.set(convId, 'pending');
    console.log(`Widget session: contact ${contactId} → conv ${convId}`);
    return res.json({ conversationId: convId });
  } catch (err) {
    console.error('session error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'session_failed' });
  }
});

// 2) Widget SSE stream (bot + human replies, real-time).
app.get('/widget/stream', async (req, res) => {
  const convId = String(req.query.conversationId || '');
  if (!convId) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  addClient(convId, res);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25000);
  req.on('close', () => { clearInterval(ping); removeClient(convId, res); });

  if (config.welcomeEnabled && !welcomedConvs.has(convId)) {
    welcomedConvs.add(convId);
    try {
      const m1 = await cwSendMessage(convId, { content: config.welcomeText, messageType: 'outgoing' });
      pushToWidget(convId, m1);
      if (config.welcomeCardEnabled) {
        const c = welcomeCard();
        const m2 = await cwSendMessage(convId, {
          content: c.content, messageType: 'outgoing', contentType: c.contentType, contentAttributes: c.contentAttributes,
        });
        pushToWidget(convId, m2);
      }
    } catch (err) {
      console.error('welcome error:', err.response?.data || err.message);
    }
  }
});

// 3) Customer message from the widget.
app.post('/widget/message', async (req, res) => {
  try {
    const convId = String(req.body?.conversationId || '');
    const text = String(req.body?.text || '').trim();
    const userData = req.body?.userData || {};
    if (!convId || !text) return res.status(400).json({ error: 'missing_conversation_or_text' });

    console.log(`IN widget conv ${convId}: ${text.slice(0, 60)}`);

    // a) Chatwoot first (source of truth). Remember the id so the webhook echo is skipped.
    const created = await cwSendMessage(convId, { content: text, messageType: 'incoming' });
    markBridgeIncoming(convId, created, text);

    // b) Botpress Chat API (status-gated). Bot replies return via SSE listener.
    try {
      await forwardToBot(convId, text, { name: userData.name, userData });
    } catch (e) {
      // Never fail the customer's message because the bot is down.
      console.error('forwardToBot failed:', e.response?.data || e.message);
    }

    return res.json({ status: 'ok' });
  } catch (err) {
    console.error('message error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'message_failed' });
  }
});

// 4) Legacy/compat endpoint: flows can still push replies or actions here
//    (e.g. Execute Code handoff: { conversationId, actions:[{type:"handoff",team_id}] }).
app.get('/botpress/webhook', (_req, res) => res.status(200).json({ status: 'ok' }));

app.post('/botpress/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const c = body.conversationId || body.metadata?.chatwootConvId || body.chatwootConvId;
    const m = c ? String(c).match(/(?:chatwoot-conv-)?(\d+)/) : null;
    const convId = m ? m[1] : null;
    if (!convId) return res.status(200).json({ status: 'skipped', reason: 'no_conversation_id' });

    const items = [];
    if (Array.isArray(body.messages)) items.push(...body.messages);
    if (Array.isArray(body.responses)) items.push(...body.responses);
    if (!items.length && (body.text || body.content)) items.push(body);

    for (const it of items) {
      const text = it.text || it.content || it.payload?.text || '';
      const contentType = it.content_type || it.payload?.content_type;
      const contentAttributes = it.content_attributes || it.payload?.content_attributes;
      if (!text && !contentType) continue;
      const created = await cwSendMessage(convId, {
        content: typeof text === 'string' ? text : '',
        messageType: 'outgoing',
        contentType,
        contentAttributes,
      });
      console.log(`OUT Chatwoot conv ${convId} (flow): ${(text || '').toString().slice(0, 60)}`);
      pushToWidget(convId, created);
    }

    const actions = [];
    if (Array.isArray(body.actions)) actions.push(...body.actions);
    if (body.handoff) actions.push(typeof body.handoff === 'object' ? { type: 'handoff', ...body.handoff } : { type: 'handoff' });
    for (const a of actions.filter((x) => x && x.type)) {
      const type = String(a.type).toLowerCase();
      if (type === 'handoff') {
        await performHandoff(convId, a.team_id);
        if (a.assignee_id) await cwAssign(convId, { assignee_id: a.assignee_id });
      } else if (type === 'assign') {
        await cwAssign(convId, { team_id: a.team_id, assignee_id: a.assignee_id });
      } else if (type === 'status') {
        await cwSetStatus(convId, a.status || 'open');
        convStatus.set(convId, a.status || 'open');
      }
    }

    return res.json({ status: 'ok', messages: items.length, actions: actions.length });
  } catch (err) {
    console.error('botpress webhook error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'botpress_failed' });
  }
});

// 5) Chatwoot inbox Webhook URL → agent replies to widget + status changes + external incoming.
app.post('/chatwoot/webhook', async (req, res) => {
  try {
    const p = req.body || {};

    if (p.event === 'conversation_status_changed') {
      const convId = String(p.id || p.conversation?.id || '');
      const status = p.status || p.conversation?.status;
      if (convId && status) {
        convStatus.set(convId, status);
        console.log(`STATUS conv ${convId} → ${status}${status === 'open' ? ' (bot paused)' : status === 'pending' ? ' (bot resumed)' : ''}`);
      }
      return res.status(200).json({ status: 'ok' });
    }

    if (p.event !== 'message_created') return res.status(200).json({ status: 'skipped' });

    const convId = String(p.conversation?.id || p.conversation_id || '');
    if (!convId) return res.status(200).json({ status: 'skipped' });
    if (p.conversation?.status) convStatus.set(convId, p.conversation.status);

    const isOutgoing = p.message_type === 'outgoing' || p.message_type === 1;
    const isIncoming = p.message_type === 'incoming' || p.message_type === 0;

    if (p.private) {
      console.log(`SKIP private note conv ${convId}`);
      return res.status(200).json({ status: 'skipped', reason: 'private' });
    }

    if (isOutgoing) {
      // Human agent (or flow) reply → widget. Never re-forwarded to Botpress.
      pushToWidget(convId, {
        id: p.id,
        content: p.content,
        content_type: p.content_type,
        content_attributes: p.content_attributes,
        message_type: 'outgoing',
        sender: p.sender,
      });
      return res.status(200).json({ status: 'ok' });
    }

    if (isIncoming) {
      // Echo of a message the bridge itself wrote → already forwarded. Skip.
      if (isBridgeIncomingEcho(convId, p)) {
        return res.status(200).json({ status: 'skipped', reason: 'bridge_echo' });
      }
      // Genuinely external incoming message (created by some other client) → forward to bot.
      if (p.content) {
        console.log(`IN Chatwoot(external) conv ${convId}: ${String(p.content).slice(0, 60)}`);
        try {
          await forwardToBot(convId, String(p.content), {
            name: p.sender?.name,
            userData: p.sender?.custom_attributes || {},
          });
        } catch (e) {
          console.error('external forward failed:', e.response?.data || e.message);
        }
      }
      return res.status(200).json({ status: 'ok' });
    }

    return res.status(200).json({ status: 'skipped' });
  } catch (err) {
    console.error('chatwoot webhook error:', err.message);
    return res.status(500).json({ error: 'webhook_failed' });
  }
});

// ── Startup ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Majed bridge (Chat API mode) on port ${PORT}`);
  const missing = [];
  if (!config.chatwootBaseUrl) missing.push('CHATWOOT_BASE_URL');
  if (!config.chatwootAccountId) missing.push('CHATWOOT_ACCOUNT_ID');
  if (!config.chatwootApiToken) missing.push('CHATWOOT_API_TOKEN');
  if (!config.inboxIdentifier && !config.inboxId) missing.push('CHATWOOT_INBOX_IDENTIFIER or CHATWOOT_INBOX_ID');
  if (!config.botpressChatWebhookId) missing.push('BOTPRESS_CHAT_WEBHOOK_ID (Chat integration webhook id)');
  if (missing.length) {
    console.warn('⚠ Missing config:', missing.join(', '));
  } else {
    try {
      await resolveInboxId();
    } catch (e) {
      console.warn('⚠ Inbox not resolved yet:', e.message);
    }
  }
});

module.exports = app;
