/* ===========================================================================
   ما هي الحقول الموجودة فعلًا على موديلات الباقات؟

   ليه: مرتين لحد دلوقتي عمود واحد ناقص وقف قراءة كاملة وفضل صامت أسابيع —
   `website_published` في الـ domain، وبعدها `sale_ok` في قايمة الحقول، على
   نفس الموديل. الكود بقى يتعافى لوحده، بس القايمة الصح أحسن من التعافي.

   الطريقة: افتح engosoft.com وأنت مسجّل دخول كأدمن → F12 → Console → الصق
   الملف كله → Enter. لا يكتب ولا يعدّل أي شيء — قراءة فقط.
   انسخ الناتج وابعته كما هو.
   ========================================================================== */
(async () => {
  const rpc = async (model, method, args, kwargs = {}) => {
    const r = await fetch('/web/dataset/call_kw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call',
        params: { model, method, args, kwargs } }),
    });
    const j = await r.json();
    if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 300));
    return j.result;
  };

  // ما تطلبه الخدمة اليوم من كل موديل — لو عمود هنا مش موجود، ده سبب عطل.
  const WANTED = {
    'training.package': ['id', 'name', 'website_url', 'website_published',
      'package_type', 'attendee_type', 'sequence', 'total_price', 'final_price',
      'discount', 'discount_end_time', 'currency_id', 'attendee_online_discount',
      'attendee_onsite_discount', 'num_courses_display', 'training_hours_attendee',
      'training_hours_recorded', 'review_rating_avg', 'review_rating_count',
      'public_categ_ids', 'badge_text', 'levels_ids', 'product_ids', 'groups_ids',
      'similar_packages_ids', 'learning_outcomes_ids', 'write_date'],
    'training.package.product.line': ['id', 'name', 'package_id', 'level_id',
      'product_id', 'sequence', 'sale_ok', 'website_published'],
    'training.package.attendee.product.line': ['id', 'name', 'package_id',
      'level_id', 'product_id', 'sequence', 'sale_ok', 'website_published'],
    'training.package.level': ['id', 'name', 'package_id', 'sequence',
      'attendee_course_count', 'recorded_course_count'],
    'training.package.group': ['id', 'name', 'technical_name',
      'full_display_name', 'package_id', 'sale_status', 'is_available_for_sale',
      'first_event_date', 'online_event_ids', 'onsite_event_ids',
      'online_min_date_begin', 'online_max_date_end', 'onsite_min_date_begin',
      'onsite_max_date_end', 'online_total_price', 'onsite_total_price'],
    'learning.outcome': ['id', 'name', 'sequence'],
  };

  const report = {};
  for (const [model, wanted] of Object.entries(WANTED)) {
    try {
      const meta = await rpc(model, 'fields_get', [[]],
        { attributes: ['string', 'type', 'relation'] });
      const have = new Set(Object.keys(meta));
      const missing = wanted.filter((f) => !have.has(f));
      let rows = null;
      try { rows = await rpc(model, 'search_count', [[]]); } catch (e) { rows = '?'; }
      report[model] = {
        rows,
        MISSING_asked_for_but_not_there: missing,   // <-- ده اللي بيكسر القراءة
        all_fields: Object.entries(meta)
          .map(([f, i]) => `${f} (${i.type}${i.relation ? '->' + i.relation : ''})`)
          .sort(),
      };
    } catch (e) {
      report[model] = { ERROR: String(e).slice(0, 300) };
    }
  }

  console.log('%c=== الحقول الناقصة (دي اللي بتكسر القراءة) ===',
    'font-weight:bold;font-size:14px');
  for (const [m, r] of Object.entries(report)) {
    if (r.ERROR) { console.log(m, '->', r.ERROR); continue; }
    const miss = r.MISSING_asked_for_but_not_there;
    console.log(`${m}  (${r.rows} صف)  ->`,
      miss.length ? miss : 'كل الحقول موجودة ✅');
  }
  console.log('%c=== التقرير الكامل — انسخه وابعته ===',
    'font-weight:bold;font-size:14px');
  console.log(JSON.stringify(report, null, 2));
})();
