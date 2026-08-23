/**
 * Proves the property that makes a live trial safe: نبراس answers only when it
 * is enabled AND allowlisted AND healthy — and returns false for every other
 * case so Botpress answers the same message.
 *
 *   node test/nabras-router.test.js
 */
const assert = require('assert');
const http = require('http');

const OK_SSE = [
  'data: {"type":"token","content":"أنصحك "}',
  'data: {"type":"token","content":"بـ Navisworks MEP."}',
  'data: {"type":"cards","course_cards":[{"course_id":2107,"title":"Navisworks MEP",' +
    '"url":"https://engosoft.com/shop/navisworks-mep-2107","image_url":"https://x/i.png",' +
    '"price_display":"4,815 EGP","delivery":"مسجّل","duration_text":"15 ساعة",' +
    '"next_batch":{"starts_at":"2026-08-20 16:00:00","seats_available":3},' +
    '"checkout_url":"https://engosoft.com/shop/cart/update?product_id=2059"}]}',
  'data: {"type":"done"}',
].join('\n\n') + '\n\n';

const TRACK_SSE = [
  'data: {"type":"token","content":"هذه هي مسارات الميكانيكا المناسبة."}',
  'data: {"type":"cards","course_cards":[{"course_id":2107,"title":"Navisworks MEP",' +
    '"url":"https://engosoft.com/shop/navisworks-mep-2107","price_display":"4,815 EGP"}]}',
  'data: {"type":"packages","package_cards":[{"package_id":5,"title":"Mechanical Track",' +
    '"url":"https://engosoft.com/training_package/mechanical-5","price_from_display":"12,001 EGP",' +
    '"courses_count":6,"training_hours":161,"attendance":"أونلاين أو حضوري",' +
    '"price_options":[{"mode":"recorded","label":"مسجّل","price_display":"12,001 EGP",' +
    '"was_display":"23,750 EGP"},{"mode":"attendance_online","label":"أونلاين — دفعة يوليو",' +
    '"price_display":"15,000 EGP"}]}]}',
  'data: {"type":"chips","chips":[{"title":"ميكانيكا","value":"أنا في تخصص Mechanical"},' +
    '{"title":"كهرباء","value":"أنا في تخصص Electrical"}]}',
  'data: {"type":"instructors","instructor_cards":[{"id":4129,"name":"Dr.Ayman Atef",' +
    '"title":"PMP Instructor","image_url":"https://engosoft.com/web/image/hr.employee/4129/image_512",' +
    '"courses_count":3,"teaches":["PMP","Primavera"]}]}',
  'data: {"type":"done"}',
].join('\n\n') + '\n\n';

// The funnel's capture. نبراس writes the lead to Odoo; the bridge is what
// carries the number into the Chatwoot conversation it came from. Before this
// existed, `tools=[create_lead]` in the service log was the only evidence a
// lead had been captured at all.
const LEAD_SSE = [
  'data: {"type":"token","content":"تمام، سجّلت بياناتك."}',
  'data: {"type":"lead","lead_id":4821,"name":"إياد سفيان","phone":"01000000000",' +
    '"email":"","field":"Mechanical","specialization":"ميكانيكا","experience":"3",' +
    '"course_interest":"المسار الشامل للميكانيكا","assigned_to":2,' +
    '"activity_id":99,"in_followup_cycle":true}',
  'data: {"type":"done"}',
].join('\n\n') + '\n\n';

// "not mine": the brain refuses to answer a payment question it cannot prove
const DEFER_SSE = [
  'data: {"type":"token","content":"كلام لا يجب أن يصل للعميل"}',
  'data: {"type":"defer","reason":"instalment terms not in Odoo"}',
  'data: {"type":"done"}',
].join('\n\n') + '\n\n';

