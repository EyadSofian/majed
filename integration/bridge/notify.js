/**
 * Email notifications for ماجد (SMTP).
 *
 * Two layers on purpose:
 *   - compose(kind, data) is PURE (kind + data -> {subject, text}) and fully
 *     unit-tested, so the wording of every alert is verified without a network.
 *   - notify(config, kind, data) decides whether to send (a recipient is set
 *     AND this kind is toggled on), lazy-builds a nodemailer transport from the
 *     SMTP config, sends, and NEVER throws — a failed alert must never break a
 *     customer conversation.
 *
 * With no SMTP host configured the notifier is inert: it returns
 * {sent:false, reason:'no_transport'} and the bridge runs exactly the same. A
 * test injects a fake transport via setTransport(), so the whole path runs with
 * neither SMTP credentials nor nodemailer installed.
 */

// undefined = not built yet · null = no creds/unavailable · object = ready
let _transport;

// Test hook: inject a transport, or pass undefined to force a rebuild.
function setTransport(t) {
  _transport = t;
}

function getTransport(config) {
  if (_transport !== undefined) return _transport;
  if (!config.smtpHost) {
    _transport = null;
    return null;
  }
  try {
    const nodemailer = require('nodemailer');
    _transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
    });
  } catch (e) {
    console.warn('notify: nodemailer unavailable —', e.message);
    _transport = null;
  }
  return _transport;
}

function line(label, val) {
  return val ? `${label}: ${val}\n` : '';
}

// kind -> {subject, text}. Pure; safe to call and assert on directly.
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
  if (kind === 'lead') {
    return {
      subject: `📇 بيانات عميل جديدة من ماجد${data.name ? ` — ${data.name}` : ''}`,
      text:
        'ماجد التقط بيانات عميل مهتم.\n\n' +
        line('الاسم', data.name) +
        line('الهاتف', data.phone) +
        line('الإيميل', data.email) +
        line('المجال', data.field) +
        line('التخصص', data.specialization) +
        line('سنوات الخبرة', data.experience) +
        line('مهتم بـ', data.course_interest) +
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

const ENABLED = {
  live_chat: (c) => c.notifyOnLiveChat,
  lead: (c) => c.notifyOnLead,
  handoff: (c) => c.notifyOnHandoff,
};

async function notify(config, kind, data = {}) {
  if (!config.notifyEmailTo) return { sent: false, reason: 'no_recipient' };
  const gate = ENABLED[kind];
  if (gate && !gate(config)) return { sent: false, reason: 'disabled' };
  const { subject, text } = compose(kind, data);
  const transport = getTransport(config);
  if (!transport) return { sent: false, reason: 'no_transport', subject, text };
  try {
    await transport.sendMail({
      from: config.notifyEmailFrom || config.notifyEmailTo,
      to: config.notifyEmailTo,
      subject,
      text,
    });
    return { sent: true, subject, text };
  } catch (e) {
    console.warn(`notify(${kind}) failed:`, e.message);
    return { sent: false, reason: e.message, subject, text };
  }
}

module.exports = { notify, compose, getTransport, setTransport };
