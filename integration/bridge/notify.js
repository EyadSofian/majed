/**
 * Operational notifications for Majed.
 *
 * The preferred transport is the configured n8n webhook. Notifications are
 * best-effort: a failed alert must never break a customer conversation.
 */
const axios = require('axios');

let post = (url, body, options) => axios.post(url, body, options);

// Test hook; production uses axios.
function setHttp(fn) {
  post = fn || ((url, body, options) => axios.post(url, body, options));
}

function line(label, value) {
  return value ? `${label}: ${value}\n` : '';
}

function compose(kind, data = {}) {
  if (kind === 'live_chat') {
    return {
      subject: `🟢 محادثة جديدة مع ماجد — ${data.name || 'زائر'}`,
      text:
        'عميل بدأ محادثة مع ماجد الآن.\n\n' +
        line('الاسم', data.name) +
        line('الإيميل', data.email) +
        line('أول رسالة', data.message) +
        line('الصفحة', data.page) +
        line('محادثة Chatwoot', data.convUrl || data.convId),
    };
  }
  if (kind === 'handoff') {
    return {
      subject: `🙋 عميل محتاج تدخل بشري — ${data.reason || 'تحويل'}`,
      text:
        'ماجد حوّل محادثة لفريق خدمة العملاء.\n\n' +
        line('السبب', data.reason) +
        line('ملخص', data.summary) +
        line('محادثة Chatwoot', data.convUrl || data.convId),
    };
  }
  return { subject: `Majed notification: ${kind}`, text: JSON.stringify(data) };
}

const enabled = {
  live_chat: (cfg) => cfg.notifyOnLiveChat,
  handoff: (cfg) => cfg.notifyOnHandoff,
};

async function notify(config, kind, data = {}) {
  const gate = enabled[kind];
  if (gate && !gate(config)) return { sent: false, reason: 'disabled' };

  const { subject, text } = compose(kind, data);
  if (!config.notifyWebhookUrl) return { sent: false, reason: 'no_transport', subject, text };

  try {
    await post(config.notifyWebhookUrl, { kind, subject, text, ...data }, {
      headers: config.notifyWebhookToken
        ? { 'X-Notify-Token': config.notifyWebhookToken }
        : {},
      timeout: 10000,
    });
    return { sent: true, via: 'webhook', subject, text };
  } catch (error) {
    console.warn(`notify(${kind}) failed:`, error.message);
    return { sent: false, reason: error.message, subject, text };
  }
}

module.exports = { notify, compose, setHttp };