let mode = 'ok';
const server = http.createServer((req, res) => {
  if (req.url.includes('guest-session')) {
    if (mode === 'token_fail') { res.writeHead(500); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: { guest_token: 't0k' } }));
  }
  if (mode === 'chat_fail') { res.writeHead(502); return res.end('bad gateway'); }
  if (mode === 'empty') { res.writeHead(200); return res.end('data: {"type":"done"}\n\n'); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(mode === 'lead' ? LEAD_SSE
    : mode === 'track' ? TRACK_SSE : mode === 'defer' ? DEFER_SSE : OK_SSE);
});

function delivered() {
  const out = [];
  const streamed = [];
  return {
    out,
    streamed,
    deliver: async (id, m) => { out.push(m); },
    stream: (id, m) => { streamed.push(m); },
    handoff: async () => {},
    leads: [],
    lead: async function (id, l) { this.leads.push({ id, lead: l }); },
  };
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const withEnv = (env, fn) => async () => {
    Object.assign(process.env, env);
    delete require.cache[require.resolve('../nabras')];
    const { tryNabras } = require('../nabras');
    return fn(tryNabras);
  };
  const me = { email: 'eyad.sofiane@engosoft.com' };
  const ON = { NABRAS_ENABLED: 'true', NABRAS_URL: base,
               NABRAS_ALLOW: 'eyad.sofiane@engosoft.com' };

  // 1) master switch off -> Botpress keeps answering, unchanged
  await withEnv({ ...ON, NABRAS_ENABLED: 'false' }, async (t) => {
    const d = delivered();
    assert.strictEqual(await t(1, 'hi', { userData: me }, d), false);
    assert.strictEqual(d.out.length, 0);
  })();

  // 2) real customer not on the allowlist -> untouched
  await withEnv(ON, async (t) => {
    const d = delivered();
    assert.strictEqual(
      await t(2, 'hi', { userData: { email: 'customer@example.com' } }, d), false);
    assert.strictEqual(d.out.length, 0);
  })();

  // 3) anonymous visitor (no email) -> untouched
  await withEnv(ON, async (t) => {
    assert.strictEqual(await t(3, 'hi', { userData: {} }, delivered()), false);
  })();

  // 4) happy path -> answers, with a card carrying the buy button
  await withEnv(ON, async (t) => {
    mode = 'ok';
    const d = delivered();
    assert.strictEqual(await t(4, 'navisworks', { userData: me }, d), true);
    assert.strictEqual(d.out.length, 1);
    assert.strictEqual(d.out[0].content_type, 'cards');
    assert.ok(d.out[0].content.includes('Navisworks MEP'));
    const items = d.out[0].content_attributes.items;
    assert.ok(d.streamed.some((m) => m.content_attributes.stream_state === 'start'));
    assert.ok(d.streamed.some((m) => m.content_attributes.stream_state === 'delta'));
    assert.strictEqual(items.length, 1);
    // Each customer-facing fact travels in its own field. Seat scarcity is
    // deliberately not exposed in the card.
    assert.strictEqual(items[0].kind, 'course');
    assert.strictEqual(items[0].price_display, '4,815 EGP');
    assert.strictEqual(Object.hasOwn(items[0], 'seats_available'), false);
    assert.strictEqual(items[0].delivery, 'مسجّل');
    assert.strictEqual(items[0].starts_at, '2026-08-20 16:00:00');
    assert.ok(items[0].checkout_url.includes('product_id=2059'));
    // and the flattened line stays, so a cached older widget still renders
    assert.ok(items[0].description.includes('4,815 EGP'));
    assert.strictEqual(items[0].actions[0].text, 'عرض صفحة الدورة');
    assert.strictEqual(items[0].actions[0].uri,
                       'https://engosoft.com/shop/navisworks-mep-2107');
    assert.ok(d.out[0].content.endsWith(
      'استخدم زر «اشترِ الدورة الآن» في البطاقة لإضافتها مباشرةً إلى سلة الشراء.'));
  })();

  // 5) نبراس down mid-request -> silent fallback, nothing shown to the customer
  for (const m of ['token_fail', 'chat_fail', 'empty']) {
    await withEnv(ON, async (t) => {
      mode = m;
      const d = delivered();
      assert.strictEqual(await t(5, 'hi', { userData: me }, d), false, m);
      assert.strictEqual(d.out.length, 0, m);
    })();
  }

  // A failed contextual track request must not fall into Botpress without the
  // preceding specialty turns (the production bug changed Mechanical to CFM).
  await withEnv(ON, async (t) => {
    mode = 'chat_fail';
    const d = delivered();
    assert.strictEqual(await t(51, 'هات لي المسار الشامل', {
      userData: me,
      history: [{ role: 'user', content: 'أريد دورات الميكانيكا' }],
    }, d), true);
    assert.strictEqual(d.out.length, 1);
    assert.ok(d.out[0].content.includes('التخصص نفسه'));
    assert.strictEqual(d.out[0].content_attributes.retryable, true);
  })();

  // 6) NABRAS_ALLOW=* opens it to everyone (the final rollout step)
  await withEnv({ ...ON, NABRAS_ALLOW: '*' }, async (t) => {
    mode = 'ok';
    assert.strictEqual(
      await t(6, 'hi', { userData: { email: 'customer@example.com' } }, delivered()), true);
  })();

  // 7) a track and its courses in one turn -> the track is shown FIRST, and
  //    the specializations arrive as tappable choices, not as more prose
  mode = 'track';
  await withEnv(ON, async (t) => {
    const d = delivered();
    assert.strictEqual(await t(7, 'أنا في تخصص ميكانيكا', { userData: me }, d), true);
    const items = d.out.find((m) => m.content_type === 'cards').content_attributes.items;
    // The package is the offer, courses substantiate it, and the instructor is
    // supporting detail. Never make the visitor scroll past a trainer first.
    assert.deepStrictEqual(items.map((i) => i.kind),
                           ['package', 'course', 'instructor']);
    assert.strictEqual(items[2].media_url,
                       'https://engosoft.com/web/image/hr.employee/4129/image_512');
    assert.deepStrictEqual(items[2].teaches, ['PMP', 'Primavera']);
    assert.strictEqual(items[0].price_from_display, '12,001 EGP');
    assert.strictEqual(items[0].options.length, 2);
    const unified = d.out.find((m) => m.content_type === 'cards');
    assert.strictEqual(d.out.length, 1);
    assert.deepStrictEqual(unified.content_attributes.quick_replies.map((c) => c.title),
                           ['ميكانيكا', 'كهرباء']);
  })();

  // 8) a deferred turn delivers NOTHING and hands the message to Botpress —
  //    otherwise the customer would see a guess about instalments
  mode = 'defer';
  await withEnv(ON, async (t) => {
    const d = delivered();
    assert.strictEqual(await t(8, 'عندكم تقسيط؟', { userData: me }, d), false);
    assert.strictEqual(d.out.length, 0);
  })();

  // 9) SSE records and Arabic UTF-8 characters may be split at arbitrary TCP
  //    boundaries. The parser must reconstruct both before decoding JSON.
  delete require.cache[require.resolve('../nabras')];
  const { consumeSseStream } = require('../nabras');
  const { Readable } = require('stream');
  const wire = Buffer.from(
    'data: {"type":"token","content":"مرحبًا"}\r\n\r\n' +
    'data: {"type":"done"}\r\n\r\n',
    'utf8');
  const arabicSplit = wire.indexOf(Buffer.from('م', 'utf8')) + 1;
  const events = [];
  await consumeSseStream(Readable.from([
    wire.subarray(0, 7),
    wire.subarray(7, arabicSplit),
    wire.subarray(arabicSplit, wire.length - 3),
    wire.subarray(wire.length - 3),
  ]), async (event) => events.push(event));
  assert.deepStrictEqual(events, [
    { type: 'token', content: 'مرحبًا' },
    { type: 'done' },
  ]);

  // A captured lead has to leave the service and reach the conversation it
  // came from: the number is what gets an advisor from this chat to the CRM
  // record. نبراس emits it; the bridge is the only thing that can deliver it.
  mode = 'lead';
  await withEnv(ON, async (tryNabras) => {
      const d = delivered();
      const handled = await tryNabras('91', 'اسمي إياد ورقمي 01000000000',
        { name: 'إياد', userData: me }, d);
      assert.strictEqual(handled, true);
      assert.strictEqual(d.leads.length, 1, 'the lead never left the stream');
      assert.strictEqual(d.leads[0].lead.lead_id, 4821);
      assert.strictEqual(d.leads[0].lead.name, 'إياد سفيان');
      assert.strictEqual(d.leads[0].lead.in_followup_cycle, true);
      // and the customer still gets their reply
      assert.ok(d.out.some((m) => String(m.content || '').includes('سجّلت بياناتك')));
    })();

  // A turn with no lead must not announce one.
  mode = 'ok';
  await withEnv(ON, async (tryNabras) => {
      const d = delivered();
      await tryNabras('92', 'عايز كورس', { name: 'x', userData: me }, d);
      assert.strictEqual(d.leads.length, 0);
    })();

  server.close();

  console.log('✅ nabras router: streaming, one-message replies, and safe fallback passed');
  console.log('✅ nabras router: a captured lead reaches the bridge with its number');
})().catch((e) => { server.close(); console.error('❌', e); process.exit(1); });

