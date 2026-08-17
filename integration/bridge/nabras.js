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
 *   4. **One progressive turn.** Token events update one transient widget
 *      response. The final Chatwoot-shaped message enriches that same surface
 *      with cards, live price, choices, and actions, then becomes the sole
 *      durable transcript record.
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
// Where is this visitor? Odoo resolved it per visitor (geoip / their partner
// record), and the prompt has rules that hinge on it: onsite classes run in
// Riyadh only, and the branch contact number differs. Currency is the fallback
// because the shop keys both off the same signal.
const CURRENCY_COUNTRY = { EGP: 'EG', SAR: 'SA', AED: 'AE' };
function resolveCountry(userData) {
  const direct = String(userData?.shop?.country || userData?.country || '')
    .trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(direct)) return direct;
  return CURRENCY_COUNTRY[resolveCurrency(userData)] || '';
}

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

function toWidgetCards(courseCards = [], packageCards = [], instructorCards = [],
                       lang = '') {
  const items = [];
  const arabicUi = /^ar(?:[_-]|$)/i.test(String(lang || ''));
  const hasArabic = (value) => /[\u0600-\u06ff]/u.test(String(value || ''));
  const courseCountLabel = (value) => {
    const count = Number(value) || 0;
    if (!count) return '';
    if (count === 1) return 'دورة واحدة';
    if (count === 2) return 'دورتان';
    if (count <= 10) return `${count} دورات`;
    return `${count} دورة`;
  };
  const arabicInstructorTitle = (value) => {
    const title = String(value || '');
    if (/mechanical/i.test(title)) return 'مدرب ميكانيكا';
    if (/electrical/i.test(title)) return 'مدرب كهرباء';
    if (/architect/i.test(title)) return 'مدرب معماري';
    if (/civil/i.test(title)) return 'مدرب مدني';
    if (/(project|pmp|primavera)/i.test(title)) return 'مدرب إدارة مشروعات';
    return 'مدرب';
  };
  const seenInstructors = new Set();
  for (const i of instructorCards) {
    const instructorKey = i.id != null
      ? `id:${i.id}`
      : `name:${String(i.name || '').trim().toLowerCase()}`;
    if (seenInstructors.has(instructorKey)) continue;
    seenInstructors.add(instructorKey);

    // The model still receives the complete Odoo profile and can summarise it
    // in Arabic.  The structured card, however, must not switch the Arabic UI
    // back to a long English biography when that Odoo field has no translation.
    const bio = arabicUi && i.bio && !hasArabic(i.bio) ? '' : (i.bio || '');
    const sections = (i.sections || []).slice(0, 3).map((section) => ({
      ...section,
      items: (section.items || []).filter(
        (value) => !arabicUi || hasArabic(value)).slice(0, 12),
    })).filter((section) => section.items.length);
    const jobTitle = arabicUi && i.title && !hasArabic(i.title)
      ? arabicInstructorTitle(i.title)
      : (i.title || '');
    items.push({
      kind: 'instructor',
      instructor_id: i.id,
      title: i.name,
      job_title: jobTitle,
      department: (
        arabicUi && i.department && !hasArabic(i.department)
          ? ''
          : (i.department || '')
      ),
      media_url: i.image_url || '',
      courses_count: i.courses_count || 0,
      teaches: (i.teaches || []).slice(0, 4),
      bio,
      sections,
      // legacy fallback
      description: [jobTitle, courseCountLabel(i.courses_count)]
        .filter(Boolean).join(' · '),
      actions: [],
    });
  }
  for (const p of packageCards) {
    const bits = [];
    if (p.price_from_display) bits.push(`يبدأ من ${p.price_from_display}`);
    if (p.courses_count) bits.push(`${p.courses_count} دورة`);
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
    // Chatwoot's generic action renderer can only open a GET link, while
    // Odoo's /shop/cart/update route is POST-only. The rich widget submits the
    // checkout form; older/cached widgets get the safe course page instead.
    const actions = [];
    if (c.url) actions.push({ type: 'link', text: 'عرض صفحة الدورة', uri: c.url });
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
      location: nb?.location || '',
      url: c.url || '',
      checkout_url: c.checkout_url || '',
      // legacy fallback
      description: bits.join(' · '), actions,
    });
  }
  return items;
}

function compactHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: String(m.content || '').trim().slice(0, 4000) }))
    .filter((m) => m.content)
    .slice(-24);
}

