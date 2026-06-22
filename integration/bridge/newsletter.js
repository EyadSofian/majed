'use strict';
/**
 * Newsletter / email opt-in for «ماجد».
 *
 * Responsibilities:
 *  - store subscribers (Railway PostgreSQL when DATABASE_URL is set; else a local
 *    JSONL file so dev/preview still works without a DB),
 *  - a password-protected admin dashboard at /admin to view, export and broadcast,
 *  - send broadcasts over Engosoft SMTP (nodemailer); falls back to a logged dry-run
 *    when SMTP is not configured,
 *  - a public /unsubscribe?token=… link (required for any bulk email).
 *
 * Heavy deps (pg, nodemailer) are required lazily so the bridge still boots if they
 * are missing and the feature is unused.
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');

// ---- config (all via env) ----
const DATABASE_URL = process.env.DATABASE_URL || '';
const PGSSL = String(process.env.PGSSL || '') === 'true';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_SECURE = String(process.env.SMTP_SECURE || '') === 'true' || SMTP_PORT === 465;
const MAIL_FROM = process.env.MAIL_FROM || (SMTP_USER ? 'Majed <' + SMTP_USER + '>' : 'Majed <no-reply@engosoft.com>');
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const FILE_STORE = path.join(__dirname, 'data', 'subscribers.jsonl');

function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function newToken() { return crypto.randomBytes(16).toString('hex'); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function nl2br(s) { return esc(s).replace(/\n/g, '<br/>'); }
function stripHtml(s) { return String(s || '').replace(/<[^>]+>/g, ''); }

// ---------- storage ----------
let pool = null;
function pg() {
  if (!DATABASE_URL) return null;
  if (pool) return pool;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL, ssl: PGSSL ? { rejectUnauthorized: false } : false });
  return pool;
}
const usingDb = !!DATABASE_URL;

async function initDb() {
  const p = pg();
  if (!p) {
    console.log('[newsletter] no DATABASE_URL — using local file store (' + FILE_STORE + ')');
    return;
  }
  await p.query(
    'CREATE TABLE IF NOT EXISTS subscribers (' +
    ' id SERIAL PRIMARY KEY,' +
    ' email TEXT UNIQUE NOT NULL,' +
    " name TEXT DEFAULT ''," +
    " source TEXT DEFAULT 'widget'," +
    " status TEXT DEFAULT 'subscribed'," +
    ' token TEXT NOT NULL,' +
    ' created_at TIMESTAMPTZ DEFAULT now(),' +
    ' updated_at TIMESTAMPTZ DEFAULT now())'
  );
  await p.query(
    'CREATE TABLE IF NOT EXISTS campaigns (' +
    ' id SERIAL PRIMARY KEY,' +
    ' subject TEXT,' +
    ' recipients INT DEFAULT 0,' +
    ' sent_at TIMESTAMPTZ DEFAULT now())'
  );
  console.log('[newsletter] PostgreSQL store ready');
}

// --- file fallback helpers (dev only) ---
function readFileSubs() {
  let lines = [];
  try { lines = fs.readFileSync(FILE_STORE, 'utf8').split('\n'); } catch (e) { return []; }
  const map = new Map(); // email -> latest record (so a later unsubscribe wins)
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let r; try { r = JSON.parse(ln); } catch (e) { continue; }
    if (!r.email) continue;
    const prev = map.get(r.email) || {};
    map.set(r.email, Object.assign({ status: 'subscribed', token: newToken() }, prev, r));
  }
  return Array.from(map.values());
}
function appendFileSub(rec) {
  try { fs.mkdirSync(path.dirname(FILE_STORE), { recursive: true }); fs.appendFileSync(FILE_STORE, JSON.stringify(rec) + '\n'); }
  catch (e) { console.error('[newsletter] file write failed:', e.message); }
}

async function addSubscriber(input) {
  const email = String(input.email || '').trim().toLowerCase();
  if (!isEmail(email)) { const e = new Error('invalid_email'); e.code = 'invalid_email'; throw e; }
  const name = String(input.name || '').slice(0, 120);
  const source = String(input.source || 'widget').slice(0, 40);
  const token = newToken();
  const p = pg();
  if (p) {
    const r = await p.query(
      'INSERT INTO subscribers (email,name,source,token) VALUES ($1,$2,$3,$4)' +
      ' ON CONFLICT (email) DO UPDATE SET' +
      "  name = COALESCE(NULLIF(EXCLUDED.name,''), subscribers.name)," +
      "  status = 'subscribed', updated_at = now()" +
      ' RETURNING email,name,source,status,token',
      [email, name, source, token]
    );
    return r.rows[0];
  }
  const rec = { email, name, source, status: 'subscribed', token, ts: new Date().toISOString() };
  appendFileSub(rec);
  return rec;
}

async function listSubscribers(opts) {
  opts = opts || {};
  const status = opts.status || null;       // 'subscribed' | 'unsubscribed' | null(all)
  const q = (opts.q || '').trim().toLowerCase();
  const p = pg();
  let rows;
  if (p) {
    const where = [], args = [];
    if (status) { args.push(status); where.push('status = $' + args.length); }
    if (q) { args.push('%' + q + '%'); where.push('(lower(email) LIKE $' + args.length + ' OR lower(name) LIKE $' + args.length + ')'); }
    const sql = 'SELECT email,name,source,status,token,created_at FROM subscribers' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC';
    rows = (await p.query(sql, args)).rows;
  } else {
    rows = readFileSubs();
    if (status) rows = rows.filter(function (r) { return (r.status || 'subscribed') === status; });
    if (q) rows = rows.filter(function (r) { return (r.email + ' ' + (r.name || '')).toLowerCase().indexOf(q) !== -1; });
    rows.sort(function (a, b) { return String(b.ts || '').localeCompare(String(a.ts || '')); });
  }
  return rows;
}

async function unsubscribeByToken(token) {
  token = String(token || '');
  if (!token) return false;
  const p = pg();
  if (p) {
    const r = await p.query("UPDATE subscribers SET status='unsubscribed', updated_at=now() WHERE token=$1", [token]);
    return r.rowCount > 0;
  }
  const subs = readFileSubs();
  const hit = subs.find(function (s) { return s.token === token; });
  if (!hit) return false;
  appendFileSub(Object.assign({}, hit, { status: 'unsubscribed', ts: new Date().toISOString() }));
  return true;
}

async function recordCampaign(subject, recipients) {
  const p = pg();
  if (!p) return;
  try { await p.query('INSERT INTO campaigns (subject,recipients) VALUES ($1,$2)', [String(subject || '').slice(0, 200), recipients]); }
  catch (e) { console.error('[newsletter] campaign log failed:', e.message); }
}

// ---------- mailer ----------
let transport = null;
function mailer() {
  if (!SMTP_HOST) return null;
  if (transport) return transport;
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
  });
  return transport;
}
function unsubLink(token) {
  return (PUBLIC_BASE_URL || '') + '/unsubscribe?token=' + encodeURIComponent(token || '');
}
function wrapHtml(bodyHtml, unsub) {
  return '<div dir="rtl" style="font-family:Tajawal,Arial,sans-serif;max-width:600px;margin:0 auto;color:#171b2e;line-height:1.8">' +
    bodyHtml +
    '<hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>' +
    '<p style="font-size:12px;color:#999">وصلتك الرسالة دي لأنك مشترك في تحديثات ماجد · ' +
    '<a href="' + esc(unsub) + '" style="color:#7c5cff">إلغاء الاشتراك</a></p></div>';
}

// send ONE email (used for test sends)
async function sendOne(toEmail, subject, message, token) {
  const unsub = unsubLink(token || 'test');
  const html = wrapHtml(nl2br(message), unsub);
  const text = message + '\n\nلإلغاء الاشتراك: ' + unsub;
  const t = mailer();
  if (!t) { console.log('[newsletter dry-run] would email', toEmail, '·', subject); return { dryRun: true }; }
  await t.sendMail({ from: MAIL_FROM, to: toEmail, subject: subject, html: html, text: text, headers: { 'List-Unsubscribe': '<' + unsub + '>' } });
  return { dryRun: false };
}

async function sendBroadcast(subject, message) {
  const subs = await listSubscribers({ status: 'subscribed' });
  const t = mailer();
  if (!PUBLIC_BASE_URL) console.warn('[newsletter] PUBLIC_BASE_URL not set — unsubscribe links will be relative/broken.');
  let sent = 0, failed = 0;
  for (const s of subs) {
    try { await sendOne(s.email, subject, message, s.token); sent++; }
    catch (e) { failed++; console.error('[newsletter] send fail', s.email, e.message); }
    await sleep(120); // gentle rate limit
  }
  await recordCampaign(subject, sent);
  return { total: subs.length, sent: sent, failed: failed, dryRun: !t };
}

// ---------- admin auth ----------
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (e) { return false; }
}
function adminAuth(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!ADMIN_PASSWORD) {
    return res.status(503).type('html').send('<div dir="rtl" style="font-family:system-ui;padding:40px;text-align:center"><h3>لوحة الاشتراكات مقفولة</h3><p>عرّف <code>ADMIN_PASSWORD</code> في Railway env عشان تفتحها.</p></div>');
  }
  const hdr = req.headers.authorization || '';
  const parts = hdr.split(' ');
  if (parts[0] === 'Basic' && parts[1]) {
    const decoded = Buffer.from(parts[1], 'base64').toString();
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(pass, ADMIN_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Majed Admin"');
  return res.status(401).send('Auth required');
}

// ---------- routers ----------
const publicRouter = express.Router();
publicRouter.get('/unsubscribe', async function (req, res) {
  try { await unsubscribeByToken(req.query.token); } catch (e) {}
  res.type('html').send('<div dir="rtl" style="font-family:system-ui;text-align:center;padding:64px 20px"><h2>تم إلغاء اشتراكك ✅</h2><p style="color:#666">مش هتوصلك رسايل تانية من ماجد. تقدر تشترك تاني أي وقت من الشات.</p></div>');
});

const adminRouter = express.Router();
adminRouter.use(adminAuth);

adminRouter.get('/', function (_req, res) { res.type('html').send(DASHBOARD_HTML); });

adminRouter.get('/api/subscribers', async function (req, res) {
  try {
    const rows = await listSubscribers({ status: req.query.status || null, q: req.query.q || '' });
    const all = await listSubscribers({});
    res.json({
      store: usingDb ? 'postgres' : 'file',
      smtp: !!SMTP_HOST,
      counts: {
        subscribed: all.filter(function (r) { return (r.status || 'subscribed') === 'subscribed'; }).length,
        unsubscribed: all.filter(function (r) { return r.status === 'unsubscribed'; }).length
      },
      subscribers: rows.map(function (r) {
        return { email: r.email, name: r.name || '', source: r.source || '', status: r.status || 'subscribed', created_at: r.created_at || r.ts || '' };
      })
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.get('/export.csv', async function (_req, res) {
  try {
    const rows = await listSubscribers({});
    const head = 'email,name,source,status,created_at\n';
    const body = rows.map(function (r) {
      return [r.email, r.name || '', r.source || '', r.status || 'subscribed', r.created_at || r.ts || '']
        .map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="majed-subscribers.csv"');
    res.send(head + body);
  } catch (e) { res.status(500).send(e.message); }
});

adminRouter.post('/api/send', express.json({ limit: '256kb' }), async function (req, res) {
  try {
    const subject = String(req.body && req.body.subject || '').trim();
    const message = String(req.body && req.body.message || '').trim();
    const testEmail = String(req.body && req.body.testEmail || '').trim().toLowerCase();
    if (!subject || !message) return res.status(400).json({ error: 'subject_and_message_required' });
    if (testEmail) {
      if (!isEmail(testEmail)) return res.status(400).json({ error: 'invalid_test_email' });
      const r = await sendOne(testEmail, subject, message, 'test');
      return res.json({ ok: true, mode: 'test', to: testEmail, dryRun: r.dryRun });
    }
    const result = await sendBroadcast(subject, message);
    return res.json(Object.assign({ ok: true, mode: 'broadcast' }, result));
  } catch (e) {
    console.error('[newsletter] send error:', e.message);
    return res.status(500).json({ error: 'send_failed' });
  }
});

const DASHBOARD_HTML = '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"/>' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"/><title>ماجد — لوحة المشتركين</title>' +
  '<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet"/>' +
  '<style>' +
  '*{box-sizing:border-box}body{margin:0;font-family:Tajawal,system-ui,sans-serif;background:#eef1fb;color:#171b2e;padding:22px}' +
  '.wrap{max-width:980px;margin:0 auto}h1{font-size:21px;margin:0 0 4px}.muted{color:#6b7280;font-size:13px;margin:0 0 18px}' +
  '.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}' +
  '.card{background:#fff;border:1px solid #e7eaf3;border-radius:14px;padding:14px 18px;min-width:140px;box-shadow:0 6px 18px rgba(15,30,66,.05)}' +
  '.card b{display:block;font-size:26px;font-weight:800}.card span{font-size:12px;color:#6b7280}' +
  '.pill{display:inline-block;font-size:11px;padding:2px 9px;border-radius:999px;background:#ede9ff;color:#7c5cff;font-weight:700}' +
  '.pill.off{background:#fee2e2;color:#dc2626}' +
  '.panel{background:#fff;border:1px solid #e7eaf3;border-radius:16px;padding:18px;margin-bottom:18px;box-shadow:0 8px 22px rgba(15,30,66,.05)}' +
  '.panel h2{font-size:15px;margin:0 0 12px}' +
  'input,textarea{width:100%;font:inherit;font-size:14px;border:1px solid #e3e6f0;border-radius:10px;padding:10px 12px;background:#f8f9fd;outline:0}' +
  'textarea{min-height:120px;resize:vertical;line-height:1.7}label{display:block;font-size:12.5px;font-weight:700;margin:10px 0 5px;color:#4b5168}' +
  '.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:12px}' +
  'button{font:inherit;font-weight:800;border:0;border-radius:10px;padding:10px 18px;cursor:pointer}' +
  '.go{background:linear-gradient(135deg,#7c5cff,#06b6d4);color:#fff}.ghost{background:#f1f3f9;color:#374151}' +
  '.res{font-size:13px;margin-top:10px;min-height:18px}table{width:100%;border-collapse:collapse;font-size:13px}' +
  'th,td{text-align:right;padding:9px 8px;border-bottom:1px solid #eef0f6}th{color:#6b7280;font-size:12px}' +
  '.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}.toolbar input{max-width:240px}' +
  'a.btn{display:inline-block;text-decoration:none;background:#f1f3f9;color:#374151;padding:9px 14px;border-radius:10px;font-weight:800;font-size:13px}' +
  '.warn{font-size:12px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:8px 12px;margin-top:10px}' +
  '</style></head><body><div class="wrap">' +
  '<h1>📬 مشتركين ماجد</h1><p class="muted">عرض الإيميلات وإرسال التحديثات. <span id="env"></span></p>' +
  '<div class="cards">' +
  '<div class="card"><b id="c-sub">—</b><span>مشترك فعّال</span></div>' +
  '<div class="card"><b id="c-off">—</b><span>ألغى الاشتراك</span></div>' +
  '<div class="card"><span>التخزين</span><b id="c-store" style="font-size:16px;margin-top:6px">—</b></div>' +
  '<div class="card"><span>الإرسال (SMTP)</span><b id="c-smtp" style="font-size:16px;margin-top:6px">—</b></div>' +
  '</div>' +
  '<div class="panel"><h2>✍️ إرسال تحديث للمشتركين</h2>' +
  '<label>العنوان (Subject)</label><input id="subject" placeholder="مثلاً: دورة جديدة وصلت 🎉"/>' +
  '<label>الرسالة</label><textarea id="message" placeholder="اكتب التحديث هنا… (سطر جديد = سطر في الإيميل)"></textarea>' +
  '<label>تجربة لإيميل واحد قبل البث (اختياري)</label><input id="test" placeholder="your@email.com — يبعت للعنوان ده بس"/>' +
  '<div class="row"><button class="go" id="send">🚀 إرسال</button><button class="ghost" id="sendTest">✉️ إرسال تجريبي</button><span class="res" id="res"></span></div>' +
  '<div class="warn" id="dry" style="display:none">SMTP مش متظبّط — الإرسال هيشتغل «تجريبي» (مش هيتبعت فعليًا) لحد ما تظبّط بيانات SMTP.</div>' +
  '</div>' +
  '<div class="panel"><h2>👥 المشتركين</h2>' +
  '<div class="toolbar"><input id="q" placeholder="بحث بالإيميل أو الاسم…"/>' +
  '<a class="btn" href="export.csv">⬇️ تصدير CSV</a></div>' +
  '<table><thead><tr><th>الإيميل</th><th>الاسم</th><th>المصدر</th><th>الحالة</th><th>التاريخ</th></tr></thead>' +
  '<tbody id="rows"><tr><td colspan="5" style="color:#999">جارِ التحميل…</td></tr></tbody></table></div>' +
  '</div><script>' +
  'var $=function(s){return document.querySelector(s)};' +
  'function fmt(d){if(!d)return "";try{return new Date(d).toLocaleString("ar-EG")}catch(e){return String(d)}}' +
  'function load(){var q=encodeURIComponent($("#q").value||"");' +
  'fetch("api/subscribers?q="+q).then(function(r){return r.json()}).then(function(d){' +
  '$("#c-sub").textContent=d.counts.subscribed;$("#c-off").textContent=d.counts.unsubscribed;' +
  '$("#c-store").textContent=d.store==="postgres"?"PostgreSQL":"ملف (محلي)";' +
  '$("#c-smtp").textContent=d.smtp?"متظبّط ✅":"غير متظبّط";' +
  '$("#dry").style.display=d.smtp?"none":"block";' +
  'var rows=d.subscribers.map(function(s){return "<tr><td>"+s.email+"</td><td>"+(s.name||"")+"</td><td>"+(s.source||"")+"</td><td>"+(s.status==="unsubscribed"?\'<span class=\\\'pill off\\\'>ملغى</span>\':\'<span class=\\\'pill\\\'>فعّال</span>\')+"</td><td>"+fmt(s.created_at)+"</td></tr>"}).join("");' +
  '$("#rows").innerHTML=rows||\'<tr><td colspan=5 style=color:#999>لا يوجد مشتركين بعد</td></tr>\';});}' +
  'function send(test){var btn=test?$("#sendTest"):$("#send");var body={subject:$("#subject").value,message:$("#message").value};if(test)body.testEmail=$("#test").value;' +
  'if(!body.subject||!body.message){$("#res").textContent="اكتب العنوان والرسالة الأول.";return;}' +
  'btn.disabled=true;$("#res").textContent="بيتبعت…";' +
  'fetch("api/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(d){btn.disabled=false;' +
  'if(d.error){$("#res").textContent="خطأ: "+d.error;return;}' +
  'if(d.mode==="test"){$("#res").textContent=(d.dryRun?"تجريبي (لم يُرسل فعليًا) إلى ":"اتبعت تجريبي إلى ")+d.to;}' +
  'else{$("#res").textContent=(d.dryRun?"تجريبي: ":"تم الإرسال ✅ ")+"إلى "+d.sent+" من "+d.total+(d.failed?(" · فشل "+d.failed):"");load();}' +
  '}).catch(function(){btn.disabled=false;$("#res").textContent="فشل الاتصال."});}' +
  '$("#send").onclick=function(){send(false)};$("#sendTest").onclick=function(){send(true)};' +
  'var t;$("#q").oninput=function(){clearTimeout(t);t=setTimeout(load,250)};load();' +
  '</script></body></html>';

module.exports = { initDb, addSubscriber, listSubscribers, sendBroadcast, publicRouter, adminRouter };
