/**
 * Majed Bridge — Path B (custom «نور» widget + Chatwoot API Channel)
 * ------------------------------------------------------------------
 * Connects three parties and keeps Chatwoot as the single source of truth:
 *
 *   Custom widget  ──POST /widget/message──▶  BRIDGE  ──▶ Chatwoot (incoming)
 *                                                │
 *                                                ├──▶ Botpress (bot brain)
 *                                                │
 *   Custom widget  ◀──── SSE /widget/stream ─────┤  ◀── Chatwoot webhook (every outgoing
 *                                                      message: bot + human agent)
 *
 * Real-time delivery: SSE. De-dup: per-message id. No double sends.
 */

const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json({ limit: '256kb' }));

// ── Config (all from env; never hardcode secrets) ─────────────────
const config = {
  chatwootBaseUrl: (process.env.CHATWOOT_BASE_URL || '').replace(/\/$/, ''),
  chatwootAccountId: process.env.CHATWOOT_ACCOUNT_ID || '',
  chatwootApiToken: process.env.CHATWOOT_API_TOKEN || '',
  // API channel: identifier (string) OR numeric inbox id; we resolve the numeric id at startup.
  inboxIdentifier: process.env.CHATWOOT_INBOX_IDENTIFIER || '',
  inboxId: process.env.CHATWOOT_INBOX_ID || '',

  botpressWebhookUrl: process.env.BOTPRESS_WEBHOOK_URL || '',
  botpressPat: process.env.BOTPRESS_PAT || '',

  // CORS — the Odoo site origin that hosts the widget.
  widgetOrigin: process.env.WIDGET_ORIGIN || '*',

  // «نور» welcome
  welcomeEnabled: (process.env.WELCOME_ENABLED || 'true').toLowerCase() !== 'false',
  // The widget shows a pinned contact bar itself, so the welcome card is OFF by default
  // (avoids duplication). Turn on if you want the card inside the transcript too.
  welcomeCardEnabled: (process.env.WELCOME_CARD_ENABLED || 'false').toLowerCase() === 'true',
  welcomeText:
    process.env.WELCOME_TEXT ||
    'أهلاً 👋 أنا ماجد، مستشارك التعليمي في Engosoft. اسألني عن دوراتك وتقدّمك، أو اختر وسيلة تواصل 👇',
  waNumber: (process.env.WA_NUMBER || '966920016295').replace(/[^\d]/g, ''),
  supportEmail: process.env.SUPPORT_EMAIL || 'aibot@engosoft.com',
  welcomeCardTitle: process.env.WELCOME_CARD_TITLE || 'تواصل مع Engosoft',
};

let resolvedInboxId = config.inboxId ? String(config.inboxId) : '';

// ── CORS (widget runs on the Odoo domain) ─────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', config.widgetOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve the «نور» widget script (loaded by the Odoo site): GET /majed-widget.js
app.use(express.static(path.join(__dirname, 'public')));

// ── Chatwoot Application API helpers ──────────────────────────────
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

