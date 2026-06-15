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
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
app.use(express.json({ limit: '256kb' }));

// ── Uploads (widget attachments) ───────────────────────────────────
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 10);
const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

// mime → Botpress payload kind ('' = rejected)
function mimeKind(mime) {
  const m = String(mime || '').toLowerCase();
  if (/^image\/(png|jpe?g|webp|gif)$/.test(m)) return 'image';
  if (/^audio\/(mpeg|mp4|ogg|wav|webm|aac|m4a)/.test(m)) return 'audio';
  if (/^video\/(mp4|webm|quicktime)$/.test(m)) return 'video';
  if (
    [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
      'text/csv',
      'application/zip',
      'application/x-zip-compressed',
    ].includes(m)
  )
    return 'file';
  return '';
}

function safeFileName(name) {
  let s = String(name || 'file');
  // Some clients (busboy latin1 default) deliver UTF-8 filenames as mojibake where every
  // char is ≤ 0xFF — restore those. Names that already contain real unicode are kept as-is.
  if (/[\u0080-\u00ff]/.test(s) && !/[\u0100-\uffff]/.test(s)) {
    try {
      const utf8 = Buffer.from(s, 'latin1').toString('utf8');
      if (!utf8.includes('�')) s = utf8;
    } catch (_) {}
  }
  const base = s.split(/[\\/]/).pop();
  return base.replace(/[\x00-\x1f"'<>]/g, '').slice(0, 80) || 'file';
}

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
    'أهلاً 👋 أنا ماجد، مستشارك التعليمي في Engosoft. اسألني عن أي دورة أو عن تقدّمك في التعلّم.',
  // choice buttons sent right after the welcome text (values go to the bot as the user's message)
  welcomeChoicesText: process.env.WELCOME_CHOICES_TEXT || 'اختر ما يناسبك:',
  welcomeChoices: (process.env.WELCOME_CHOICES ||
    'أبحث عن كورس مناسب لي|أسعار الدورات|مجالات التدريب المتاحة|تواصل مع فريق المبيعات')
    .split('|').map((s) => s.trim()).filter(Boolean),
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
// Content hashes (computed once at boot) drive cache busting: the widget requests
// /majed-avatar.png?v=<hash> which is safe to cache for a year, while the bare
// URLs always revalidate so a redeploy is picked up immediately.
const PUBLIC_DIR = path.join(__dirname, 'public');
function fileSha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (_) {
    return '';
  }
}
const AVATAR_SHA = fileSha256(path.join(PUBLIC_DIR, 'majed-avatar.png'));
const WIDGET_SHA = fileSha256(path.join(PUBLIC_DIR, 'majed-widget.js'));

app.get('/majed-avatar.png', (req, res) => {
  // versioned URL → immutable; bare URL → always revalidate (304 when unchanged)
  res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (AVATAR_SHA) res.setHeader('X-Majed-Avatar-Sha', AVATAR_SHA.slice(0, 16));
  res.sendFile(path.join(PUBLIC_DIR, 'majed-avatar.png'));
});
app.get('/majed-widget.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache'); // ETag revalidation keeps clients on the latest widget
  if (WIDGET_SHA) res.setHeader('X-Majed-Widget-Sha', WIDGET_SHA.slice(0, 16));
  res.sendFile(path.join(PUBLIC_DIR, 'majed-widget.js'));
});
app.use(express.static(PUBLIC_DIR));

// ── Chatwoot Application API ───────────────────────────────────────
function cwHeaders() {
  return { 'Content-Type': 'application/json', api_access_token: config.chatwootApiToken };
}
function cwUrl(suffix) {
  return `${config.chatwootBaseUrl}/api/v1/accounts/${config.chatwootAccountId}/${suffix}`;
}

