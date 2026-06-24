'use client'

/**
 * Catalog Health — صفحة صحّة الكتالوج
 * Malak Commerce OS
 *
 * الهدف: لوحة وحدة تكشف كل ثغرات الكتالوج قبل أي أتمتة.
 * تطبّق قاعدة المشروع: "لا أتمتة قبل كتالوج 100% نظيف".
 *
 * التركيب:
 *   1. انسخ هذا الملف إلى:
 *        commerce-ai-os/app/(app)/catalog/health/page.tsx
 *   2. أضف رابط التنقّل في lib/constants.ts تحت قسم Catalog:
 *        { label: 'صحّة الكتالوج', href: '/catalog/health', icon: 'Activity' }
 *   3. الصفحة تقرأ مباشرة من Supabase (read-only) — ما تكتب أي شي.
 *
 * يعتمد على السكيما الفعلية:
 *   products(sku, barcode, name_ar, name_en, image_url, price,
 *            snoonu_id, rafeeq_product_id, main_category, approval)
 *   channel_products(product_id, channel_id, channel_price, channel_status)
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

// ---------- الأنواع ----------
type Product = {
  id: string
  sku: string | null
  barcode: string | null
  name_ar: string | null
  name_en: string | null
  image_url: string | null
  price: number | null
  snoonu_id: string | null
  rafeeq_product_id: string | null
  main_category: string | null
  approval: string | null
}

type ChannelProduct = {
  product_id: string
  channel_id: string
  channel_price: number | null
  channel_status: string | null
}

type IssueKey =
  | 'no_image'
  | 'no_barcode'
  | 'no_price'
  | 'zero_price'
  | 'no_name_ar'
  | 'no_category'
  | 'dup_sku'
  | 'no_snoonu'
  | 'no_rafeeq'
  | 'price_mismatch'
  | 'not_approved'

type IssueDef = {
  key: IssueKey
  label: string
  desc: string
  severity: 'critical' | 'warning'
  test: (p: Product, ctx: Ctx) => boolean
}

type Ctx = {
  dupSkus: Set<string>
  cpByProduct: Map<string, ChannelProduct[]>
  // per-product variant barcode coverage: total options vs. options carrying a barcode
  variantStats: Map<string, { total: number; withBc: number }>
}

// ---------- تعريف الفحوصات ----------
const ISSUES: IssueDef[] = [
  {
    key: 'no_image',
    label: 'بدون صورة',
    desc: 'منتجات ما لها image_url — تمنع النشر على كل المنصّات',
    severity: 'critical',
    test: (p) => !p.image_url || p.image_url.trim() === '',
  },
  {
    key: 'zero_price',
    label: 'سعر صفر',
    desc: 'السعر = 0 — خطأ يطلّع المنتج مجّاني',
    severity: 'critical',
    test: (p) => p.price === 0,
  },
  {
    key: 'no_price',
    label: 'بدون سعر',
    desc: 'price فاضي (null)',
    severity: 'critical',
    test: (p) => p.price === null || p.price === undefined,
  },
  {
    key: 'dup_sku',
    label: 'SKU مكرّر',
    desc: 'نفس الـSKU على أكثر من منتج — يخرّب المطابقة بين المنصّات',
    severity: 'critical',
    test: (p, ctx) => !!p.sku && ctx.dupSkus.has(p.sku),
  },
  {
    key: 'price_mismatch',
    label: 'فرق سعر بين المنصّات',
    desc: 'سعر المنصّة يختلف عن سعر النظام (النظام هو المصدر الرسمي)',
    severity: 'critical',
    test: (p, ctx) => {
      if (p.price === null) return false
      const cps = ctx.cpByProduct.get(p.id) || []
      return cps.some(
        (cp) =>
          cp.channel_price !== null &&
          Math.abs((cp.channel_price as number) - (p.price as number)) > 0.001
      )
    },
  },
  {
    key: 'no_barcode',
    label: 'بدون باركود',
    desc: 'barcode فاضي — يحتاج توليد EAN-13 (المنتج ذو الخيارات: كل خيار يحتاج باركود)',
    severity: 'warning',
    test: (p, ctx) => {
      const vs = ctx.variantStats.get(p.id)
      // منتج له خيارات: يُعتبر مكتمل فقط لمّا كل خياراته فيها باركود.
      if (vs && vs.total > 0) return vs.withBc < vs.total
      // منتج عادي بدون خيارات: يعتمد على باركود المنتج نفسه.
      return !p.barcode || p.barcode.trim() === ''
    },
  },
  {
    key: 'no_name_ar',
    label: 'بدون اسم عربي',
    desc: 'name_ar فاضي — ناقص للعرض RTL',
    severity: 'warning',
    test: (p) => !p.name_ar || p.name_ar.trim() === '',
  },
  {
    key: 'no_category',
    label: 'بدون تصنيف',
    desc: 'main_category فاضي',
    severity: 'warning',
    test: (p) => !p.main_category || p.main_category.trim() === '',
  },
  {
    key: 'no_snoonu',
    label: 'غير مربوط بسنونو',
    desc: 'snoonu_id فاضي',
    severity: 'warning',
    test: (p) => !p.snoonu_id || p.snoonu_id.trim() === '',
  },
  {
    key: 'no_rafeeq',
    label: 'غير مربوط برفيق',
    desc: 'rafeeq_product_id فاضي',
    severity: 'warning',
    test: (p) => !p.rafeeq_product_id || String(p.rafeeq_product_id).trim() === '',
  },
  {
    key: 'not_approved',
    label: 'غير معتمد',
    desc: 'approved = false — مسودّة لم تُعتمد بعد',
    severity: 'warning',
    // schema uses a text `approval` column (Approved/Rejected/SentAI/null) — not a boolean.
    test: (p) => p.approval !== 'Approved',
  },
]

// ---------- المكوّن ----------
export default function CatalogHealthPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [variants, setVariants] = useState<{ parent_product_id: string; barcode: string | null }[]>([])
  const [channelProducts, setChannelProducts] = useState<ChannelProduct[]>([])
  const [channelNames, setChannelNames] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeIssue, setActiveIssue] = useState<IssueKey | null>(null)
  const [search, setSearch] = useState('')

  // يعيد فحص الكتالوج من قاعدة البيانات (قراءة فقط). يُستدعى عند فتح الصفحة
  // وعند الضغط على زر «تحديث» ليعكس آخر التغييرات بدون إعادة تحميل الصفحة.
  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const supabase = createClient()

      // جلب المنتجات على دفعات (تجاوز حد 1000 صف في Supabase)
      const all: Product[] = []
      const PAGE = 1000
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('products')
          .select(
            'id, sku, barcode, name_ar, name_en, image_url, price, snoonu_id, rafeeq_product_id, main_category, approval'
          )
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (!data || data.length === 0) break
        all.push(...(data as Product[]))
        if (data.length < PAGE) break
      }

      // قنوات المنتجات على دفعات أيضًا — بدون ذلك يتوقف الجلب عند 1000 صف
      // ويفوّت فحص اختلاف السعر سجلات بصمت.
      const cp: ChannelProduct[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error: cpErr } = await supabase
          .from('channel_products')
          .select('product_id, channel_id, channel_price, channel_status')
          .range(from, from + PAGE - 1)
        if (cpErr) throw cpErr
        if (!data || data.length === 0) break
        cp.push(...(data as ChannelProduct[]))
        if (data.length < PAGE) break
      }

      // خيارات المنتجات (للتحقق من تغطية باركود الخيارات). دفاعيًا: لو الجدول/العمود
      // مو موجود نكمل بدون ما نكسر الصفحة.
      const vrows: { parent_product_id: string; barcode: string | null }[] = []
      try {
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from('product_variants')
            .select('parent_product_id, barcode')
            .range(from, from + PAGE - 1)
          if (error) break
          if (!data || data.length === 0) break
          vrows.push(...(data as any[]))
          if (data.length < PAGE) break
        }
      } catch {
        /* variants optional */
      }

      // أسماء القنوات (Snoonu/Rafeeq/…) — دفاعيًا: لو الجدول/العمود مو موجود
      // نرجع لعرض channel_id الخام بدون ما نكسر الصفحة.
      const nameMap = new Map<string, string>()
      try {
        const { data: ch } = await supabase.from('channels').select('id, name')
        for (const c of (ch as { id: string; name: string | null }[]) || []) {
          if (c?.id != null) nameMap.set(String(c.id), c.name ?? String(c.id))
        }
      } catch {
        /* fallback: channel_id */
      }

      setProducts(all)
      setVariants(vrows)
      setChannelProducts(cp)
      setChannelNames(nameMap)
      setLastUpdated(new Date())
    } catch (e: any) {
      setError(e?.message || 'فشل تحميل البيانات')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // سياق الفحص (تكرار SKU + ربط المنصّات بالمنتج)
  const ctx: Ctx = useMemo(() => {
    const skuCount = new Map<string, number>()
    for (const p of products) {
      if (p.sku) skuCount.set(p.sku, (skuCount.get(p.sku) || 0) + 1)
    }
    const dupSkus = new Set<string>()
    skuCount.forEach((n, sku) => {
      if (n > 1) dupSkus.add(sku)
    })

    const cpByProduct = new Map<string, ChannelProduct[]>()
    for (const cp of channelProducts) {
      const arr = cpByProduct.get(cp.product_id) || []
      arr.push(cp)
      cpByProduct.set(cp.product_id, arr)
    }

    // تغطية باركود الخيارات لكل منتج
    const variantStats = new Map<string, { total: number; withBc: number }>()
    for (const v of variants) {
      if (!v.parent_product_id) continue
      const s = variantStats.get(v.parent_product_id) || { total: 0, withBc: 0 }
      s.total += 1
      if (v.barcode && String(v.barcode).trim() !== '') s.withBc += 1
      variantStats.set(v.parent_product_id, s)
    }

    return { dupSkus, cpByProduct, variantStats }
  }, [products, channelProducts, variants])

  // حساب كل المشاكل
  const counts = useMemo(() => {
    const m = new Map<IssueKey, Product[]>()
    for (const def of ISSUES) m.set(def.key, [])
    for (const p of products) {
      for (const def of ISSUES) {
        if (def.test(p, ctx)) m.get(def.key)!.push(p)
      }
    }
    return m
  }, [products, ctx])

  // درجة الصحّة: المنتجات بدون أي مشكلة حرجة
  const healthScore = useMemo(() => {
    if (products.length === 0) return 100
    const critKeys = ISSUES.filter((i) => i.severity === 'critical').map((i) => i.key)
    const dirty = new Set<string>()
    for (const k of critKeys) {
      for (const p of counts.get(k) || []) dirty.add(p.id)
    }
    return Math.round(((products.length - dirty.size) / products.length) * 100)
  }, [products, counts])

  const criticalTotal = useMemo(() => {
    const ids = new Set<string>()
    for (const def of ISSUES) {
      if (def.severity !== 'critical') continue
      for (const p of counts.get(def.key) || []) ids.add(p.id)
    }
    return ids.size
  }, [counts])

  const activeList = useMemo(() => {
    if (!activeIssue) return []
    let list = counts.get(activeIssue) || []
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(
        (p) =>
          (p.sku || '').toLowerCase().includes(q) ||
          (p.name_ar || '').toLowerCase().includes(q) ||
          (p.name_en || '').toLowerCase().includes(q)
      )
    }
    return list
  }, [activeIssue, counts, search])

  // صفوف فرق السعر لكل منتج: القنوات اللي سعرها يخالف سعر النظام فقط
  const mismatchRows = (p: Product) => {
    if (p.price === null) return []
    const cps = ctx.cpByProduct.get(p.id) || []
    return cps
      .filter(
        (cp) =>
          cp.channel_price !== null &&
          Math.abs((cp.channel_price as number) - (p.price as number)) > 0.001
      )
      .map((cp) => {
        const delta = Math.round(((cp.channel_price as number) - (p.price as number)) * 100) / 100
        return {
          name: channelNames.get(String(cp.channel_id)) || String(cp.channel_id),
          system: p.price as number,
          channel: cp.channel_price as number,
          delta,
        }
      })
  }

  // ---------- العرض ----------
  if (loading) return <Shell><Centered>جارٍ فحص الكتالوج…</Centered></Shell>
  if (error)
    return (
      <Shell>
        <Centered>
          <p style={{ color: '#dc2626', fontWeight: 600 }}>تعذّر تحميل البيانات</p>
          <p style={{ color: '#64748b', fontSize: 14, marginTop: 8 }}>{error}</p>
        </Centered>
      </Shell>
    )

  const scoreColor =
    healthScore >= 95 ? '#16a34a' : healthScore >= 80 ? '#d97706' : '#dc2626'

  return (
    <Shell>
      {/* الهيدر: درجة الصحّة */}
      <header style={S.header}>
        <div>
          <h1 style={S.h1}>صحّة الكتالوج</h1>
          <p style={S.sub}>
            {products.length.toLocaleString('ar')} منتج · فحص لحظي · قراءة فقط
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <button
              onClick={() => load(true)}
              disabled={loading || refreshing}
              style={{ ...S.refreshBtn, opacity: loading || refreshing ? 0.6 : 1 }}
            >
              {refreshing ? 'جارٍ التحديث…' : '↻ تحديث'}
            </button>
            {lastUpdated && (
              <span style={{ fontSize: 12, color: '#94a3b8' }}>
                آخر تحديث: {lastUpdated.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
          </div>
        </div>
        <div style={S.scoreBox}>
          <div style={{ ...S.scoreRing, borderColor: scoreColor }}>
            <span style={{ ...S.scoreNum, color: scoreColor }}>{healthScore}</span>
            <span style={S.scorePct}>%</span>
          </div>
          <div style={S.scoreMeta}>
            <span style={S.scoreLabel}>نظيف</span>
            <span style={{ fontSize: 13, color: criticalTotal ? '#dc2626' : '#16a34a' }}>
              {criticalTotal
                ? `${criticalTotal} منتج فيه مشكلة حرجة`
                : 'جاهز للأتمتة ✓'}
            </span>
          </div>
        </div>
      </header>

      {/* شريط البوابة */}
      <div
        style={{
          ...S.gate,
          background: criticalTotal ? '#fef2f2' : '#f0fdf4',
          borderColor: criticalTotal ? '#fecaca' : '#bbf7d0',
        }}
      >
        <span style={{ fontSize: 18 }}>{criticalTotal ? '🚦' : '✅'}</span>
        <span style={{ fontWeight: 600, color: criticalTotal ? '#991b1b' : '#166534' }}>
          {criticalTotal
            ? 'بوابة الأتمتة مقفلة — لازم تُحل المشاكل الحرجة أول'
            : 'بوابة الأتمتة مفتوحة — الكتالوج نظيف 100%'}
        </span>
      </div>

      {/* شبكة بطاقات المشاكل */}
      <section style={S.grid}>
        {ISSUES.map((def) => {
          const n = (counts.get(def.key) || []).length
          const isActive = activeIssue === def.key
          const isCrit = def.severity === 'critical'
          return (
            <button
              key={def.key}
              onClick={() => {
                setActiveIssue(isActive ? null : def.key)
                setSearch('')
              }}
              style={{
                ...S.card,
                borderColor: isActive ? '#0f172a' : n === 0 ? '#e2e8f0' : isCrit ? '#fecaca' : '#fde68a',
                background: n === 0 ? '#fff' : isCrit ? '#fff5f5' : '#fffbeb',
                boxShadow: isActive ? '0 0 0 2px #0f172a' : 'none',
              }}
            >
              <div style={S.cardTop}>
                <span
                  style={{
                    ...S.badge,
                    background: n === 0 ? '#dcfce7' : isCrit ? '#fee2e2' : '#fef3c7',
                    color: n === 0 ? '#166534' : isCrit ? '#991b1b' : '#92400e',
                  }}
                >
                  {isCrit ? 'حرج' : 'تنبيه'}
                </span>
                <span style={{ ...S.count, color: n === 0 ? '#16a34a' : isCrit ? '#dc2626' : '#d97706' }}>
                  {n === 0 ? '✓' : n}
                </span>
              </div>
              <h3 style={S.cardTitle}>{def.label}</h3>
              <p style={S.cardDesc}>{def.desc}</p>
            </button>
          )
        })}
      </section>

      {/* قائمة المنتجات المتأثرة */}
      {activeIssue && (
        <section style={S.detail}>
          <div style={S.detailHead}>
            <h2 style={S.detailTitle}>
              {ISSUES.find((i) => i.key === activeIssue)?.label}
              <span style={S.detailCount}>{activeList.length}</span>
            </h2>
            <input
              placeholder="بحث بالـSKU أو الاسم…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={S.searchInput}
            />
          </div>

          {activeList.length === 0 ? (
            <p style={S.empty}>ما فيه منتجات بهذه المشكلة 🎉</p>
          ) : (
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>SKU</th>
                    <th style={S.th}>الاسم</th>
                    <th style={S.th}>السعر</th>
                    <th style={S.th}>التصنيف</th>
                    <th style={S.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {activeList.slice(0, 200).map((p) => (
                    <tr key={p.id} style={S.tr}>
                      <td style={{ ...S.td, fontFamily: 'monospace', direction: 'ltr', textAlign: 'right' }}>
                        {p.sku || '—'}
                      </td>
                      <td style={S.td}>
                        {p.name_ar || p.name_en || '—'}
                        {activeIssue === 'price_mismatch' && (
                          <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {mismatchRows(p).map((m, i) => (
                              <span key={i} style={{ fontSize: 12, color: '#475569' }}>
                                {m.name}: النظام {m.system} · المنصّة {m.channel}{' '}
                                <span style={{ fontWeight: 700, color: m.delta > 0 ? '#dc2626' : '#d97706' }}>
                                  ({m.delta > 0 ? '+' : ''}
                                  {m.delta})
                                </span>
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td style={S.td}>{p.price ?? '—'}</td>
                      <td style={S.td}>{p.main_category || '—'}</td>
                      <td style={S.td}>
                        <a href={`/products?sku=${p.sku || ''}`} style={S.fixLink}>
                          تصحيح ←
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {activeList.length > 200 && (
                <p style={S.more}>+{activeList.length - 200} منتج إضافي — استخدم البحث للتصفية</p>
              )}
            </div>
          )}
        </section>
      )}

      {!activeIssue && (
        <p style={S.hint}>اضغط أي بطاقة لعرض المنتجات المتأثرة وتصحيحها</p>
      )}
    </Shell>
  )
}

// ---------- أغلفة ----------
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div dir="rtl" style={S.shell}>
      {children}
    </div>
  )
}
function Centered({ children }: { children: React.ReactNode }) {
  return <div style={S.centered}>{children}</div>
}

// ---------- الأنماط ----------
const S: Record<string, React.CSSProperties> = {
  shell: {
    padding: '24px clamp(16px, 4vw, 40px)',
    fontFamily: "'Tajawal', system-ui, sans-serif",
    color: '#0f172a',
    maxWidth: 1200,
    margin: '0 auto',
  },
  centered: { minHeight: '50vh', display: 'grid', placeItems: 'center', textAlign: 'center', color: '#475569' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16, marginBottom: 20 },
  h1: { fontSize: 26, fontWeight: 800, margin: 0 },
  sub: { fontSize: 14, color: '#64748b', marginTop: 4 },
  refreshBtn: {
    font: 'inherit', fontSize: 13, fontWeight: 700, color: '#0f172a',
    background: '#fff', border: '1.5px solid #cbd5e1', borderRadius: 10,
    padding: '6px 14px', cursor: 'pointer',
  },
  scoreBox: { display: 'flex', alignItems: 'center', gap: 14 },
  scoreRing: {
    width: 78, height: 78, borderRadius: '50%', border: '5px solid', display: 'grid',
    placeItems: 'center', position: 'relative',
  },
  scoreNum: { fontSize: 28, fontWeight: 800, lineHeight: 1 },
  scorePct: { fontSize: 12, color: '#94a3b8', position: 'absolute', bottom: 14 },
  scoreMeta: { display: 'flex', flexDirection: 'column', gap: 2 },
  scoreLabel: { fontSize: 13, color: '#94a3b8' },
  gate: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 12, border: '1px solid', marginBottom: 24 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 },
  card: {
    textAlign: 'right', border: '1.5px solid', borderRadius: 14, padding: 16, cursor: 'pointer',
    transition: 'all .15s', font: 'inherit', display: 'flex', flexDirection: 'column', gap: 6,
  },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  badge: { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6 },
  count: { fontSize: 24, fontWeight: 800 },
  cardTitle: { fontSize: 15, fontWeight: 700, margin: 0 },
  cardDesc: { fontSize: 12, color: '#64748b', margin: 0, lineHeight: 1.5 },
  detail: { marginTop: 24, border: '1px solid #e2e8f0', borderRadius: 16, overflow: 'hidden' },
  detailHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, padding: 16, background: '#f8fafc', borderBottom: '1px solid #e2e8f0' },
  detailTitle: { fontSize: 18, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 10 },
  detailCount: { fontSize: 13, fontWeight: 700, background: '#0f172a', color: '#fff', borderRadius: 999, padding: '2px 10px' },
  searchInput: { padding: '8px 12px', borderRadius: 10, border: '1px solid #cbd5e1', fontSize: 14, font: 'inherit', minWidth: 200 },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  th: { textAlign: 'right', padding: '10px 16px', fontSize: 12, fontWeight: 700, color: '#64748b', borderBottom: '1px solid #e2e8f0', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #f1f5f9' },
  td: { padding: '10px 16px', whiteSpace: 'nowrap' },
  fixLink: { color: '#2563eb', fontWeight: 600, fontSize: 13, textDecoration: 'none' },
  empty: { padding: 32, textAlign: 'center', color: '#16a34a', fontWeight: 600 },
  more: { padding: 12, textAlign: 'center', fontSize: 13, color: '#94a3b8' },
  hint: { marginTop: 24, textAlign: 'center', fontSize: 14, color: '#94a3b8' },
}