// Create a contact in the API inbox; returns { contactId, sourceId }.
// Chatwoot enforces a UNIQUE email per account: posting an email that already
// exists (e.g. a returning/known student) returns 422 and would break session
// creation. So we attempt WITH email first, and on ANY failure retry WITHOUT the
// unique email field (email is still kept in custom_attributes so the agent and
// Botpress can see it). This guarantees /widget/session never 500s on duplicates.
async function cwCreateContact({ name, email, customAttributes }) {
  const inboxId = await resolveInboxId();

  async function create(withEmailField) {
    const attrs = Object.assign({}, customAttributes || {});
    if (email) attrs.email = email; // always visible in additional attributes
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

// Returns the created message (incl. id) so we can de-dup the webhook echo.
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

// ── «نور» welcome ─────────────────────────────────────────────────
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

// ── SSE registry + de-dup ─────────────────────────────────────────
const sseClients = new Map(); // convId -> Set<res>
const pushedIds = new Set(); // message ids already delivered (avoid webhook echo doubles)
const welcomedConvs = new Set();

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
// Push a Chatwoot-shaped message to all widget clients of a conversation (deduped by id).
function pushToWidget(convId, msg) {
  if (!msg) return;
  const id = msg.id != null ? `cw-${msg.id}` : null;
  if (id) {
    if (pushedIds.has(id)) return;
    pushedIds.add(id);
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

// ── Botpress ──────────────────────────────────────────────────────
function botpressHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (config.botpressPat) h.Authorization = `Bearer ${config.botpressPat}`;
  return h;
}
async function forwardToBotpress({ convId, text, userData }) {
  if (!config.botpressWebhookUrl) return;
  await axios.post(
    config.botpressWebhookUrl,
    {
      userId: `cw-widget-${convId}`,
      conversationId: `chatwoot-conv-${convId}`,
      type: 'text',
      text,
      payload: { type: 'text', text },
      userData: userData || {},
      metadata: { chatwootConvId: String(convId), ...(userData || {}) },
    },
    { headers: botpressHeaders(), timeout: 30000 }
  );
}

function extractConvId(body) {
  const c = body.conversationId || body.metadata?.chatwootConvId || body.chatwootConvId;
  if (!c) return null;
  const m = String(c).match(/(?:chatwoot-conv-)?(\d+)/);
  return m ? m[1] : null;
}

// ════════════════════════════ ROUTES ════════════════════════════

app.get('/', (_req, res) => {
  res.json({ status: 'running', mode: 'path-b-api-channel', inboxId: resolvedInboxId || 'unresolved' });
});

// 1) Widget opens → create contact + conversation. Returns conversationId.
app.post('/widget/session', async (req, res) => {
  try {
    const { name, email, userData } = req.body || {};
    const { contactId, sourceId } = await cwCreateContact({
      name,
      email,
      customAttributes: userData || {},
    });
    const convId = await cwCreateConversation(sourceId);
    console.log(`Widget session: contact ${contactId} → conv ${convId}`);
    return res.json({ conversationId: convId });
  } catch (err) {
    console.error('session error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'session_failed' });
  }
});

// 2) SSE stream — real-time replies for one conversation.
app.get('/widget/stream', async (req, res) => {
  const convId = String(req.query.conversationId || '');
  if (!convId) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  addClient(convId, res);

  // keep-alive ping
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25000);

  req.on('close', () => { clearInterval(ping); removeClient(convId, res); });

  // Send «نور» welcome once, after the stream is live (guarantees delivery).
  if (config.welcomeEnabled && !welcomedConvs.has(convId)) {
    welcomedConvs.add(convId);
    try {
      const m1 = await cwSendMessage(convId, { content: config.welcomeText, messageType: 'outgoing' });
      pushToWidget(convId, m1);
      // Optional: also drop the contact card into the transcript (widget shows a pinned bar already).
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

// 3) Customer sends a message.
app.post('/widget/message', async (req, res) => {
  try {
    const convId = String(req.body?.conversationId || '');
    const text = String(req.body?.text || '').trim();
    const userData = req.body?.userData || {};
    if (!convId || !text) return res.status(400).json({ error: 'missing_conversation_or_text' });

    // a) write into Chatwoot as incoming (agent sees it; single source of truth)
    await cwSendMessage(convId, { content: text, messageType: 'incoming' });
    // b) forward to Botpress (bot brain). Reply returns via /botpress/webhook → SSE.
    await forwardToBotpress({ convId, text, userData });

    return res.json({ status: 'ok' });
  } catch (err) {
    console.error('message error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'message_failed' });
  }
});

// 4) Botpress reply → write to Chatwoot as outgoing (+ handoff actions). SSE push happens
//    when Chatwoot fires the webhook (deduped), so bot + agent share one delivery path.
// Botpress does a GET on this endpoint to verify it's reachable (must return 200).
app.get('/botpress/webhook', (req, res) => res.status(200).json({ status: 'ok' }));

app.post('/botpress/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const convId = extractConvId(body);
    // Botpress validates the Response Endpoint by hitting it (sometimes via POST with an
    // empty/test body). Return 200 (not 400) so registration always passes; real replies
    // always carry a conversationId and are processed below.
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
      pushToWidget(convId, created); // immediate; webhook echo will be deduped
    }

    // handoff / assign / status
    const actions = [];
    if (Array.isArray(body.actions)) actions.push(...body.actions);
    if (body.handoff) actions.push(typeof body.handoff === 'object' ? { type: 'handoff', ...body.handoff } : { type: 'handoff' });
    for (const a of actions.filter((x) => x && x.type)) {
      const type = String(a.type).toLowerCase();
      if (type === 'handoff') {
        await cwSetStatus(convId, 'open');
        await cwAssign(convId, { team_id: a.team_id, assignee_id: a.assignee_id });
      } else if (type === 'assign') {
        await cwAssign(convId, { team_id: a.team_id, assignee_id: a.assignee_id });
      } else if (type === 'status') {
        await cwSetStatus(convId, a.status || 'open');
      }
    }

    return res.json({ status: 'ok', messages: items.length, actions: actions.length });
  } catch (err) {
    console.error('botpress webhook error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'botpress_failed' });
  }
});

// 5) Chatwoot webhook (API channel "Webhook URL"). Delivers HUMAN-agent replies to the
//    widget in real-time. Bot/welcome messages were already pushed → deduped here.
app.post('/chatwoot/webhook', (req, res) => {
  try {
    const p = req.body || {};
    if (p.event !== 'message_created') return res.status(200).json({ status: 'skipped' });
    // Only outgoing (agent/bot) messages go to the customer. Skip private notes + incoming echo.
    const isOutgoing = p.message_type === 'outgoing' || p.message_type === 1;
    if (!isOutgoing || p.private) return res.status(200).json({ status: 'skipped' });
    const convId = String(p.conversation?.id || p.conversation_id || '');
    if (convId) {
      pushToWidget(convId, {
        id: p.id,
        content: p.content,
        content_type: p.content_type,
        content_attributes: p.content_attributes,
        message_type: 'outgoing',
        sender: p.sender,
      });
    }
    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('chatwoot webhook error:', err.message);
    return res.status(500).json({ error: 'webhook_failed' });
  }
});

// ── Startup ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Majed bridge (Path B) on port ${PORT}`);
  const missing = [];
  if (!config.chatwootBaseUrl) missing.push('CHATWOOT_BASE_URL');
  if (!config.chatwootAccountId) missing.push('CHATWOOT_ACCOUNT_ID');
  if (!config.chatwootApiToken) missing.push('CHATWOOT_API_TOKEN');
  if (!config.inboxIdentifier && !config.inboxId) missing.push('CHATWOOT_INBOX_IDENTIFIER or CHATWOOT_INBOX_ID');
  if (!config.botpressWebhookUrl) missing.push('BOTPRESS_WEBHOOK_URL');
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
