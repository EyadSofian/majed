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
  currency: process.env.NABRAS_CURRENCY || 'EGP',
});

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

/** Course cards -> the shape majed-widget.js `addCard()` already renders. */
function toWidgetCards(courseCards = [], packageCards = []) {
  const items = [];
  for (const c of courseCards) {
    const bits = [];
    if (c.price_display) bits.push(c.price_display);
    if (c.delivery) bits.push(c.delivery);
    if (c.duration_text) bits.push(c.duration_text);
    const nb = c.next_batch;
    if (nb?.starts_at) {
      const seats = nb.seats_available != null ? ` — متبقٍ ${nb.seats_available} مقعد` : '';
      bits.push(`الدفعة القادمة ${String(nb.starts_at).slice(0, 10)}${seats}`);
    }
    const actions = [];
    if (c.checkout_url) actions.push({ type: 'link', text: 'اشترِ الآن', uri: c.checkout_url });
    if (c.url) actions.push({ type: 'link', text: 'تفاصيل الكورس', uri: c.url });
    items.push({ title: c.title, description: bits.join(' · '),
                 media_url: c.image_url || '', actions });
  }
  for (const p of packageCards) {
    const bits = [];
    if (p.price_from_display) bits.push(`يبدأ من ${p.price_from_display}`);
    if (p.courses_count) bits.push(`${p.courses_count} كورس`);
    if (p.training_hours) bits.push(`${p.training_hours} ساعة`);
    if (p.attendance) bits.push(p.attendance);
    items.push({ title: `مسار: ${p.title}`, description: bits.join(' · '),
                 media_url: '',
                 actions: p.url ? [{ type: 'link', text: 'تفاصيل المسار', uri: p.url }] : [] });
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
  let handoff = null;

  try {
    const res = await axios.post(
      `${c.base}/api/v1/ai-chat/chat/`,
      { message: text, fahem_session_id: `cw_${cwConvId}`, language: 'auto',
        currency: c.currency, page_type: pageType || undefined, slug: slug || undefined },
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
      else if (ev.type === 'handoff') handoff = ev;
      else if (ev.type === 'error') throw new Error('upstream_error');
    }
  } catch (e) {
    console.warn(`NABRAS chat failed (conv ${cwConvId}): ${e.message} — falling back`);
    return false;
  }

  if (!reply.trim() && !courseCards.length && !packageCards.length) {
    console.warn(`NABRAS returned nothing (conv ${cwConvId}) — falling back`);
    return false;
  }

  const stamp = Date.now();
  if (reply.trim()) {
    await deps.deliver(cwConvId, {
      id: `nb-${stamp}-t`, content: reply.trim(), content_type: 'text',
    });
  }
  const items = toWidgetCards(courseCards, packageCards);
  if (items.length) {
    await deps.deliver(cwConvId, {
      id: `nb-${stamp}-c`, content: '', content_type: 'cards',
      content_attributes: { items },
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

module.exports = { tryNabras, allowed, toWidgetCards, cfg };