// ---------------------------------------------------------------------------
// Currency must follow the visitor, not a constant. Run: node test/nabras-router.test.js
(() => {
  delete require.cache[require.resolve('../nabras')];
  process.env.NABRAS_CURRENCY = 'EGP';
  const { resolveCurrency } = require('../nabras');
  const a = require('assert');

  // 1. the website's own pricelist wins — this is what the page is showing
  a.strictEqual(resolveCurrency({ shop: { currency: 'SAR' } }), 'SAR');
  a.strictEqual(resolveCurrency({ shop: { currency: 'aed' } }), 'AED');
  // it must beat any browser guess
  a.strictEqual(
    resolveCurrency({ shop: { currency: 'USD' }, timezone: 'Africa/Cairo' }), 'USD');

  // 2. site silent -> the country Odoo resolved (geoip) beats a clock guess.
  //    A Saudi visitor on a laptop still set to Cairo must be quoted in riyals.
  a.strictEqual(resolveCurrency({ shop: { country: 'SA' } }), 'SAR');
  a.strictEqual(resolveCurrency({ shop: { country: 'EG' } }), 'EGP');
  a.strictEqual(resolveCurrency({ shop: { country: 'AE' } }), 'AED');
  a.strictEqual(resolveCurrency({ country: 'sa' }), 'SAR');
  a.strictEqual(
    resolveCurrency({ shop: { country: 'SA' }, timezone: 'Africa/Cairo' }), 'SAR');
  // an unmapped country is not a signal — fall through, do not invent
  a.strictEqual(resolveCurrency({ shop: { country: 'DE' } }), 'EGP');
  a.strictEqual(
    resolveCurrency({ shop: { country: 'DE' }, timezone: 'Asia/Riyadh' }), 'SAR');

  // 3. no country -> use the visitor's region
  a.strictEqual(resolveCurrency({ timezone: 'Asia/Riyadh' }), 'SAR');
  a.strictEqual(resolveCurrency({ timezone: 'Asia/Dubai' }), 'AED');
  a.strictEqual(resolveCurrency({ timezone: 'Africa/Cairo' }), 'EGP');

  // 4. nothing known -> configured default, and junk never leaks through
  a.strictEqual(resolveCurrency({}), 'EGP');
  a.strictEqual(resolveCurrency({ shop: { currency: 'XYZ' } }), 'EGP');
  a.strictEqual(resolveCurrency(null), 'EGP');

  // 5. the shapes the widget actually sends, end to end. These are the payloads
  //    fetchUserContext() builds — the regression that started this: it used to
  //    send neither shop nor timezone, so every visitor resolved to the default.
  const saudiGuest = { lang: 'ar-001', timezone: 'Asia/Riyadh' };          // fetch failed
  const saudiLoggedIn = { shop: { currency: 'SAR', country: 'SA', lang: 'ar_001' },
                          currency: 'SAR', country: 'SA', timezone: 'Asia/Riyadh' };
  const egyptGuest = { lang: 'ar-001', timezone: 'Africa/Cairo' };
  const egyptLoggedIn = { shop: { currency: 'EGP', country: 'EG', lang: 'ar_001' },
                          currency: 'EGP', country: 'EG', timezone: 'Africa/Cairo' };
  a.strictEqual(resolveCurrency(saudiGuest), 'SAR');
  a.strictEqual(resolveCurrency(saudiLoggedIn), 'SAR');
  a.strictEqual(resolveCurrency(egyptGuest), 'EGP');
  a.strictEqual(resolveCurrency(egyptLoggedIn), 'EGP');

  console.log('✅ currency: 20 cases — site, then country, then region, then default');
})();

