const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const config = {
  chatwootBaseUrl: (process.env.CHATWOOT_BASE_URL || process.env.CHATWOOT_URL || '').replace(/\/$/, ''),
  chatwootAccountId: process.env.CHATWOOT_ACCOUNT_ID || '',
  chatwootApiToken: process.env.CHATWOOT_API_TOKEN || process.env.CHATWOOT_API_KEY || '',
  botpressWebhookUrl: process.env.BOTPRESS_WEBHOOK_URL || '',
  botpressPat: process.env.BOTPRESS_PAT || '',

  // ── «نور» proactive welcome (sent when a conversation first opens) ──
  welcomeEnabled: (process.env.WELCOME_ENABLED || 'true').toLowerCase() !== 'false',
  welcomeText:
    process.env.WELCOME_TEXT ||
    'أهلاً 👋 أنا ماجد، مستشارك التعليمي في Engosoft. اسألني عن دوراتك وتقدّمك، أو اختر وسيلة تواصل 👇',
  waNumber: (process.env.WA_NUMBER || '966920016295').replace(/[^\d]/g, ''),
  supportEmail: process.env.SUPPORT_EMAIL || 'aibot@engosoft.com',
  welcomeCardTitle: process.env.WELCOME_CARD_TITLE || 'تواصل مع Engosoft',
};