function cleanId(value) {
  const m = String(value || '').match(/\d+/);
  return m ? m[0] : '';
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

async function tryReuseConversation(convId) {
  const id = cleanId(convId);
  if (!id) return null;
  try {
    const conv = await cwGetConversation(id);
    const status = conv?.status || conv?.payload?.status || 'pending';
    if (status === 'resolved') {
      // Reopen so the bot can respond again (user picked this from history)
      await cwSetStatus(id, 'pending');
      convStatus.set(id, 'pending');
      return { conversationId: id, status: 'pending' };
    }
    convStatus.set(id, status);
    return { conversationId: id, status };
  } catch (e) {
    console.warn('conversation reuse failed:', e.response?.status || e.message);
    return null;
  }
}

// Find the most-recent Chatwoot conversation for a contact identified by email.
// Used by /widget/session to reuse the same Chatwoot thread when the user starts
// a "new conversation" in the widget (so agents see one unified thread per trainee).
async function findContactConversation(email) {
  if (!email) return null;
  try {
    const inboxId = await resolveInboxId();
    const { data } = await axios.get(
      `${config.chatwootBaseUrl}/api/v1/accounts/${config.chatwootAccountId}/contacts/search`,
      {
        params: { q: email, include_contacts: true, page: 1 },
        headers: cwHeaders(),
        timeout: 10000
      }
    );
    const contacts = data?.payload?.contacts || [];
    const contact = contacts.find((c) => c.email === email) || contacts[0];
    if (!contact) return null;

    const { data: cd } = await axios.get(
      cwUrl(`contacts/${contact.id}/conversations`),
      { headers: cwHeaders(), timeout: 10000 }
    );
    const conversations = (cd?.payload || [])
      .filter((c) => String(c.inbox_id) === String(inboxId))
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    if (!conversations.length) return null;
    const latest = conversations[0];
    return { conversationId: String(latest.id), status: latest.status };
  } catch (e) {
    console.warn('findContactConversation failed:', e.response?.status || e.message);
    return null;
  }
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

// Multipart message with attachment (native fetch/FormData — axios JSON path can't do files).
async function cwSendAttachmentMessage(convId, { buffer, mime, filename, caption }) {
  const fd = new FormData();
  fd.append('message_type', 'incoming');
  if (caption) fd.append('content', caption);
  fd.append('attachments[]', new Blob([buffer], { type: mime }), filename);
  const resp = await fetch(cwUrl(`conversations/${convId}/messages`), {
    method: 'POST',
    headers: { api_access_token: config.chatwootApiToken },
    body: fd,
  });
  if (!resp.ok) throw new Error(`chatwoot attachment upload failed: ${resp.status}`);
  return resp.json(); // { id, content, attachments: [{ file_type, data_url, thumb_url, file_size }] }
}

async function cwGetConversation(convId) {
  const { data } = await axios.get(cwUrl(`conversations/${convId}`), { headers: cwHeaders(), timeout: 15000 });
  return data;
}

async function cwListMessages(convId, before) {
  const url = cwUrl(`conversations/${convId}/messages`) + (before ? `?before=${before}` : '');
  const { data } = await axios.get(url, { headers: cwHeaders(), timeout: 15000 });
  return data?.payload || [];
}

async function cwSetConversationAttrs(convId, attrs) {
  let current = {};
  try {
    const conv = await cwGetConversation(convId);
    current = conv?.custom_attributes || conv?.payload?.custom_attributes || {};
  } catch (_) {}
  await axios.post(
    cwUrl(`conversations/${convId}/custom_attributes`),
    { custom_attributes: { ...current, ...(attrs || {}) } },
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

function mapAttachments(list) {
  return (Array.isArray(list) ? list : []).map((a) => ({
    file_type: a.file_type || 'file',
    data_url: a.data_url || '',
    thumb_url: a.thumb_url || '',
    file_size: a.file_size || 0,
  }));
}

function parseObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function cleanUrl(raw) {
  let url = String(raw || '').trim();
  while (/[)\]}>.,;!?،؛]/.test(url.slice(-1))) url = url.slice(0, -1);
  return url;
}

// «#mjd-media=image» is the bridge's own marker: appended to media URLs stored in
// Chatwoot text so the kind survives transcript reloads (fragments never reach servers).
const MJD_MEDIA_TAG = /#mjd-media=(image|video|audio|voice|file)\b/i;

function stripMediaTag(url) {
  return String(url || '').replace(MJD_MEDIA_TAG, '').replace(/#$/, '');
}

function mediaKindFromUrl(url) {
  const tagged = String(url || '').match(MJD_MEDIA_TAG);
  if (tagged) {
    const kind = tagged[1].toLowerCase();
    return kind === 'voice' ? 'audio' : kind;
  }
  const base = String(url || '').split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|webp|gif|svg)$/.test(base)) return 'image';
  if (/\.(mp4|webm|mov|m4v)$/.test(base)) return 'video';
  if (/\.(mp3|m4a|aac|ogg|oga|wav|webm)$/.test(base)) return 'audio';
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip)$/.test(base)) return 'file';
  // Botpress CDN uploads are often extension-less — assume image (the widget
  // degrades to a link chip on load error, so a wrong guess never breaks).
  if (/^https?:\/\/[^/]*\bbpcontent\.cloud\//i.test(base) || /^https?:\/\/files\.botpress\.cloud\//i.test(base)) return 'image';
  return '';
}

