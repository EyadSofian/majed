/* ===========================================================================
   ما هي الحقول التي يخزّن فيها الموقع نبذة المحاضر وتخصصاته وخبرته؟

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

  // 1) كل حقول hr.employee باسمها ونوعها ولابلها
  const meta = await rpc('hr.employee', 'fields_get', [[]],
    { attributes: ['string', 'type', 'relation', 'store'] });

  const STD = new Set(['id','name','job_title','work_email','department_id',
    'active','company_id','create_date','write_date','image_1920','image_128']);
  const custom = Object.entries(meta)
    .filter(([f, i]) => !STD.has(f)
      && ['char','text','html','one2many','many2many'].includes(i.type))
    .map(([f, i]) => ({ field: f, label: i.string, type: i.type,
                        relation: i.relation || null }));

  // 2) محاضر حقيقي كمثال، بكل الحقول النصية والعلائقية المرشّحة
  const HINT = /(bio|about|profile|summary|special|expert|experience|certif|achiev|linkedin|نبذ|سير|خبر|تخصص|اعتماد|شهاد|إنجاز|انجاز)/i;
  const likely = custom.filter((c) => HINT.test(c.field) || HINT.test(c.label || ''));
  const [emp] = await rpc('hr.employee', 'search_read',
    [[['job_title', 'ilike', 'instructor']]],
    { fields: ['id', 'name', 'job_title', ...likely.map((c) => c.field)], limit: 1 });

  // 3) العلاقات: إيه اللي جوّاها فعلاً
  const related = {};
  for (const c of likely) {
    if (!c.relation || !emp || !Array.isArray(emp[c.field]) || !emp[c.field].length) continue;
    try {
      related[c.field] = await rpc(c.relation, 'read',
        [emp[c.field].slice(0, 5)], { fields: ['id', 'display_name'] });
    } catch (e) { related[c.field] = String(e).slice(0, 120); }
  }

  const out = { custom_fields_count: custom.length, likely_profile_fields: likely,
                sample_instructor: emp || null, related_records: related,
                all_custom_fields: custom };
  console.log(JSON.stringify(out, null, 2));
  try { await navigator.clipboard.writeText(JSON.stringify(out)); 
        console.log('%c✅ اتنسخ في الكليب بورد — الصقه في الشات', 'color:#0f0;font-size:14px'); }
  catch (e) { console.log('انسخ الناتج اللي فوق يدويًا'); }
})();