function finalizeSalesReply(value, courseCards = []) {
  let text = String(value || '').trim();
  const checkoutMarkdown =
    /\[[^\]]*\]\(https?:\/\/[^\s<>()]+\/shop\/cart\/update\?[^\s<>()]+\)/giu;
  const hadMarkdownCheckoutLink = checkoutMarkdown.test(text);
  checkoutMarkdown.lastIndex = 0;
  text = text.replace(checkoutMarkdown, '');
  const checkoutUrl = /https?:\/\/[^\s<>()]+\/shop\/cart\/update\?[^\s<>()]+/giu;
  const hadBrokenCheckoutLink = hadMarkdownCheckoutLink || checkoutUrl.test(text);
  checkoutUrl.lastIndex = 0;
  text = text.replace(checkoutUrl, '');

  if (hadBrokenCheckoutLink) {
    // Remove the orphaned introduction left behind after deleting the URL.
    text = text
      .replace(/(?:من خلال|عبر)\s+(?:هذا\s+)?الرابط\s*[:：]?\s*/giu, '')
      .replace(/(?:هذا\s+)?الرابط\s*[:：]\s*(?=\n|$)/giu, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const hasDirectPurchase = courseCards.some((card) => card?.checkout_url);
  const alreadyHasCardCta =
    /زر[^.\n؟]{0,45}(?:اشتر|الشراء)[^.\n؟]{0,80}البطاقة/u.test(text);
  if (hasDirectPurchase && !alreadyHasCardCta) {
    const cta =
      'استخدم زر «اشترِ الدورة الآن» في البطاقة لإضافتها مباشرةً إلى سلة الشراء.';
    text = text ? `${text}\n\n${cta}` : cta;
  }
  return text;
}

const isTrackIntent = (text) =>
  /(?:مسار|المسار|باقة|الباقة|شامل|شاملة|track|package)/i.test(String(text || ''));

async function deliverTrackFailure(cwConvId, streamId, deps) {
  try {
    await deps.deliver(cwConvId, {
      id: `${streamId}-unavailable`,
      content: 'تعذّر تحميل بيانات هذا المسار الآن. يُرجى المحاولة بعد لحظات، وسأتابع معك في التخصص نفسه.',
      content_type: 'text',
      content_attributes: { stream_id: streamId, retryable: true },
    });
    return true;
  } catch (e) {
    console.error(`NABRAS could not deliver track retry (conv ${cwConvId}): ${e.message}`);
    return false;
  }
}

/** Consume a Node response stream without assuming that SSE records, JSON, or
 * UTF-8 characters line up with transport chunks. */
async function consumeSseStream(stream, onEvent) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new Error('upstream response is not a stream');
  }
  if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
  let buffer = '';

  const consumeRecord = async (record) => {
    const payload = String(record || '')
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!payload || payload === '[DONE]') return;
    let event;
    try { event = JSON.parse(payload); } catch (_) { return; }
    await onEvent(event);
  };

  for await (const chunk of stream) {
    buffer += String(chunk).replace(/\r/g, '');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const record = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      await consumeRecord(record);
    }
  }
  if (buffer.trim()) await consumeRecord(buffer);
}

/**
 * Try to answer with نبراس.
 * @returns {Promise<boolean>} true if it answered; false => caller must fall
 *   back to Botpress. Never throws.
 */