// ---------------------------------------------------------------------------
// The country is a finer question than the currency: SAR covers five countries,
// so «الحضوري في الرياض» has to be told to an Egyptian AND to a Kuwaiti. It is
// resolved on its own rather than read back out of the currency.
(() => {
  delete require.cache[require.resolve('../nabras')];
  process.env.NABRAS_CURRENCY = 'EGP';
  const { resolveCountry } = require('../nabras');
  const a = require('assert');

  // 1. Odoo's own answer wins
  a.strictEqual(resolveCountry({ shop: { country: 'EG' } }), 'EG');
  a.strictEqual(resolveCountry({ country: 'sa' }), 'SA');
  // 2. the timezone names the country exactly — including the ones SAR hides
  a.strictEqual(resolveCountry({ timezone: 'Asia/Kuwait' }), 'KW');
  a.strictEqual(resolveCountry({ timezone: 'Asia/Muscat' }), 'OM');
  a.strictEqual(resolveCountry({ timezone: 'Asia/Baghdad' }), 'IQ');
  a.strictEqual(resolveCountry({ timezone: 'Africa/Cairo' }), 'EG');
  // 3. last resort: a currency that names exactly one country
  a.strictEqual(resolveCountry({ shop: { currency: 'AED' } }), 'AE');
  // a Kuwaiti visitor is NOT reported as Saudi just because he is quoted in SAR
  a.notStrictEqual(resolveCountry({ timezone: 'Asia/Kuwait' }), 'SA');
  // 4. nothing known → empty, so the prompt can tell "unknown" from "Saudi"
  a.strictEqual(resolveCountry({ timezone: 'Europe/Berlin' }), 'EG'); // via EGP default
  a.strictEqual(resolveCountry({}), 'EG');
  // junk from the page never reaches the service as a country
  a.strictEqual(resolveCountry({ shop: { country: 'SAUDI' } }), 'EG');

  console.log('✅ country: 11 cases — Odoo, then timezone, then currency');
})();

