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
  res.end(mode === 'track' ? TRACK_SSE : mode === 'defer' ? DEFER_SSE : OK_SSE);
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
    // the instructor leads: it is the answer to "who teaches this?", and the
    // track and its courses are the context for it
    assert.deepStrictEqual(items.map((i) => i.kind),
                           ['instructor', 'package', 'course']);
    assert.strictEqual(items[0].media_url,
                       'https://engosoft.com/web/image/hr.employee/4129/image_512');
    assert.deepStrictEqual(items[0].teaches, ['PMP', 'Primavera']);
    assert.strictEqual(items[1].price_from_display, '12,001 EGP');
    assert.strictEqual(items[1].options.length, 2);
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

  server.close();
  console.log('✅ nabras router: streaming, one-message replies, and safe fallback passed');
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

  // 2. site silent -> use the visitor's region
  a.strictEqual(resolveCurrency({ timezone: 'Asia/Riyadh' }), 'SAR');
  a.strictEqual(resolveCurrency({ timezone: 'Asia/Dubai' }), 'AED');
  a.strictEqual(resolveCurrency({ timezone: 'Africa/Cairo' }), 'EGP');

  // 3. nothing known -> configured default, and junk never leaks through
  a.strictEqual(resolveCurrency({}), 'EGP');
  a.strictEqual(resolveCurrency({ shop: { currency: 'XYZ' } }), 'EGP');
  a.strictEqual(resolveCurrency(null), 'EGP');

  console.log('✅ currency: 9 cases — site first, then region, then default');
})();

// ---------------------------------------------------------------------------
// The resolver above is only as good as what the widget hands it. It used to
// build its payload without `shop` and without `timezone`, so every branch
// except the default was unreachable and a Saudi visitor was quoted in EGP
// beside a page showing riyals. Guard the passthrough at the source.
(() => {
  delete require.cache[require.resolve('../nabras')];
  process.env.NABRAS_CURRENCY = 'EGP';
  const { resolveCurrency } = require('../nabras');
  const a = require('assert');
  const fs = require('fs');
  const path = require('path');
  const widget = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'majed-widget.js'), 'utf8');

  // the two keys the resolver reads must be produced by fetchUserContext
  a.ok(/shop:\s*ctx\.shop\s*\|\|/.test(widget),
    'widget must forward Odoo shop context (currency/country/lang)');
  a.ok(/timezone:\s*browserTz\(\)/.test(widget),
    'widget must send the browser timezone as the regional fallback');
  // ...and the failure paths must not drop it back to a bare {}
  a.strictEqual((widget.match(/return regionOnly\(\);/g) || []).length, 2,
    'both the empty-context and fetch-failure paths must still send a region');

  // the shapes the widget actually emits resolve the way production needs
  const loggedInSaudi = { shop: { currency: 'SAR', country: 'SA' }, timezone: 'Asia/Riyadh' };
  const guestEgypt = { shop: { currency: 'EGP', country: 'EG' }, timezone: 'Africa/Cairo' };
  const oldOdooSaudi = { shop: {}, timezone: 'Asia/Riyadh' };   // module not upgraded
  const endpointDown = { timezone: 'Asia/Riyadh' };             // regionOnly()
  a.strictEqual(resolveCurrency(loggedInSaudi), 'SAR');
  a.strictEqual(resolveCurrency(guestEgypt), 'EGP');
  a.strictEqual(resolveCurrency(oldOdooSaudi), 'SAR');
  a.strictEqual(resolveCurrency(endpointDown), 'SAR');

  console.log('✅ widget passthrough: shop + timezone reach the currency resolver');
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
  console.log('✅ checkout copy: no broken GET link, direct card CTA appended');
})();