async function tryNabras(cwConvId, text, { name, userData, pageType, slug, history }, deps) {
  const c = cfg();
  if (!allowed(userData)) return false;
  const streamId = `nb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const trackIntent = isTrackIntent(text);

  let token;
  try {
    token = await guestToken(cwConvId);
  } catch (e) {
    console.warn(`NABRAS token failed (conv ${cwConvId}): ${e.message} — falling back`);
    if (trackIntent) return deliverTrackFailure(cwConvId, streamId, deps);
    return false;
  }

  let reply = '';
  let courseCards = [];
  let packageCards = [];
  let chips = [];
  let instructorCards = [];
  let handoff = null;
  let deferred = null;
  let sequence = 0;
  let liveStarted = false;
  let tokenBuffer = '';
  let tokenTimer = null;

  const emitLive = (state, content = '') => {
    if (typeof deps.stream !== 'function') return;
    deps.stream(cwConvId, {
      id: `${streamId}-${state}-${sequence}`,
      content,
      content_type: 'assistant_stream',
      content_attributes: {
        stream_id: streamId,
        stream_state: state,
        sequence: sequence++,
      },
    });
  };
  const flushTokens = () => {
    if (tokenTimer) {
      clearTimeout(tokenTimer);
      tokenTimer = null;
    }
    if (!tokenBuffer) return;
    if (!liveStarted && typeof deps.stream === 'function') {
      liveStarted = true;
      emitLive('start');
    }
    const delta = tokenBuffer;
    tokenBuffer = '';
    emitLive('delta', delta);
  };
  const queueToken = (content) => {
    const value = String(content || '');
    if (!value) return;
    reply += value;
    tokenBuffer += value;
    if (!tokenTimer) {
      tokenTimer = setTimeout(flushTokens, 35);
      tokenTimer.unref?.();
    }
  };

  try {
    const res = await axios.post(
      `${c.base}/api/v1/ai-chat/chat/`,
      { message: text, fahem_session_id: `cw_${cwConvId}`, language: 'auto',
        currency: resolveCurrency(userData), lang: resolveLang(userData),
        country: resolveCountry(userData) || undefined,
        page_type: pageType || undefined, slug: slug || undefined,
        history: compactHistory(history) },
      { headers: { 'X-Guest-Token': token, 'Content-Type': 'application/json' },
        timeout: c.timeoutMs, responseType: 'stream' });

    // Consume the upstream response as real SSE. Tokens are forwarded to the
    // widget progressively; rich events are held only until the final durable
    // message can combine copy, cards, price, and actions into one turn.
    await consumeSseStream(res.data, async (ev) => {
      if (ev.type === 'token') queueToken(ev.content);
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
    });
    flushTokens();
  } catch (e) {
    flushTokens();
    console.warn(`NABRAS chat failed (conv ${cwConvId}): ${e.message} — falling back`);
    if (liveStarted && reply.trim()) {
      const safeReply = finalizeSalesReply(reply);
      await deps.deliver(cwConvId, {
        id: `${streamId}-final`,
        content: `${safeReply}\n\nتعذّر إكمال الرد. يُرجى إعادة إرسال سؤالك.`,
        content_type: 'text',
        content_attributes: { stream_id: streamId, incomplete: true },
      });
      return true;
    }
    // Botpress did not receive the preceding Nabras turns, so handing it an
    // elliptical «المسار الشامل» makes it guess a new subject. Preserve the
    // customer's context with an explicit retry instead of a wrong answer.
    if (trackIntent) return deliverTrackFailure(cwConvId, streamId, deps);
    return false;
  }

  // "not mine" — the brain read the question and decided it cannot prove an
  // answer (payment terms, refunds, an existing order). Nothing is delivered,
  // so Botpress answers this same message from its knowledge base and the
  // customer sees one assistant that simply knew the answer.
  if (deferred) {
    if (liveStarted) emitLive('abort');
    console.log(`NABRAS deferred conv ${cwConvId} to Botpress: ${deferred.reason || '-'}`);
    return false;
  }

  if (!reply.trim() && !courseCards.length && !packageCards.length &&
      !chips.length && !instructorCards.length) {
    console.warn(`NABRAS returned nothing (conv ${cwConvId}) — falling back`);
    if (trackIntent) return deliverTrackFailure(cwConvId, streamId, deps);
    return false;
  }

  reply = finalizeSalesReply(reply, courseCards);
  const items = toWidgetCards(
    courseCards, packageCards, instructorCards, resolveLang(userData));
  const contentType = items.length ? 'cards' : chips.length ? 'input_select' : 'text';
  const contentAttributes = {
    stream_id: streamId,
    ...(items.length ? { items } : {}),
    ...(chips.length
      ? (items.length ? { quick_replies: chips.slice(0, 8) } : { items: chips.slice(0, 8) })
      : {}),
  };
  await deps.deliver(cwConvId, {
    id: `${streamId}-final`,
    content: reply.trim(),
    content_type: contentType,
    content_attributes: contentAttributes,
  });
  if (handoff?.requested && deps.handoff) {
    // نبراس never touches Chatwoot itself — the bridge owns that state.
    try { await deps.handoff(cwConvId, handoff); }
    catch (e) { console.error('NABRAS handoff failed:', e.message); }
  }

  console.log(`NABRAS answered conv ${cwConvId} (${reply.length} chars, ` +
              `${items.length} cards)${handoff?.requested ? ' + handoff' : ''}`);
  return true;
}

module.exports = { tryNabras, allowed, toWidgetCards, resolveCurrency, resolveCountry,
                   resolveLang, compactHistory, consumeSseStream, isTrackIntent,
                   finalizeSalesReply, cfg };