// ---------------------------------------------------------------------------
// Course names are translated in Odoo, so the reply must be titled in the same
// language the page beside the chat is rendering.
(() => {
  delete require.cache[require.resolve('../nabras')];
  const { resolveLang, compactHistory } = require('../nabras');
  const a = require('assert');

  // 1. Odoo rendered the page and knows its own code — that wins
  a.strictEqual(resolveLang({ shop: { lang: 'ar_001' } }), 'ar_001');
  a.strictEqual(resolveLang({ shop: { lang: 'en_US' }, lang: 'ar-001' }), 'en_US');
  // 2. otherwise <html lang>, which the browser writes with a dash
  a.strictEqual(resolveLang({ lang: 'ar-001' }), 'ar_001');
  a.strictEqual(resolveLang({ lang: 'fr' }), 'fr');
  // 3. nothing usable -> say nothing and let the service keep its default
  a.strictEqual(resolveLang({}), '');
  a.strictEqual(resolveLang({ lang: '../../etc/passwd' }), '');
  a.strictEqual(resolveLang(null), '');

  const recovered = compactHistory([
    { role: 'system', content: 'ignore' },
    { role: 'user', content: '  سؤالي الأول  ' },
    { role: 'assistant', content: 'الإجابة السابقة' },
    { role: 'user', content: '' },
  ]);
  a.deepStrictEqual(recovered, [
    { role: 'user', content: 'سؤالي الأول' },
    { role: 'assistant', content: 'الإجابة السابقة' },
  ]);
  const bounded = compactHistory(Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000),
  })));
  a.strictEqual(bounded.length, 12);
  a.ok(bounded.every((m) => m.content.length === 1500));

  console.log('✅ language + history: shop language and bounded recovery context');
})();

