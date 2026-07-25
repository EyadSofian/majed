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
  res.end(OK_SSE);
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
    assert.ok(items[0].description.includes('4,815 EGP'));
    assert.ok(items[0].description.includes('متبقٍ 3 مقعد'));
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

  server.close();
  console.log('✅ nabras router: 8 cases passed — every failure path falls back to Botpress');
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
