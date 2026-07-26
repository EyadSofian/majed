/**
 * نبراس router — lets the new brain answer inside the EXISTING Majed widget.
 *
 * Design goals, in priority order:
 *   1. **Instant rollback.** `NABRAS_ENABLED=false` (or unset) and this file is
 *      inert: every message goes to Botpress exactly as before. No code change,
 *      no redeploy of the widget, no data migration to undo.
 *   2. **Never worse for the customer.** Any failure — disabled, not allowed,
 *      network, timeout, bad JSON — returns false and Botpress answers the same
 *      message. The visitor cannot tell anything was attempted.
 *   3. **Allowlist before everyone.** `NABRAS_ALLOW` is a list of emails; only
 *      those get the new brain. Real customers are untouched until you widen it.
 *   4. **No widget change.** Replies are pushed as ordinary Chatwoot-shaped
 *      messages, and course cards use the `cards` content type the widget
 *      already renders. Token streaming needs a widget update and is phase 2 —
 *      keeping the live widget byte-identical is what makes this reversible.
 *
 * The customer-facing name is ماجد throughout; "nabras" is only the service.
 */
const axios = require('axios');

const cfg = () => ({
  enabled: String(process.env.NABRAS_ENABLED || '').toLowerCase() === 'true',
  base: (process.env.NABRAS_URL || '').replace(/\/$/, ''),
  allow: String(process.env.NABRAS_ALLOW || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
  timeoutMs: Number(process.env.NABRAS_TIMEOUT_MS || 25000),
  // Last-resort default only. The real currency comes from the site itself —
  // see resolveCurrency().
  currency: process.env.NABRAS_CURRENCY || 'EGP',
});

const SUPPORTED = ['EGP', 'USD', 'AED', 'SAR'];
// Only used when the site did not tell us. Maps the browser's IANA timezone to
// the storefront currency, since the visitor's region is what Odoo keys on too.
const TZ_CURRENCY = [
  [/^Africa\/Cairo/i, 'EGP'],
  [/^Asia\/(Riyadh|Qatar|Bahrain|Kuwait|Aden)/i, 'SAR'],
  [/^Asia\/(Dubai|Muscat)/i, 'AED'],
];

/**
 * What currency is this visitor actually being shown?
 *
 * Odoo already resolved it per visitor (website pricelist follows country /
 * geoip / the customer's own pricelist) and the page beside the chat is
 * rendering prices in it. So we ask the site, and only guess if it stayed
 * silent. Hardcoding one currency quotes a Saudi visitor in Egyptian pounds.
 */
function resolveCurrency(userData) {
  const up = (v) => String(v || '').trim().toUpperCase();
  // 1. authoritative: the website's active pricelist, via /ai_webhook/user_context
  const fromSite = up(userData?.shop?.currency || userData?.currency);
  if (SUPPORTED.includes(fromSite)) return fromSite;
  // 2. the visitor's browser region
  const tz = String(userData?.timezone || userData?.tz || '');
  for (const [re, cur] of TZ_CURRENCY) if (re.test(tz)) return cur;
  // 3. configured default
  const fallback = up(cfg().currency);
  return SUPPORTED.includes(fallback) ? fallback : 'EGP';
}

/**
 * Which language is this visitor reading the site in?
 *
 * Course names in Odoo are translated, so the answer decides whether the chat
 * says «تصميم أنظمة التيار الخفيف» — the title on the page beside it — or
 * "Light Current Systems Design". Odoo knows it exactly (it rendered the page),
 * so we take its code; the widget's `<html lang>` is the fallback, and the
 * browser writes that as `ar-001` where Odoo stores `ar_001`.
 */
function resolveLang(userData) {
  const raw = String(userData?.shop?.lang || userData?.lang || '').trim();
  return /^[a-z]{2}([_-][A-Za-z0-9]{2,4})?$/.test(raw) ? raw.replace('-', '_') : '';
}

// guest tokens are per-conversation and cheap; reuse until they expire
const tokens = new Map(); // cwConvId -> { token, at }
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

function allowed(userData) {
  const c = cfg();
  if (!c.enabled || !c.base) return false;
  if (c.allow.includes('*')) return true;            // everyone (final stage)
  const email = String(userData?.email || userData?.userEmail || '').toLowerCase();
  return Boolean(email) && c.allow.includes(email);
}

async function guestToken(cwConvId) {
  const c = cfg();
  const hit = tokens.get(cwConvId);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token;
  const { data } = await axios.post(
    `${c.base}/api/v1/user/guest-session/create/`, {}, { timeout: 10000 });
  const token = data?.data?.guest_token;
  if (!token) throw new Error('no guest_token in response');
  tokens.set(cwConvId, { token, at: Date.now() });
  return token;
}

/**
 * Cards -> what the widget renders.
 *
 * Fields are passed STRUCTURED (price, rating, instructor, seats as their own
 * keys) instead of pre-joined into one grey line: a price is not a sentence,
 * and the widget cannot lay out what it cannot tell apart. `description` and
 * `actions` are still filled so a cached older widget keeps working.
 *
 * Tracks come before courses — the track is the headline the courses sit under.
 */
// Odoo's duration/certificate fields are free text and sometimes hold a whole
// sentence. A chip is a glance, not a paragraph.
const chip = (v, max = 26) => {
  const t = String(v || '').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

// Odoo returns course_duration_text in the bot user's language (English), so a
// card of otherwise-Arabic chips showed "24 Training Hours" among them. Render
// the hours count in Arabic; leave anything without an hours pattern untouched.
const fmtDuration = (v) => {
  const t = String(v || '').trim();
  if (!t) return '';
  const m = t.match(/(\d+)/);
  if (m && /hour|hrs?\b|ساع/i.test(t)) return `${m[1]} ساعة تدريبية`;
  return t;
};

function toWidgetCards(courseCards = [], packageCards = [], instructorCards = []) {
  const items = [];
  for (const i of instructorCards) {
    items.push({
      kind: 'instructor',
      instructor_id: i.id,
      title: i.name,
      job_title: i.title || '',
      department: i.department || '',
      media_url: i.image_url || '',
      courses_count: i.courses_count || 0,
      teaches: (i.teaches || []).slice(0, 4),
      bio: i.bio || '',
      sections: (i.sections || []).slice(0, 3),
      // legacy fallback
      description: [i.title, i.courses_count ? `${i.courses_count} كورس` : '']
        .filter(Boolean).join(' · '),
      actions: [],
    });
  }
  for (const p of packageCards) {
    const bits = [];
    if (p.price_from_display) bits.push(`يبدأ من ${p.price_from_display}`);
    if (p.courses_count) bits.push(`${p.courses_count} كورس`);
    if (p.training_hours) bits.push(`${p.training_hours} ساعة`);
    if (p.attendance) bits.push(p.attendance);
    items.push({
      kind: 'package',
      package_id: p.package_id,
      title: p.title,
      price_from_display: p.price_from_display || '',
      currency: p.currency || '',
      courses_count: p.courses_count || 0,
      training_hours: p.training_hours || 0,
      attendance: p.attendance || '',
      rating: p.rating || 0,
      badge: p.badge || '',
      levels: p.levels || [],
      starts_at: p.starts_at || '',
      options: (p.price_options || []).slice(0, 4).map((o) => ({
        label: o.label, price_display: o.price_display,
        was_display: o.was_display || '',
      })),
      url: p.url || '',
      // legacy fallback
      description: bits.join(' · '), media_url: '',
      actions: p.url ? [{ type: 'link', text: 'تفاصيل المسار', uri: p.url }] : [],
    });
  }
  for (const c of courseCards) {
    const nb = c.next_batch || null;
    const bits = [];
    if (c.price_display) bits.push(c.price_display);
    if (c.delivery) bits.push(c.delivery);
    if (c.duration_text) bits.push(c.duration_text);
    if (nb?.starts_at) bits.push(`الدفعة القادمة ${String(nb.starts_at).slice(0, 10)}`);
    const actions = [];
    if (c.checkout_url) actions.push({ type: 'link', text: 'اشترِ الآن', uri: c.checkout_url });
    if (c.url) actions.push({ type: 'link', text: 'تفاصيل الكورس', uri: c.url });
    items.push({
      kind: 'course',
      course_id: c.course_id,
      title: c.title,
      media_url: c.image_url || '',
      price_display: c.price_display || '',
      currency: c.currency || '',
      rating: c.rating || 0,
      instructor: (c.instructors || [])[0]?.name || '',
      instructors_count: (c.instructors || []).length,
      delivery: chip(c.delivery, 18),
      duration_text: chip(fmtDuration(c.duration_text), 20),
      starts_at: nb?.starts_at || '',
      seats_available: nb && nb.seats_available != null ? nb.seats_available : null,
      location: nb?.location || '',
      url: c.url || '',
      checkout_url: c.checkout_url || '',
      // legacy fallback
      description: bits.join(' · '), actions,
    });
  }
  return items;
}

/**
 * Try to answer with نبراس.
 * @returns {Promise<boolean>} true if it answered; false => caller must fall
 *   back to Botpress. Never throws.
 */
async function tryNabras(cwConvId, text, { name, userData, pageType, slug }, deps) {
  const c = cfg();
  if (!allowed(userData)) return false;

  let token;
  try {
    token = await guestToken(cwConvId);
  } catch (e) {
    console.warn(`NABRAS token failed (conv ${cwConvId}): ${e.message} — falling back`);
    return false;
  }

  let reply = '';
  let courseCards = [];
  let packageCards = [];
  let chips = [];
  let instructorCards = [];
  let handoff = null;
  let deferred = null;

  try {
    const res = await axios.post(
      `${c.base}/api/v1/ai-chat/chat/`,
      { message: text, fahem_session_id: `cw_${cwConvId}`, language: 'auto',
        currency: resolveCurrency(userData), lang: resolveLang(userData),
        page_type: pageType || undefined, slug: slug || undefined },
      { headers: { 'X-Guest-Token': token, 'Content-Type': 'application/json' },
        timeout: c.timeoutMs, responseType: 'text' });

    // The stream is buffered here on purpose: the live widget renders whole
    // messages, and shipping token streaming would require changing it. That
    // trade keeps this rollout reversible.
    for (const line of String(res.data || '').split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let ev;
      try { ev = JSON.parse(line.slice(6)); } catch (_) { continue; }
      if (ev.type === 'token') reply += ev.content || '';
      else if (ev.type === 'cards') courseCards = ev.course_cards || [];
      else if (ev.type === 'packages') packageCards = ev.package_cards || [];
      else if (ev.type === 'chips') chips = ev.chips || [];
      else if (ev.type === 'instructors') instructorCards = ev.instructor_cards || [];
      else if (ev.type === 'defer') deferred = ev;
      else if (ev.type === 'handoff') handoff = ev;
      else if (ev.type === 'error') {
        // the exception class travels in the log line, so "why did it fail?"
        // is answerable without opening the service's own logs
        throw new Error(`upstream_error${ev.detail ? ` (${ev.detail})` : ''}`);
      }
    }
  } catch (e) {
    console.warn(`NABRAS chat failed (conv ${cwConvId}): ${e.message} — falling back`);
    return false;
  }

  // "not mine" — the brain read the question and decided it cannot prove an
  // answer (payment terms, refunds, an existing order). Nothing is delivered,
  // so Botpress answers this same message from its knowledge base and the
  // customer sees one assistant that simply knew the answer.
  if (deferred) {
    console.log(`NABRAS deferred conv ${cwConvId} to Botpress: ${deferred.reason || '-'}`);
    return false;
  }

  if (!reply.trim() && !courseCards.length && !packageCards.length &&
      !chips.length && !instructorCards.length) {
    console.warn(`NABRAS returned nothing (conv ${cwConvId}) — falling back`);
    return false;
  }

  const stamp = Date.now();
  if (reply.trim()) {
    await deps.deliver(cwConvId, {
      id: `nb-${stamp}-t`, content: reply.trim(), content_type: 'text',
    });
  }
  const items = toWidgetCards(courseCards, packageCards, instructorCards);
  if (items.length) {
    await deps.deliver(cwConvId, {
      id: `nb-${stamp}-c`, content: '', content_type: 'cards',
      content_attributes: { items },
    });
  }
  if (chips.length) {
    // `input_select` is the type the widget already renders as tappable
    // choices — picking one sends its value as the next message.
    await deps.deliver(cwConvId, {
      id: `nb-${stamp}-s`, content: '', content_type: 'input_select',
      content_attributes: { items: chips.slice(0, 8) },
    });
  }
  if (handoff?.requested && deps.handoff) {
    // نبراس never touches Chatwoot itself — the bridge owns that state.
    try { await deps.handoff(cwConvId, handoff); }
    catch (e) { console.error('NABRAS handoff failed:', e.message); }
  }

  console.log(`NABRAS answered conv ${cwConvId} (${reply.length} chars, ` +
              `${items.length} cards)${handoff?.requested ? ' + handoff' : ''}`);
  return true;
}

module.exports = { tryNabras, allowed, toWidgetCards, resolveCurrency,
                   resolveLang, cfg };