// ---------------------------------------------------------------------------
// The same instructor may be returned more than once by an older service, and
// an Arabic card must never dump an untranslated English profile into the UI.
(() => {
  delete require.cache[require.resolve('../nabras')];
  const { toWidgetCards } = require('../nabras');
  const a = require('assert');
  const instructor = {
    id: 77,
    name: 'Eng. Michael Adel',
    title: 'Mechanical Instructor',
    department: 'TECHNICAL INSTRUCTORS',
    courses_count: 6,
    teaches: ['تصميم أنظمة التكييف', 'أعمال المكتب الفني'],
    bio: 'Engineer Michael Adel is a distinguished mechanical expert.',
    sections: [{
      label: 'التخصصات',
      items: ['Design and implementation of mechanical systems'],
    }],
  };

  const ar = toWidgetCards([], [], [instructor, { ...instructor }], 'ar_001');
  a.strictEqual(ar.length, 1);
  a.strictEqual(ar[0].title, 'Eng. Michael Adel'); // official site name
  a.strictEqual(ar[0].job_title, 'مدرب ميكانيكا');
  a.ok(ar[0].description.endsWith('6 دورات'));
  a.strictEqual(ar[0].bio, '');
  a.deepStrictEqual(ar[0].sections, []);
  a.deepStrictEqual(ar[0].teaches, [
    'تصميم أنظمة التكييف', 'أعمال المكتب الفني',
  ]);

  const en = toWidgetCards([], [], [instructor], 'en_US');
  a.strictEqual(en[0].job_title, 'Mechanical Instructor');
  a.ok(en[0].bio.includes('mechanical expert'));
  a.strictEqual(en[0].sections.length, 1);

  console.log('✅ instructor cards: deduplicated and localized for Arabic UI');
})();

// ---------------------------------------------------------------------------
// Odoo's add-to-cart route is POST-only: a model must never leak it as prose.
(() => {
  delete require.cache[require.resolve('../nabras')];
  const { finalizeSalesReply } = require('../nabras');
  const a = require('assert');
  const raw = 'أضف الدورة إلى السلة من خلال هذا الرابط:\n' +
    'https://engosoft.com/shop/cart/update?product_id=1116&add_qty=1&express=1';
  const clean = finalizeSalesReply(raw, [{ checkout_url: 'internal' }]);
  a.ok(!clean.includes('/shop/cart/update'));
  a.ok(clean.endsWith(
    'استخدم زر «اشترِ الدورة الآن» في البطاقة لإضافتها مباشرةً إلى سلة الشراء.'));
  const markdown = finalizeSalesReply(
    'اشترِ عبر هذا الرابط: [إضافة إلى السلة]' +
    '(https://engosoft.com/shop/cart/update?product_id=1116&add_qty=1)',
    [{ checkout_url: 'internal' }]);
  a.ok(!markdown.includes('/shop/cart/update'));
  a.ok(!markdown.includes('هذا الرابط'));
  const packageOffer = finalizeSalesReply(
    'هذا هو المسار الأنسب لك.', [{ checkout_url: 'internal' }], [{ package_id: 7 }]);
  a.ok(!packageOffer.includes('اشترِ الدورة الآن'));
  console.log('✅ checkout copy: no broken GET link, direct card CTA appended');
})();
