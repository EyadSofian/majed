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
  'data: {"type":"done"}', '',
].join('\n');

const TRACK_SSE = [
  'data: {"type":"token","content":"دي مسارات الميكانيكا."}',
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
  'data: {"type":"done"}', '',
].join('\n');

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
  res.end(mode === 'track' ? TRACK_SSE : OK_SSE);
});

function delivered() {
  const out = [];
  return { out, deliver: async (id, m) => { out.push(m); }, handoff: async () => {} };
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
    assert.strictEqual(d.out.length, 2);
    assert.ok(d.out[0].content.includes('Navisworks MEP'));
    const items = d.out[1].content_attributes.items;
    assert.strictEqual(items.length, 1);
    // Each fact travels in its own field — the widget cannot lay out a price,
    // a seat count and a date that were already glued into one string.
    assert.strictEqual(items[0].kind, 'course');
    assert.strictEqual(items[0].price_display, '4,815 EGP');
    assert.strictEqual(items[0].seats_available, 3);
    assert.strictEqual(items[0].delivery, 'مسجّل');
    assert.strictEqual(items[0].starts_at, '2026-08-20 16:00:00');
    assert.ok(items[0].checkout_url.includes('product_id=2059'));
    // and the flattened line stays, so a cached older widget still renders
    assert.ok(items[0].description.includes('4,815 EGP'));
    assert.strictEqual(items[0].actions[0].text, 'اشترِ الآن');
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
    assert.deepStrictEqual(items.map((i) => i.kind), ['package', 'course']);
    assert.strictEqual(items[0].price_from_display, '12,001 EGP');
    assert.strictEqual(items[0].options.length, 2);
    const chips = d.out.find((m) => m.content_type === 'input_select');
    assert.deepStrictEqual(chips.content_attributes.items.map((c) => c.title),
                           ['ميكانيكا', 'كهرباء']);
  })();

  server.close();
  console.log('✅ nabras router: 9 cases passed — every failure path falls back to Botpress');
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
// Course names are translated in Odoo, so the reply must be titled in the same
// language the page beside the chat is rendering.
(() => {
  delete require.cache[require.resolve('../nabras')];
  const { resolveLang } = require('../nabras');
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

  console.log('✅ language: 7 cases — the shop decides, never the server');
})();