function mediaTitleFromUrl(url, kind) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name || (kind === 'image' ? 'image' : kind || 'file');
  } catch (_) {
    return kind === 'image' ? 'image' : kind || 'file';
  }
}

function detectMediaInText(text) {
  const body = String(text || '');
  const urls = body.match(/https?:\/\/[^\s<>"']+/g) || [];
  for (const raw of urls) {
    const url = cleanUrl(raw);
    const kind = mediaKindFromUrl(url);
    if (!kind) continue;
    let caption = body.replace(raw, '').replace(url, '').trim();
    caption = caption
      .replace(/!\[[^\]]*]\(\s*\)/g, '')
      .replace(/\[[^\]]*]\(\s*\)/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const captionAsTitle = caption && caption.length <= 80 && !caption.includes('\n');
    const cleanedUrl = stripMediaTag(url);
    return {
      kind,
      url: cleanedUrl,
      caption: captionAsTitle ? '' : caption,
      title: captionAsTitle ? caption : mediaTitleFromUrl(cleanedUrl, kind),
    };
  }
  return null;
}

function stripMediaUrlFromText(text, url) {
  let body = String(text || '').replace(MJD_MEDIA_TAG, '');
  if (!url) return body.trim();
  body = body.replace(url, '').trim();
  body = body.replace(/\n{3,}/g, '\n\n').trim();
  return body;
}

function shapeWidgetMessage(msg) {
  const attrs = parseObject(msg.content_attributes);
  let contentType = msg.content_type || 'text';
  let content = msg.content || '';
  let contentAttributes = attrs;

  if (contentType === 'media' && attrs.url) {
    const cleanedUrl = stripMediaTag(attrs.url);
    content = stripMediaUrlFromText(content, cleanedUrl);
    if (content === attrs.title) content = '';
    contentAttributes = {
      ...attrs,
      url: cleanedUrl,
      media_type: attrs.media_type || mediaKindFromUrl(attrs.url) || 'file',
      title: attrs.title || mediaTitleFromUrl(cleanedUrl, attrs.media_type || 'file'),
    };
  } else if (!contentType || contentType === 'text') {
    const media = detectMediaInText(content);
    if (media) {
      contentType = 'media';
      content = media.caption;
      contentAttributes = {
        media_type: media.kind,
        url: media.url,
        title: media.title,
        mime_type: attrs.mime_type || '',
      };
    }
  }

  return {
    id: msg.id,
    content,
    content_type: contentType || 'text',
    content_attributes: contentAttributes || {},
    sender: msg.sender?.type || (msg.message_type === 1 || msg.message_type === 'outgoing' ? 'agent' : 'contact'),
    attachments: mapAttachments(msg.attachments),
    created_at: msg.created_at || null,
  };
}

function writeSseMessage(res, msg) {
  const shaped = shapeWidgetMessage(msg);
  const data = JSON.stringify(shaped);
  res.write(`event: message\ndata: ${data}\n\n`);
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
  const set = sseClients.get(String(convId));
  if (!set || !set.size) return;
  if (msg.id != null) {
    const key = `cw-${msg.id}`;
    if (pushedIds.has(key)) return;
    pushedIds.add(key);
  }
  for (const res of set) {
    try {
      writeSseMessage(res, msg);
    } catch (_) {}
  }
}

async function sendRecentOutgoingToClient(convId, res) {
  try {
    const recent = (await cwListMessages(convId))
      .filter((m) => !m.private && (m.message_type === 1 || m.message_type === 'outgoing'))
      .slice(-12);
    for (const msg of recent) {
      try {
        writeSseMessage(res, msg);
      } catch (_) {
        break;
      }
    }
  } catch (e) {
    console.warn('stream catchup failed:', e.response?.status || e.message);
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

// Writing into a resolved conversation (picked from the widget history) revives it
// as "pending" so the bot answers again instead of staying muted.
async function reviveIfResolved(convId) {
  const status = await getConvStatus(convId);
  if (status !== 'resolved') return;
  try {
    await cwSetStatus(convId, 'pending');
    convStatus.set(convId, 'pending');
    console.log(`REVIVE conv ${convId}: resolved → pending`);
  } catch (e) {
    console.warn('revive failed:', e.response?.status || e.message);
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

async function bpCreateUser({ name, userData, cwConvId }) {
  // Botpress stores this under tags.profile and currently enforces a 500-char cap.
  // We embed _cw (chatwoot conversation id) so Execute Code cards can call Chatwoot API directly.
  let profile = '';
  try {
    let compact = {};
    try { compact = JSON.parse(compactProfile(userData) || '{}'); } catch (_) {}
    if (cwConvId) compact._cw = String(cwConvId);
    profile = JSON.stringify(compact).slice(0, 490);
  } catch (_) {
    if (cwConvId) profile = JSON.stringify({ _cw: String(cwConvId) });
  }
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

async function bpSendPayload(mapping, payload) {
  await axios.post(
    bpUrl('/messages'),
    { conversationId: mapping.bpConvId, payload },
    { headers: { 'Content-Type': 'application/json', 'x-user-key': mapping.userKey }, timeout: 20000 }
  );
}

async function bpSendText(mapping, text) {
  await bpSendPayload(mapping, { type: 'text', text });
}

// Handoff marker in bot replies: [[HANDOFF]] or [[HANDOFF:3]]
const HANDOFF_RE = /\[\[\s*HANDOFF(?::(\d+))?\s*\]\]/i;

async function performHandoff(cwConvId, teamId) {
  await cwSetStatus(cwConvId, 'open');
  convStatus.set(cwConvId, 'open');
  if (teamId) await cwAssign(cwConvId, { team_id: Number(teamId) });
  console.log(`HANDOFF conv ${cwConvId}${teamId ? ` → team ${teamId}` : ''} (status: open)`);
}

function pickText(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function normalizeAction(action) {
  const label = pickText(action?.label, action?.title, action?.text, action?.name, action?.value, action?.payload, 'اختيار');
  const url = pickText(action?.url, action?.uri, action?.href, action?.link);
  if (url) return { type: 'link', text: label, uri: url };
  return { type: 'postback', text: label, payload: pickText(action?.value, action?.payload, action?.id, label) };
}

function normalizeOptions(options) {
  return (Array.isArray(options) ? options : [])
    .map((o) => ({
      title: pickText(o?.label, o?.title, o?.text, o?.name, o?.value),
      value: pickText(o?.value, o?.payload, o?.id, o?.label, o?.title, o?.text),
    }))
    .filter((o) => o.title && o.value);
}

function mediaUrl(payload) {
  return pickText(
    payload?.url,
    payload?.fileUrl,
    payload?.imageUrl,
    payload?.audioUrl,
    payload?.videoUrl,
    payload?.mediaUrl,
    payload?.file?.url,
    payload?.image?.url,
    payload?.audio?.url,
    payload?.video?.url
  );
}

function normalizeCardItem(item) {
  const actions = item?.actions || item?.buttons || [];
  return {
    title: pickText(item?.title, item?.name, item?.text, 'عنصر'),
    description: pickText(item?.description, item?.subtitle, item?.body),
    media_url: mediaUrl(item),
    actions: (Array.isArray(actions) ? actions : []).map(normalizeAction),
  };
}

function normalizeBotMessages(payload) {
  const p = payload || {};
  const type = (p.type || 'text').toString().toLowerCase();
  const out = [];

  const options = normalizeOptions(p.options || p.choices || p.buttons);
  if (options.length) {
    out.push({
      content: pickText(p.text, p.title, 'اختار اللي يناسبك:'),
      contentType: 'input_select',
      contentAttributes: { items: options },
    });
    return out;
  }

  if (type === 'card') {
    out.push({
      content: pickText(p.text, p.prompt),
      contentType: 'cards',
      contentAttributes: { items: [normalizeCardItem(p)] },
    });
    return out;
  }

  if (type === 'carousel' || type === 'cards') {
    const rawItems = p.items || p.cards || p.elements || [];
    const items = (Array.isArray(rawItems) ? rawItems : []).map(normalizeCardItem).filter((it) => it.title || it.media_url);
    if (items.length) {
      out.push({ content: pickText(p.text, p.title), contentType: 'cards', contentAttributes: { items } });
      return out;
    }
  }

  const url = mediaUrl(p);
  if (url || ['image', 'audio', 'voice', 'video', 'file', 'document', 'attachment'].includes(type)) {
    const mediaType = type === 'voice' ? 'audio' : type === 'document' || type === 'attachment' ? 'file' : type === 'text' ? mediaKindFromUrl(url) || 'file' : type;
    const title = pickText(p.title, p.name, p.fileName, p.text, p.caption, mediaType);
    // Chatwoot keeps the URL as plain text — tag it so the kind survives transcript
    // reloads even for extension-less CDN links (fragment is invisible to the server).
    const storedUrl = url && !url.includes('#') ? `${url}#mjd-media=${mediaType}` : url;
    const content = [title, storedUrl].filter(Boolean).join('\n');
    out.push({
      content,
      widgetContentType: 'media',
      widgetContentAttributes: { media_type: mediaType, url: stripMediaTag(url), title, mime_type: p.mimeType || p.mime_type || '' },
    });
    return out;
  }

  const text = pickText(p.text, p.markdown, p.title, p.content);
  if (text) out.push({ content: text });
  return out;
}

// A bot reply arrived from Botpress (via SSE) → write to Chatwoot + push to widget.
async function handleBotReply(cwConvId, payload) {
  const messages = normalizeBotMessages(payload);
  for (const msg of messages) {
    let content = msg.content || '';
    const hm = content.match(HANDOFF_RE);
    if (hm) {
      content = content.replace(HANDOFF_RE, '').trim();
      try {
        await performHandoff(cwConvId, hm[1]);
      } catch (e) {
        console.error('handoff failed:', e.response?.data || e.message);
      }
    }
    if (!content && !msg.contentType) continue;

    const created = await cwSendMessage(cwConvId, {
      content,
      messageType: 'outgoing',
      contentType: msg.contentType,
      contentAttributes: msg.contentAttributes,
    });
    console.log(`OUT Chatwoot conv ${cwConvId} (bot): ${content.slice(0, 60) || msg.contentType || msg.widgetContentType}`);
    pushToWidget(cwConvId, {
      ...created,
      content,
      content_type: msg.widgetContentType || created.content_type || msg.contentType,
      content_attributes: msg.widgetContentAttributes || created.content_attributes || msg.contentAttributes || {},
    });
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
        ctxSig: attrs.bp_ctx_sig || '',
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
  const { userId, userKey } = await bpCreateUser({ name, userData, cwConvId });
  const bpConvId = await bpCreateConversation(userKey);
  mapping = { userId, userKey, bpConvId, ctxSig: '', lastActivity: Date.now(), stream: null, seen: lruSet(500) };
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

// Pre-warm the Botpress side for a freshly-established session, in the background.
// Creating the BP user + conversation and opening the SSE listener is the bulk of the
// FIRST customer message's latency; doing it now (right after /widget/session) means the
// plumbing is ready by the time the trainee actually types. Fire-and-forget — a Botpress
// outage must never delay or fail opening the widget. No message or context is sent here
// (that still happens on the first real message via forwardToBot), so bot behaviour is
// unchanged. Skipped while an agent is handling (status=open) since the bot is muted then.
function prewarmBotpress(cwConvId, status, ctx) {
  if (!bpConfigured() || status === 'open') return;
  ensureBotpress(cwConvId, ctx).catch((e) =>
    console.warn(`prewarm botpress failed (cw ${cwConvId}):`, e.response?.status || e.message)
  );
}

// Rich-but-compact trainee context. Injected ONCE into the first message of a
// Botpress conversation (and again only if the data changes) so the Autonomous
// Node LLM actually sees the name/courses — the chat `profile` tag alone is NOT
// read by the LLM. Sent to Botpress only: never written to Chatwoot or the widget.
function contextSummary(userData) {
  const d = userData || {};
  const out = {};
  const name = pickText(d.name, d.fullName, d.userFullName);
  const email = pickText(d.email, d.userEmail);
  if (name) out.name = name;
  if (email) out.email = email;
  if (d.enrolled_courses && String(d.enrolled_courses) !== '0') out.enrolled_courses = String(d.enrolled_courses);
  if (d.remaining_lessons && String(d.remaining_lessons) !== '0') out.remaining_lessons = String(d.remaining_lessons);
  if (d.progress_percent && String(d.progress_percent) !== '0') out.progress_percent = String(d.progress_percent);
  try {
    const courses = typeof d.courses_json === 'string' ? JSON.parse(d.courses_json) : d.courses_json;
    if (Array.isArray(courses) && courses.length) {
      out.courses = courses.slice(0, 3).map((c) => {
        const item = {
          name: pickText(c.course_name, c.name),
          progress: c.progress_percentage != null ? c.progress_percentage : c.progress,
        };
        if (c.remaining_lessons != null) item.remaining_lessons = c.remaining_lessons;
        const next = pickText(c.next_lesson && c.next_lesson.next_lesson_title, c.next_lesson_title);
        if (next) item.next_lesson = next;
        return item;
      });
    }
  } catch (_) {}
  if (!Object.keys(out).length) return '';
  return JSON.stringify(out).slice(0, 700);
}

// Trainee-context block, returned once per conversation (again only if the data changed).
function ctxBlockIfChanged(mapping, cwConvId, userData) {
  const ctx = contextSummary(userData);
  if (!ctx) {
    if (!mapping.ctxSig) console.log(`CTX empty (cw ${cwConvId}) — guest, or Odoo /ai_webhook/user_context returned no data`);
    return '';
  }
  const sig = crypto.createHash('md5').update(ctx).digest('hex').slice(0, 12);
  if (mapping.ctxSig === sig) return '';
  mapping.ctxSig = sig;
  cwSetConversationAttrs(cwConvId, { bp_ctx_sig: sig }).catch(() => {});
  console.log(`CTX → bot (cw ${cwConvId}): ${ctx.slice(0, 100)}`);
  return (
    'معلومات المتدرب (سياق داخلي من نظام Engosoft — استخدمه للترحيب بالاسم ومتابعة الكورسات، ولا تعرضه كنص خام):\n' + ctx
  );
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

  // Inject trainee context once per conversation (re-sent only when the data changes).
  const ctxBlock = ctxBlockIfChanged(mapping, cwConvId, userData);
  const outText = ctxBlock ? ctxBlock + '\n\n' + text : text;

  await bpSendText(mapping, outText);
  console.log(`SEND Botpress (cw ${cwConvId} → bp ${mapping.bpConvId}): ${text.slice(0, 60)}`);
}

// Forward a customer attachment to Botpress as a real media payload (status-gated).
async function forwardMediaToBot(cwConvId, media, { name, userData }) {
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

  const ctxBlock = ctxBlockIfChanged(mapping, cwConvId, userData);
  if (ctxBlock) await bpSendText(mapping, ctxBlock);

  const url = media.url || '';
  const title = safeFileName(media.name);
  let payload;
  if (!url) payload = { type: 'text', text: `(أرسل العميل ملف: ${title})` };
  else if (media.kind === 'image') payload = { type: 'image', imageUrl: url };
  else if (media.kind === 'audio') payload = { type: 'audio', audioUrl: url };
  else if (media.kind === 'video') payload = { type: 'video', videoUrl: url };
  else payload = { type: 'file', fileUrl: url, title };

  await bpSendPayload(mapping, payload);
  if (media.caption) await bpSendText(mapping, media.caption);
  console.log(`SEND Botpress media (cw ${cwConvId} → bp ${mapping.bpConvId}): ${media.kind} ${title}`);
}

// Reap idle Botpress listeners.
setInterval(() => {
  const now = Date.now();
  for (const [key, until] of bridgeIncomingEchoes) {
    if (until < now) bridgeIncomingEchoes.delete(key);
  }
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
    assets: { avatarSha: AVATAR_SHA.slice(0, 16) || null, widgetSha: WIDGET_SHA.slice(0, 16) || null },
  });
});

// 1) Widget opens → Chatwoot contact + conversation (Botpress side is created lazily
//    on first message, so sessions stay fast and Botpress outages can't block opening).
//
// One Chatwoot thread per trainee: when the user taps "new conversation" in the widget,
// we reuse their existing Chatwoot conversation (searching by email) so agents always
// see a single continuous thread, while the bot context starts fresh in Botpress.
app.post('/widget/session', async (req, res) => {
  try {
    const { name, email, userData, existingConversationId } = req.body || {};

    // ── Case 1: widget supplied an existing Chatwoot conv ID (resume or history open)
    const reusable = await tryReuseConversation(existingConversationId);
    if (reusable) {
      console.log(`Widget session reuse: conv ${reusable.conversationId} (${reusable.status})`);
      prewarmBotpress(reusable.conversationId, reusable.status, { name, userData });
      return res.json({ conversationId: reusable.conversationId, reused: true, status: reusable.status });
    }

    // ── Case 2: no conv ID (new conversation button) — search for existing contact
    //    by email so we keep one Chatwoot thread per trainee.
    if (email) {
      const existing = await findContactConversation(email);
      if (existing) {
        const cvId = existing.conversationId;
        // Reopen if resolved so the bot can respond
        if (existing.status === 'resolved') {
          try { await cwSetStatus(cvId, 'pending'); } catch (_) {}
          convStatus.set(cvId, 'pending');
        }
        // Clear the Botpress mapping so the AI starts a fresh context while the
        // Chatwoot thread continues (new bot conversation, same agent thread).
        bpMap.delete(cvId);
        const cleared = cwSetConversationAttrs(cvId, {
          bp_user_id: '', bp_user_key: '', bp_conv_id: '', bp_ctx_sig: ''
        }).catch(() => {});
        // Pre-warm a FRESH Botpress context, but only after the stale mapping is cleared,
        // so ensureBotpress doesn't recover the bp_* attributes we just wiped.
        cleared.then(() => prewarmBotpress(cvId, 'pending', { name, userData }));
        console.log(`Widget session reuse-by-email (${email}): conv ${cvId} — bot context reset`);
        return res.json({ conversationId: cvId, reused: true, status: 'pending' });
      }
    }

    // ── Case 3: truly new user — create contact + conversation
    const { contactId, sourceId } = await cwCreateContact({ name, email, customAttributes: userData || {} });
    const convId = await cwCreateConversation(sourceId);
    try {
      await cwSetStatus(convId, 'pending');
    } catch (e) {
      console.warn('set pending failed:', e.response?.status || e.message);
    }
    convStatus.set(convId, 'pending');
    console.log(`Widget session new: contact ${contactId} → conv ${convId}`);
    prewarmBotpress(convId, 'pending', { name, userData });
    return res.json({ conversationId: convId, reused: false, status: 'pending' });
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
  sendRecentOutgoingToClient(convId, res);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25000);
  req.on('close', () => { clearInterval(ping); removeClient(convId, res); });

  if (config.welcomeEnabled && !welcomedConvs.has(convId)) {
    welcomedConvs.add(convId);
    try {
      const conv = await cwGetConversation(convId).catch(() => null);
      const attrs = conv?.custom_attributes || conv?.payload?.custom_attributes || {};
      if (!attrs.majed_welcome_sent) {
        const m1 = await cwSendMessage(convId, { content: config.welcomeText, messageType: 'outgoing' });
        pushToWidget(convId, m1);
        if (config.welcomeChoices.length) {
          const choiceAttrs = { items: config.welcomeChoices.map((t) => ({ title: t, value: t })) };
          const m1b = await cwSendMessage(convId, {
            content: config.welcomeChoicesText,
            messageType: 'outgoing',
            contentType: 'input_select',
            contentAttributes: choiceAttrs,
          });
          pushToWidget(convId, {
            ...m1b,
            content: config.welcomeChoicesText,
            content_type: 'input_select',
            content_attributes: m1b.content_attributes || choiceAttrs,
          });
        }
        if (config.welcomeCardEnabled) {
          const c = welcomeCard();
          const m2 = await cwSendMessage(convId, {
            content: c.content, messageType: 'outgoing', contentType: c.contentType, contentAttributes: c.contentAttributes,
          });
          pushToWidget(convId, m2);
        }
        cwSetConversationAttrs(convId, { majed_welcome_sent: 'true' }).catch((e) =>
          console.warn('welcome persist failed:', e.response?.status || e.message)
        );
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

    // a) Record in Chatwoot (source of truth) and forward to the bot CONCURRENTLY, so the
    //    bot starts thinking without waiting on the Chatwoot round-trip. The content-based
    //    echo key (set before the write) already stops the webhook from re-forwarding this
    //    same message, so the id registered in .then is just belt-and-suspenders.
    markBridgeIncoming(convId, null, text);
    const cwWrite = cwSendMessage(convId, { content: text, messageType: 'incoming' })
      .then((created) => { markBridgeIncoming(convId, created, text); })
      .catch((e) => console.error('cw incoming write failed:', e.response?.data || e.message));

    await reviveIfResolved(convId);

    // b) Botpress Chat API (status-gated). Bot replies return via SSE listener.
    try {
      await forwardToBot(convId, text, { name: userData.name, userData });
    } catch (e) {
      // Never fail the customer's message because the bot is down.
      console.error('forwardToBot failed:', e.response?.data || e.message);
    }

    await cwWrite; // ensure the Chatwoot record settled before acking the widget
    return res.json({ status: 'ok' });
  } catch (err) {
    console.error('message error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'message_failed' });
  }
});

// 3b) Customer attachment from the widget («اضافة ملفات»).
//     multipart: file + conversationId (+ caption + userData JSON)
app.post('/widget/upload', uploadMw.single('file'), async (req, res) => {
  try {
    const convId = cleanId(req.body?.conversationId);
    const caption = String(req.body?.caption || '').trim().slice(0, 2000);
    let userData = {};
    try { userData = JSON.parse(req.body?.userData || '{}') || {}; } catch (_) {}
    if (!convId) return res.status(400).json({ error: 'missing_conversation' });
    if (!req.file) return res.status(400).json({ error: 'missing_file' });

    const kind = mimeKind(req.file.mimetype);
    if (!kind) return res.status(415).json({ error: 'unsupported_type' });

    const filename = safeFileName(req.file.originalname);
    console.log(`IN widget conv ${convId}: 📎 ${filename} (${req.file.mimetype}, ${req.file.size}b)`);

    // a) Chatwoot first (source of truth) — attachment + optional caption.
    markBridgeIncoming(convId, null, caption);
    const created = await cwSendAttachmentMessage(convId, {
      buffer: req.file.buffer,
      mime: req.file.mimetype,
      filename,
      caption,
    });
    markBridgeIncoming(convId, created, caption);
    await reviveIfResolved(convId);

    const att = (created.attachments || [])[0] || {};
    const url = att.data_url || '';

    // b) Botpress gets the hosted URL as a real media payload (vision-ready for images).
    try {
      await forwardMediaToBot(convId, { kind, url, name: filename, caption }, { name: userData.name, userData });
    } catch (e) {
      console.error('forwardMediaToBot failed:', e.response?.data || e.message);
    }

    return res.json({
      status: 'ok',
      message: {
        id: created.id,
        url,
        thumb_url: att.thumb_url || '',
        file_type: att.file_type || kind,
        name: filename,
        size: req.file.size,
      },
    });
  } catch (err) {
    console.error('upload error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'upload_failed' });
  }
});

// 3c) Conversation transcript for the widget (restore on reopen / history switch).
app.get('/widget/messages', async (req, res) => {
  try {
    const convId = cleanId(req.query.conversationId);
    if (!convId) return res.status(400).json({ error: 'missing_conversation' });

    // up to 3 pages (~60 messages), oldest → newest
    let all = [];
    let before = null;
    for (let page = 0; page < 3; page++) {
      const batch = await cwListMessages(convId, before);
      if (!batch.length) break;
      all = batch.concat(all);
      before = batch[0]?.id;
      if (batch.length < 20) break;
    }

    const messages = all
      .filter((m) => {
        if (m.private) return false;
        const t = m.message_type;
        return t === 0 || t === 1 || t === 'incoming' || t === 'outgoing';
      })
      .map((m) => shapeWidgetMessage(m));

    return res.json({ conversationId: convId, messages });
  } catch (err) {
    console.error('messages error:', err.response?.status || err.message);
    return res.status(500).json({ error: 'messages_failed' });
  }
});

// 3d) Conversation summaries for the widget history list.
//     GET /widget/conversations?ids=12,15,18 (the widget remembers its own ids locally)
app.get('/widget/conversations', async (req, res) => {
  try {
    const ids = [...new Set(String(req.query.ids || '').split(',').map(cleanId).filter(Boolean))].slice(0, 15);
    if (!ids.length) return res.json({ conversations: [] });

    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const conv = await cwGetConversation(id);
        const c = conv?.payload || conv || {};
        const last = c.last_non_activity_message || {};
        const preview = String(last.content || ((last.attachments || []).length ? '📎 مرفق' : '')).slice(0, 140);
        return {
          id,
          status: c.status || 'pending',
          last_message: preview,
          last_at: c.last_activity_at || last.created_at || c.timestamp || null,
        };
      })
    );

    return res.json({
      conversations: results.filter((r) => r.status === 'fulfilled').map((r) => r.value),
    });
  } catch (err) {
    console.error('conversations error:', err.message);
    return res.status(500).json({ error: 'conversations_failed' });
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

    const isOutgoing = p.message_type === 'outgoing' || p.message_type === 1;
    const isIncoming = p.message_type === 'incoming' || p.message_type === 0;

    if (p.private) {
      console.log(`SKIP private note conv ${convId}`);
      return res.status(200).json({ status: 'skipped', reason: 'private' });
    }

    if (isOutgoing) {
      if (p.conversation?.status) convStatus.set(convId, p.conversation.status);
      // Human agent (or flow) reply → widget. Never re-forwarded to Botpress.
      pushToWidget(convId, {
        id: p.id,
        content: p.content,
        content_type: p.content_type,
        content_attributes: p.content_attributes,
        attachments: p.attachments,
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
      if (p.conversation?.status) convStatus.set(convId, p.conversation.status);
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

// Multer/body errors → clean JSON (413 for oversize uploads instead of an HTML stack).
app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file_too_large', maxMb: MAX_UPLOAD_MB });
  }
  console.error('unhandled error:', err.message);
  return res.status(500).json({ error: 'internal_error' });
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