function requireConfig(requiredKeys) {
  const missing = requiredKeys.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables for: ${missing.join(', ')}`);
  }
}

function botpressHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (config.botpressPat) {
    headers.Authorization = `Bearer ${config.botpressPat}`;
  }
  return headers;
}

function extractChatwootConversationId(body) {
  const candidates = [
    body.metadata?.chatwootConvId,
    body.metadata?.chatwoot_conversation_id,
    body.chatwootConvId,
    body.chatwoot_conversation_id,
    body.conversationId,
    body.botpressConversationId,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const value = String(candidate);
    const match = value.match(/(?:chatwoot-conv-|cw_conv_0*)(\d+)/);
    if (match) return match[1];
    if (/^\d+$/.test(value)) return value;
  }

  return null;
}

// Build a Chatwoot message body from a Botpress message item.
// Supports plain text AND interactive messages (cards / input_select / form).
function buildChatwootMessage(item) {
  if (!item || typeof item !== 'object') return null;

  const contentType = item.content_type || item.payload?.content_type;
  const contentAttributes = item.content_attributes || item.payload?.content_attributes;
  const text =
    item.text || item.payload?.text || item.message?.payload?.text || item.content;

  // Interactive message (buttons / cards / form) — Botpress sends content_type.
  if (contentType && contentType !== 'text' && contentAttributes) {
    return {
      content: typeof text === 'string' ? text : item.content || '',
      content_type: contentType,
      content_attributes: contentAttributes,
      message_type: 'outgoing',
      private: false,
    };
  }

  // Plain text message.
  if (typeof text === 'string' && text.trim().length > 0) {
    return { content: text, message_type: 'outgoing', private: false };
  }

  return null;
}

// Collect all outgoing messages (text + interactive) from a Botpress response.
function extractBotpressMessages(body) {
  const items = [];
  if (Array.isArray(body.responses)) items.push(...body.responses);
  if (Array.isArray(body.messages)) items.push(...body.messages);
  if (items.length === 0) items.push(body); // single message-shaped body

  return items.map(buildChatwootMessage).filter(Boolean);
}

// Collect handoff / assignment / status actions. Botpress decides WHEN + WHICH team.
//   { "type": "handoff", "team_id": 5 }      -> status open + assign team
//   { "type": "assign",  "assignee_id": 12 } -> assign a specific agent
//   { "type": "status",  "status": "resolved" }
function extractBotpressActions(body) {
  const actions = [];
  if (Array.isArray(body.actions)) actions.push(...body.actions);
  if (body.action && typeof body.action === 'object') actions.push(body.action);
  // shorthand: handoff: true  OR  handoff: { team_id: 5 }
  if (body.handoff) {
    actions.push(
      typeof body.handoff === 'object'
        ? { type: 'handoff', ...body.handoff }
        : { type: 'handoff' }
    );
  }
  return actions.filter((a) => a && a.type);
}

function chatwootHeaders() {
  return {
    'Content-Type': 'application/json',
    api_access_token: config.chatwootApiToken,
  };
}

function chatwootConversationUrl(convId, suffix) {
  return `${config.chatwootBaseUrl}/api/v1/accounts/${config.chatwootAccountId}/conversations/${convId}/${suffix}`;
}

async function chatwootSendMessage(convId, messageBody) {
  await axios.post(chatwootConversationUrl(convId, 'messages'), messageBody, {
    headers: chatwootHeaders(),
    timeout: 15000,
  });
}

// «نور» welcome: greeting text + an interactive contact card (WhatsApp / Email
// links + Voice postback). Rendered natively inside the Chatwoot widget AND the
// agent inbox. Sent once, when a conversation is first created (chat opened).
function buildWelcomeContactCard() {
  return {
    content: 'طرق التواصل المباشر:',
    content_type: 'cards',
    content_attributes: {
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
    message_type: 'outgoing',
    private: false,
  };
}

async function chatwootSendWelcome(convId) {
  // 1) greeting bubble
  await chatwootSendMessage(convId, {
    content: config.welcomeText,
    message_type: 'outgoing',
    private: false,
  });
  // 2) interactive contact card
  await chatwootSendMessage(convId, buildWelcomeContactCard());
}

async function chatwootSetStatus(convId, status) {
  await axios.post(
    chatwootConversationUrl(convId, 'toggle_status'),
    { status },
    { headers: chatwootHeaders(), timeout: 15000 }
  );
}

async function chatwootAssign(convId, { team_id, assignee_id }) {
  const body = {};
  if (assignee_id) body.assignee_id = assignee_id;
  if (team_id) body.team_id = team_id;
  if (Object.keys(body).length === 0) return;
  await axios.post(chatwootConversationUrl(convId, 'assignments'), body, {
    headers: chatwootHeaders(),
    timeout: 15000,
  });
}

app.get('/', (_req, res) => {
  res.json({
    status: 'running',
    endpoints: {
      chatwoot: '/chatwoot/webhook',
      botpressWebhook: '/botpress/webhook',
      botpressResponse: '/botpress/response',
    },
  });
});

app.post('/chatwoot/webhook', async (req, res) => {
  try {
    const payload = req.body;
    console.log('Chatwoot webhook:', payload.event || payload.message_type, payload.content?.substring(0, 50));

    // ── «نور» proactive welcome on chat open ──
    // Chatwoot fires `conversation_created` the moment a visitor opens the widget.
    // We answer immediately with the greeting + contact card, so the experience
    // matches the «نور» empty state (no need to wait for the first user message).
    if (payload.event === 'conversation_created') {
      if (!config.welcomeEnabled) {
        return res.status(200).json({ status: 'skipped', reason: 'welcome_disabled' });
      }
      requireConfig(['chatwootBaseUrl', 'chatwootAccountId', 'chatwootApiToken']);
      const newConvId = String(payload.id || payload.conversation?.id || '');
      if (!newConvId) {
        return res.status(200).json({ status: 'skipped', reason: 'no_conversation_id' });
      }
      await chatwootSendWelcome(newConvId);
      console.log(`Welcome sent to conv ${newConvId}`);
      return res.status(200).json({ status: 'welcome_sent' });
    }

    requireConfig(['botpressWebhookUrl']);

    if (payload.message_type !== 'incoming') {
      return res.status(200).json({ status: 'skipped', reason: 'not_incoming' });
    }

    if (!payload.content || !payload.conversation?.id) {
      return res.status(200).json({ status: 'skipped', reason: 'missing_content_or_conversation' });
    }

    const chatwootConvId = String(payload.conversation.id);
    const chatwootUserId = String(payload.sender?.id || 'unknown');
    const messageId = String(payload.id || Date.now());

    // Trainee context that Odoo pushed into Chatwoot as contact attributes.
    // Chatwoot includes these on the message_created webhook's sender object,
    // so we forward them to Botpress — that's how Majed "sees" the trainee
    // (courses, progress, etc.) instead of only the human agent seeing them.
    const sender = payload.sender || {};
    const conversationSender = payload.conversation?.meta?.sender || {};
    const contextAttributes = {
      ...(conversationSender.custom_attributes || {}),
      ...(sender.additional_attributes || {}),
      ...(sender.custom_attributes || {}),
    };

    await axios.post(
      config.botpressWebhookUrl,
      {
        userId: `chatwoot-user-${chatwootUserId}`,
        messageId: `msg-${messageId}`,
        conversationId: `chatwoot-conv-${chatwootConvId}`,
        type: 'text',
        text: payload.content,
        payload: {
          type: 'text',
          text: payload.content,
        },
        // Top-level so a Botpress flow can read it directly from the event.
        userData: contextAttributes,
        metadata: {
          chatwootConvId,
          chatwootUserId,
          senderName: sender.name || '',
          senderEmail: sender.email || '',
          // Trainee context (courses_json, progress_percent, ... ) — may be
          // empty for anonymous visitors.
          ...contextAttributes,
        },
      },
      {
        headers: botpressHeaders(),
        timeout: 30000,
      }
    );

    console.log('Sent to Botpress');
    return res.status(200).json({ status: 'sent' });
  } catch (error) {
    console.error('Chatwoot webhook error:', error.response?.data || error.message);
    return res.status(500).json({ error: error.message });
  }
});

async function handleBotpressResponse(req, res) {
  try {
    requireConfig(['chatwootBaseUrl', 'chatwootAccountId', 'chatwootApiToken']);

    const payload = req.body;
    const chatwootConvId = extractChatwootConversationId(payload);

    if (!chatwootConvId) {
      return res.status(400).json({ error: 'missing chatwoot conversation id' });
    }

    const messages = extractBotpressMessages(payload);
    const actions = extractBotpressActions(payload);

    if (messages.length === 0 && actions.length === 0) {
      return res.status(200).json({ status: 'skipped', reason: 'no_message_or_action' });
    }

    // 1) Send messages (text + interactive cards/buttons) in order.
    for (const message of messages) {
      await chatwootSendMessage(chatwootConvId, message);
    }

    // 2) Run actions. Botpress owns the routing logic (which team, when).
    for (const action of actions) {
      const type = String(action.type).toLowerCase();
      if (type === 'handoff') {
        await chatwootSetStatus(chatwootConvId, 'open');
        await chatwootAssign(chatwootConvId, {
          team_id: action.team_id,
          assignee_id: action.assignee_id,
        });
        console.log(
          `Handoff conv ${chatwootConvId} -> open` +
            (action.team_id ? ` | team ${action.team_id}` : '') +
            (action.assignee_id ? ` | agent ${action.assignee_id}` : '')
        );
      } else if (type === 'assign') {
        await chatwootAssign(chatwootConvId, {
          team_id: action.team_id,
          assignee_id: action.assignee_id,
        });
      } else if (type === 'status') {
        await chatwootSetStatus(chatwootConvId, action.status || 'open');
      }
    }

    console.log(
      `Conv ${chatwootConvId}: sent ${messages.length} message(s), ${actions.length} action(s)`
    );
    return res
      .status(200)
      .json({ status: 'sent', messages: messages.length, actions: actions.length });
  } catch (error) {
    console.error('Botpress response error:', error.response?.data || error.message);
    return res.status(500).json({ error: error.message });
  }
}

app.post('/botpress/webhook', handleBotpressResponse);
app.post('/botpress/response', handleBotpressResponse);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const missing = [];
  if (!config.botpressWebhookUrl) missing.push('BOTPRESS_WEBHOOK_URL');
  if (!config.chatwootBaseUrl) missing.push('CHATWOOT_BASE_URL or CHATWOOT_URL');
  if (!config.chatwootAccountId) missing.push('CHATWOOT_ACCOUNT_ID');
  if (!config.chatwootApiToken) missing.push('CHATWOOT_API_TOKEN or CHATWOOT_API_KEY');

  console.log(`Bridge server running on port ${PORT}`);
  if (missing.length > 0) {
    console.warn(`Missing configuration: ${missing.join(', ')}`);
  }
});
