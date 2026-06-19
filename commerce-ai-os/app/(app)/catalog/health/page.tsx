'use client'

/**
 * Catalog Health — صفحة صحّة الكتالوج
 * Malak Commerce OS
 *
 * قراءة فقط (read-only) — تكشف ثغرات الكتالوج قبل أي أتمتة.
 * مبنية على السكيما الحقيقية لقاعدة البيانات:
 *   products(id, master_sku, barcode, product_name_en, product_name_ar,
 *            image_url, price, snoonu_sku, category_id, product_status,
 *            readiness_score, deleted_at)
 *   platform_products(platform, price, matched_master_sku)  — مرتبط على master_sku
 */

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

// ---------- الأنواع ----------
type Product = {
  id: number
  master_sku: string | null
  barcode: string | null
  product_name_en: string | null
  product_name_ar: string | null
  image_url: string | null
  price: number | null
  snoonu_sku: string | null
  category_id: number | null
  product_status: string | null
}

type PlatformProduct = {
  platform: string | null
  price: number | null
  matched_master_sku: string | null
}

type IssueKey =
  | 'no_image'
  | 'no_price'
  | 'dup_master_sku'
  | 'price_mismatch'
  | 'no_barcode'
  | 'no_snoonu_sku'
  | 'not_active'

type IssueDef = {
  key: IssueKey
  label: string
  desc: string
  severity: 'critical' | 'warning'
  test: (p: Product, ctx: Ctx) => boolean
}

type Ctx = {
  dupSkus: Set<string>
  ppBySku: Map<string, PlatformProduct[]>
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
    key: 'no_price',
    label: 'بدون سعر',
    desc: 'price فاضي (null) أو = 0 — خطأ يطلّع المنتج مجّاني',
    severity: 'critical',
    test: (p) => p.price === null || p.price === undefined || p.price === 0,
  },
  {
    key: 'dup_master_sku',
    label: 'master_sku مكرّر',
    desc: 'نفس الـmaster_sku على أكثر من منتج — يخرّب المطابقة بين المنصّات',
    severity: 'critical',
    test: (p, ctx) => !!p.master_sku && ctx.dupSkus.has(p.master_sku),
  },
  {
    key: 'price_mismatch',
    label: 'فرق سعر بين المنصّات',
    desc: 'سعر المنصّة يختلف عن سعر النظام (النظام هو المصدر الرسمي)',
    severity: 'critical',
    test: (p, ctx) => {
      if (p.price === null) return false
      if (!p.master_sku) return false
      const pps = ctx.ppBySku.get(p.master_sku) || []
      return pps.some(
        (pp) =>
          pp.price !== null &&
          Math.abs((pp.price as number) - (p.price as number)) > 0.001
      )
    },
  },
  {
    key: 'no_barcode',
    label: 'بدون باركود',
    desc: 'barcode فاضي — يحتاج توليد EAN-13',
    severity: 'warning',
    test: (p) => !p.barcode || p.barcode.trim() === '',
  },
  {
    key: 'no_snoonu_sku',
    label: 'غير مربوط بسنونو',
    desc: 'snoonu_sku فاضي',
    severity: 'warning',
    test: (p) => !p.snoonu_sku || p.snoonu_sku.trim() === '',
  },
  {
    key: 'not_active',
    label: 'غير نشط',
    desc: "product_status مو 'active' — لم يُفعّل/يُعتمد بعد",
    severity: 'warning',
    test: (p) => p.product_status !== 'active',
  },
  // ملاحظة: بطاقة low_readiness أُسقطت — عمود readiness_score كله NULL حاليًا.
  // ملاحظة: بطاقة rafeeq أُسقطت — لا يوجد عمود مقابل في السكيما الحالية.
]

// ---------- المكوّن ----------
export default function CatalogHealthPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [platformProducts, setPlatformProducts] = useState<PlatformProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeIssue, setActiveIssue] = useState<IssueKey | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const supabase = createClient()

        // جلب المنتجات على دفعات (تجاوز حد 1000 صف) — نستبعد المحذوف ناعمًا
        const all: Product[] = []
        const PAGE = 1000
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from('products')
            .select(
              'id, master_sku, barcode, product_name_en, product_name_ar, image_url, price, snoonu_sku, category_id, product_status'
            )
            .is('deleted_at', null)
            .range(from, from + PAGE - 1)
          if (error) throw error
          if (!data || data.length === 0) break
          all.push(...(data as Product[]))
          if (data.length < PAGE) break
        }

        // إدراجات المنصّات المرتبطة فقط (matched_master_sku != null). لو ما فيه
        // مطابقات (حاليًا الكل null) → فرق السعر = 0.
        const { data: pp, error: ppErr } = await supabase
          .from('platform_products')
          .select('platform, price, matched_master_sku')
          .not('matched_master_sku', 'is', null)
        if (ppErr) throw ppErr

        if (!cancelled) {
          setProducts(all)
          setPlatformProducts((pp as PlatformProduct[]) || [])
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'فشل تحميل البيانات')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // سياق الفحص (تكرار master_sku + ربط المنصّات بالـmaster_sku)
  const ctx: Ctx = useMemo(() => {
    const skuCount = new Map<string, number>()
    for (const p of products) {
      if (p.master_sku) skuCount.set(p.master_sku, (skuCount.get(p.master_sku) || 0) + 1)
    }
    const dupSkus = new Set<string>()
    skuCount.forEach((n, sku) => {
      if (n > 1) dupSkus.add(sku)
    })

    const ppBySku = new Map<string, PlatformProduct[]>()
    for (const pp of platformProducts) {
      if (!pp.matched_master_sku) continue
      const arr = ppBySku.get(pp.matched_master_sku) || []
      arr.push(pp)
      ppBySku.set(pp.matched_master_sku, arr)
    }
    return { dupSkus, ppBySku }
  }, [products, platformProducts])

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
    const dirty = new Set<number>()
    for (const k of critKeys) {
      for (const p of counts.get(k) || []) dirty.add(p.id)
    }
    return Math.round(((products.length - dirty.size) / products.length) * 100)
  }, [products, counts])

  const criticalTotal = useMemo(() => {
    const ids = new Set<number>()
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
          (p.master_sku || '').toLowerCase().includes(q) ||
          (p.product_name_ar || '').toLowerCase().includes(q) ||
          (p.product_name_en || '').toLowerCase().includes(q)
      )
    }
    return list
  }, [activeIssue, counts, search])

  // صفوف فرق السعر لكل منتج: المنصّات اللي سعرها يخالف سعر النظام فقط
  const mismatchRows = (p: Product) => {
    if (p.price === null || !p.master_sku) return []
    const pps = ctx.ppBySku.get(p.master_sku) || []
    return pps
      .filter(
        (pp) =>
          pp.price !== null &&
          Math.abs((pp.price as number) - (p.price as number)) > 0.001
      )
      .map((pp) => {
        const delta = Math.round(((pp.price as number) - (p.price as number)) * 100) / 100
        return {
          name: pp.platform || 'منصّة',
          system: p.price as number,
          channel: pp.price as number,
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
              placeholder="بحث بالـmaster_sku أو الاسم…"
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
                    <th style={S.th}>master_sku</th>
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
                        {p.master_sku || '—'}
                      </td>
                      <td style={S.td}>
                        {p.product_name_ar || p.product_name_en || '—'}
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
                      <td style={S.td}>{p.category_id ?? '—'}</td>
                      <td style={S.td}>
                        <a href={`/products?sku=${p.master_sku || ''}`} style={S.fixLink}>
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
