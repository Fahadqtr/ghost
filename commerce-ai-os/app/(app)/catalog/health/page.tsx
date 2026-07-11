'use client'

/**
 * Catalog Health — صفحة صحّة الكتالوج
 *
 * لوحة وحدة تكشف كل ثغرات الكتالوج قبل أي أتمتة، وتُصلحها من نفس المكان
 * (نافذة تصحيح + إجراءات جماعية + إصلاح سريع للصورة/السعر داخل القائمة).
 * تطبّق قاعدة المشروع: "لا أتمتة قبل كتالوج نظيف". تقرأ مباشرة من Supabase؛
 * الكتابة فقط عند التصحيح. مُنسّقة بـTailwind لتوحيد الشكل مع باقي التطبيق.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { setVariantBarcodes, upsertVariants } from '@/app/(app)/inventory/actions'
import { uploadProductImage } from '@/app/(app)/products/image-actions'
import { effectivePrice, priceRangeLabel, type EffectivePrice, type PricedVariant } from '@/lib/products/price-compute'

// ---------- الأنواع ----------
type Product = {
  id: string
  sku: string | null
  barcode: string | null
  name_ar: string | null
  name_en: string | null
  image_url: string | null
  price: number | null
  discount_price: number | null
  snoonu_id: string | null
  rafeeq_product_id: string | null
  main_category: string | null
  approval: string | null
}

// ملاحظة: جدول product_variants فيه price فقط — ما فيه discount_price.
type Variant = { id: string; parent_product_id: string; variant_name: string | null; barcode: string | null; price: number | null }

type ChannelProduct = {
  product_id: string
  channel_id: string
  channel_price: number | null
  channel_status: string | null
}

type IssueKey =
  | 'no_image' | 'no_barcode' | 'no_price' | 'zero_price' | 'no_name_ar'
  | 'no_category' | 'dup_sku' | 'no_snoonu' | 'no_rafeeq' | 'no_channel_link'
  | 'price_mismatch' | 'not_approved'

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
  variantStats: Map<string, { total: number; withBc: number }>
  // Effective price per product: if the product has priced options, the price
  // comes FROM the options (a range) — otherwise from the parent price.
  priceByProduct: Map<string, EffectivePrice>
}

// السعر الفعّال للمنتج (يراعي أسعار الخيارات إن وجدت)
const effOf = (p: Product, ctx: Ctx): EffectivePrice =>
  ctx.priceByProduct.get(p.id) ?? effectivePrice(p.price, p.discount_price, null)

// ---------- تعريف الفحوصات ----------
const ISSUES: IssueDef[] = [
  { key: 'no_image', label: 'بدون صورة', desc: 'منتجات ما لها image_url — تمنع النشر على كل المنصّات', severity: 'critical', test: (p) => !p.image_url || p.image_url.trim() === '' },
  // سعر صفر/بدون سعر: المنتج ذو الخيارات المُسعّرة يمشي على سعر الخيارات، فلا يُعتبر ناقصًا.
  { key: 'zero_price', label: 'سعر صفر', desc: 'السعر = 0 وما في خيارات مُسعّرة — خطأ يطلّع المنتج مجّاني', severity: 'critical', test: (p, ctx) => p.price === 0 && !effOf(p, ctx).hasPrice },
  { key: 'no_price', label: 'بدون سعر', desc: 'price فاضي (null) وما في خيارات مُسعّرة', severity: 'critical', test: (p, ctx) => (p.price === null || p.price === undefined) && !effOf(p, ctx).hasPrice },
  { key: 'dup_sku', label: 'SKU مكرّر', desc: 'نفس الـSKU على أكثر من منتج — يخرّب المطابقة بين المنصّات', severity: 'critical', test: (p, ctx) => !!p.sku && ctx.dupSkus.has(p.sku) },
  {
    key: 'price_mismatch', label: 'فرق سعر بين المنصّات', desc: 'سعر المنصّة يختلف عن سعر النظام (النظام هو المصدر الرسمي)', severity: 'critical',
    test: (p, ctx) => {
      if (p.price === null) return false
      const cps = ctx.cpByProduct.get(p.id) || []
      return cps.some((cp) => cp.channel_price !== null && Math.abs((cp.channel_price as number) - (p.price as number)) > 0.001)
    },
  },
  {
    key: 'no_barcode', label: 'بدون باركود', desc: 'barcode فاضي — يحتاج توليد EAN-13 (المنتج ذو الخيارات: كل خيار يحتاج باركود)', severity: 'warning',
    test: (p, ctx) => {
      const vs = ctx.variantStats.get(p.id)
      if (vs && vs.total > 0) return vs.withBc < vs.total
      return !p.barcode || p.barcode.trim() === ''
    },
  },
  { key: 'no_name_ar', label: 'بدون اسم عربي', desc: 'name_ar فاضي — ناقص للعرض RTL', severity: 'warning', test: (p) => !p.name_ar || p.name_ar.trim() === '' },
  { key: 'no_category', label: 'بدون تصنيف', desc: 'main_category فاضي', severity: 'warning', test: (p) => !p.main_category || p.main_category.trim() === '' },
  { key: 'no_snoonu', label: 'غير مربوط بسنونو', desc: 'snoonu_id فاضي', severity: 'warning', test: (p) => !p.snoonu_id || p.snoonu_id.trim() === '' },
  { key: 'no_rafeeq', label: 'غير مربوط برفيق', desc: 'rafeeq_product_id فاضي', severity: 'warning', test: (p) => !p.rafeeq_product_id || String(p.rafeeq_product_id).trim() === '' },
  {
    key: 'no_channel_link', label: 'غير مربوط بكل المنصّات', desc: 'ينقصه ربط سنونو و/أو رفيق — ربط سريع للكل بالـSKU', severity: 'warning',
    test: (p) => !p.snoonu_id || p.snoonu_id.trim() === '' || !p.rafeeq_product_id || String(p.rafeeq_product_id).trim() === '',
  },
  {
    key: 'not_approved', label: 'بانتظار الاعتماد', desc: 'منتجات لم تُراجَع بعد (بدون قرار اعتماد) — لا تشمل المرفوض', severity: 'warning',
    // truly-undecided only: null/empty approval. Rejected/SentAI already have a decision, so they're not "pending".
    test: (p) => p.approval == null || String(p.approval).trim() === '',
  },
]

const ISSUE_FIELD: Partial<Record<IssueKey, keyof Product>> = {
  dup_sku: 'sku', no_image: 'image_url', no_barcode: 'barcode', no_price: 'price',
  zero_price: 'price', no_name_ar: 'name_ar', no_category: 'main_category', no_snoonu: 'snoonu_id', no_rafeeq: 'rafeeq_product_id',
}

const BULK_ACTION: Partial<Record<IssueKey, string>> = {
  not_approved: 'اعتماد المحدد', no_barcode: 'توليد باركود للمحدد', price_mismatch: 'مطابقة أسعار المنصّات للمحدد',
  no_snoonu: 'ربط سريع بالـSKU', no_rafeeq: 'ربط سريع بالـSKU', no_channel_link: 'ربط بكل المنصّات (SKU)',
}

// المشاكل اللي فيها إصلاح سريع (حقل واحد) داخل القائمة بدون فتح النافذة
const QUICK_FIELD: Partial<Record<IssueKey, 'image_url' | 'price'>> = {
  no_image: 'image_url', zero_price: 'price', no_price: 'price',
}

const emptyToNull = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim())

function genEan13(): string {
  let d = ''
  for (let i = 0; i < 12; i++) d += Math.floor(Math.random() * 10)
  let sum = 0
  for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(d[i])
  const check = (10 - (sum % 10)) % 10
  return d + check
}

// ---------- المكوّن ----------
export default function CatalogHealthPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [variants, setVariants] = useState<Variant[]>([])
  const [channelProducts, setChannelProducts] = useState<ChannelProduct[]>([])
  const [channelNames, setChannelNames] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeIssue, setActiveIssue] = useState<IssueKey | null>(null)
  const [search, setSearch] = useState('')

  const [fixProduct, setFixProduct] = useState<Product | null>(null)
  const [form, setForm] = useState<Partial<Product>>({})
  const [variantForm, setVariantForm] = useState<{ id: string; name: string; barcode: string }[]>([])
  const [approved, setApproved] = useState(false)
  const [syncChannels, setSyncChannels] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkErr, setBulkErr] = useState<string | null>(null)

  // إصلاح سريع من القائمة (صورة/سعر)
  const [quickVal, setQuickVal] = useState<Record<string, string>>({})
  const [quickBusy, setQuickBusy] = useState<string | null>(null)
  const [imgBusy, setImgBusy] = useState<string | null>(null)

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true)
    setError(null)
    try {
      const supabase = createClient()
      const all: Product[] = []
      const PAGE = 1000
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase.from('products')
          .select('id, sku, barcode, name_ar, name_en, image_url, price, discount_price, snoonu_id, rafeeq_product_id, main_category, approval')
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (!data || data.length === 0) break
        all.push(...(data as Product[]))
        if (data.length < PAGE) break
      }
      const cp: ChannelProduct[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error: cpErr } = await supabase.from('channel_products')
          .select('product_id, channel_id, channel_price, channel_status').range(from, from + PAGE - 1)
        if (cpErr) throw cpErr
        if (!data || data.length === 0) break
        cp.push(...(data as ChannelProduct[]))
        if (data.length < PAGE) break
      }
      const vrows: Variant[] = []
      try {
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase.from('product_variants')
            .select('id, parent_product_id, variant_name, barcode, price').range(from, from + PAGE - 1)
          if (error) break
          if (!data || data.length === 0) break
          vrows.push(...(data as any[]))
          if (data.length < PAGE) break
        }
      } catch { /* variants optional */ }
      const nameMap = new Map<string, string>()
      try {
        const { data: ch } = await supabase.from('channels').select('id, name')
        for (const c of (ch as { id: string; name: string | null }[]) || []) {
          if (c?.id != null) nameMap.set(String(c.id), c.name ?? String(c.id))
        }
      } catch { /* fallback */ }
      setProducts(all); setVariants(vrows); setChannelProducts(cp); setChannelNames(nameMap); setLastUpdated(new Date())
    } catch (e: any) {
      setError(e?.message || 'فشل تحميل البيانات')
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const ctx: Ctx = useMemo(() => {
    const skuCount = new Map<string, number>()
    for (const p of products) if (p.sku) skuCount.set(p.sku, (skuCount.get(p.sku) || 0) + 1)
    const dupSkus = new Set<string>()
    skuCount.forEach((n, sku) => { if (n > 1) dupSkus.add(sku) })
    const cpByProduct = new Map<string, ChannelProduct[]>()
    for (const cp of channelProducts) {
      const arr = cpByProduct.get(cp.product_id) || []
      arr.push(cp); cpByProduct.set(cp.product_id, arr)
    }
    const variantStats = new Map<string, { total: number; withBc: number }>()
    const pricedByProduct = new Map<string, PricedVariant[]>()
    for (const v of variants) {
      if (!v.parent_product_id) continue
      const s = variantStats.get(v.parent_product_id) || { total: 0, withBc: 0 }
      s.total += 1
      if (v.barcode && String(v.barcode).trim() !== '') s.withBc += 1
      variantStats.set(v.parent_product_id, s)
      const arr = pricedByProduct.get(v.parent_product_id) || []
      arr.push({ price: v.price })
      pricedByProduct.set(v.parent_product_id, arr)
    }
    const priceByProduct = new Map<string, EffectivePrice>()
    for (const p of products) priceByProduct.set(p.id, effectivePrice(p.price, p.discount_price, pricedByProduct.get(p.id)))
    return { dupSkus, cpByProduct, variantStats, priceByProduct }
  }, [products, channelProducts, variants])

  const counts = useMemo(() => {
    const m = new Map<IssueKey, Product[]>()
    for (const def of ISSUES) m.set(def.key, [])
    for (const p of products) for (const def of ISSUES) if (def.test(p, ctx)) m.get(def.key)!.push(p)
    return m
  }, [products, ctx])

  const healthScore = useMemo(() => {
    if (products.length === 0) return 100
    const critKeys = ISSUES.filter((i) => i.severity === 'critical').map((i) => i.key)
    const dirty = new Set<string>()
    for (const k of critKeys) for (const p of counts.get(k) || []) dirty.add(p.id)
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

  const variantBcByProduct = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const v of variants) {
      if (!v.parent_product_id || !v.barcode) continue
      const bc = String(v.barcode).trim().toLowerCase()
      if (!bc) continue
      const arr = m.get(v.parent_product_id) || []
      arr.push(bc); m.set(v.parent_product_id, arr)
    }
    return m
  }, [variants])

  const activeList = useMemo(() => {
    if (!activeIssue) return []
    let list = counts.get(activeIssue) || []
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter((p) =>
        (p.sku || '').toLowerCase().includes(q) || (p.name_ar || '').toLowerCase().includes(q) ||
        (p.name_en || '').toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q) ||
        (variantBcByProduct.get(p.id) || []).some((b) => b.includes(q)))
    }
    return list
  }, [activeIssue, counts, search, variantBcByProduct])

  const mismatchRows = (p: Product) => {
    if (p.price === null) return []
    const cps = ctx.cpByProduct.get(p.id) || []
    return cps.filter((cp) => cp.channel_price !== null && Math.abs((cp.channel_price as number) - (p.price as number)) > 0.001)
      .map((cp) => {
        const delta = Math.round(((cp.channel_price as number) - (p.price as number)) * 100) / 100
        return { name: channelNames.get(String(cp.channel_id)) || String(cp.channel_id), system: p.price as number, channel: cp.channel_price as number, delta }
      })
  }

  const openFix = (p: Product) => {
    setFixProduct(p)
    setForm({
      sku: p.sku ?? '', name_ar: p.name_ar ?? '', name_en: p.name_en ?? '', price: p.price, barcode: p.barcode ?? '',
      main_category: p.main_category ?? '', image_url: p.image_url ?? '', snoonu_id: p.snoonu_id ?? '', rafeeq_product_id: p.rafeeq_product_id ?? '',
    } as Partial<Product>)
    setVariantForm(variants.filter((v) => v.parent_product_id === p.id).map((v) => ({ id: v.id, name: v.variant_name ?? '', barcode: v.barcode ?? '' })))
    setApproved(p.approval === 'Approved')
    setSyncChannels(activeIssue === 'price_mismatch')
    setSaveErr(null)
  }

  const genVariantBarcodes = () => {
    setForm((f) => {
      const base = emptyToNull(f.barcode) ? String(f.barcode).trim() : genEan13()
      setVariantForm((vf) => vf.map((v, i) => ({ ...v, barcode: `${base}-${i + 1}` })))
      return { ...f, barcode: base }
    })
  }

  // إصلاح سريع لحقل واحد من القائمة (صورة أو سعر)
  const quickSave = async (p: Product, field: 'image_url' | 'price') => {
    const raw = quickVal[p.id] ?? ''
    setQuickBusy(p.id); setBulkErr(null)
    try {
      const supabase = createClient()
      const value = field === 'price' ? (raw.trim() === '' ? null : Number(raw)) : (raw.trim() === '' ? null : raw.trim())
      if (field === 'price' && value !== null && (isNaN(value as number) || (value as number) <= 0)) throw new Error('أدخل سعرًا صحيحًا أكبر من صفر')
      if (field === 'image_url' && value !== null && !/^https?:\/\//i.test(String(value))) throw new Error('رابط صورة غير صالح (لازم يبدأ بـhttp)')
      const { error } = await supabase.from('products').update({ [field]: value }).eq('id', p.id)
      if (error) throw error
      setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, [field]: value } : x)))
      setQuickVal((s) => { const n = { ...s }; delete n[p.id]; return n })
      setLastUpdated(new Date())
    } catch (e: any) {
      setBulkErr(e?.message || 'فشل الحفظ')
    } finally {
      setQuickBusy(null)
    }
  }

  // رفع صورة من الجهاز → يخزّنها ويعيّنها كصورة رئيسية للمنتج مباشرة.
  const uploadDeviceImage = async (productId: string, file: File, onDone?: (url: string) => void) => {
    setImgBusy(productId); setBulkErr(null); setSaveErr(null)
    try {
      const fd = new FormData()
      fd.set('file', file)
      fd.set('productId', productId)
      const r: any = await uploadProductImage(fd)
      if (r?.error) throw new Error(r.error)
      const url = String(r?.url || '')
      setProducts((prev) => prev.map((x) => (x.id === productId ? { ...x, image_url: url } : x)))
      setLastUpdated(new Date())
      onDone?.(url)
    } catch (e: any) {
      const msg = e?.message || 'فشل رفع الصورة'
      setBulkErr(msg); setSaveErr(msg)
    } finally {
      setImgBusy(null)
    }
  }

  const saveFix = async () => {
    if (!fixProduct) return
    setSaving(true); setSaveErr(null)
    try {
      const rawPrice = form.price as unknown
      const price = rawPrice === undefined || rawPrice === null || String(rawPrice).trim() === '' ? null : Number(rawPrice)
      const patch = {
        sku: emptyToNull(form.sku), name_ar: emptyToNull(form.name_ar), name_en: emptyToNull(form.name_en), price,
        barcode: emptyToNull(form.barcode), main_category: emptyToNull(form.main_category), image_url: emptyToNull(form.image_url),
        snoonu_id: emptyToNull(form.snoonu_id), rafeeq_product_id: emptyToNull(form.rafeeq_product_id),
        approval: approved ? 'Approved' : fixProduct.approval === 'Approved' ? null : fixProduct.approval,
      }
      const supabase = createClient()
      const { error } = await supabase.from('products').update(patch).eq('id', fixProduct.id)
      if (error) throw error
      const hasNewVariant = variantForm.some((v) => !v.id)
      if (variantForm.length) {
        const res = await upsertVariants(fixProduct.id, variantForm.map((v) => ({ id: v.id || null, variant_name: v.name, barcode: emptyToNull(v.barcode) })))
        if (res && 'error' in res && res.error) throw new Error(res.error)
      }
      if (syncChannels && price !== null) {
        const rows = (ctx.cpByProduct.get(fixProduct.id) || []).filter((cp) => cp.channel_price !== null && Math.abs((cp.channel_price as number) - price) > 0.001)
        for (const cp of rows) {
          const { error: cErr } = await supabase.from('channel_products').update({ channel_price: price }).eq('product_id', fixProduct.id).eq('channel_id', cp.channel_id)
          if (cErr) throw cErr
        }
        setChannelProducts((prev) => prev.map((cp) => (cp.product_id === fixProduct.id && cp.channel_price !== null ? { ...cp, channel_price: price } : cp)))
      }
      setProducts((prev) => prev.map((x) => (x.id === fixProduct.id ? { ...x, ...patch } : x)))
      if (variantForm.length) {
        const bcById = new Map(variantForm.map((v) => [v.id, emptyToNull(v.barcode)]))
        setVariants((prev) => prev.map((v) => (bcById.has(v.id) ? { ...v, barcode: bcById.get(v.id) ?? null } : v)))
      }
      setLastUpdated(new Date()); setFixProduct(null)
      if (hasNewVariant) load(true)
    } catch (e: any) {
      setSaveErr(e?.message || 'فشل الحفظ')
    } finally {
      setSaving(false)
    }
  }

  const runBulk = async () => {
    if (!activeIssue || selected.size === 0) return
    setBulkBusy(true); setBulkErr(null)
    try {
      const supabase = createClient()
      const ids = [...selected]
      if (activeIssue === 'not_approved') {
        for (let i = 0; i < ids.length; i += 200) {
          const { error } = await supabase.from('products').update({ approval: 'Approved' }).in('id', ids.slice(i, i + 200))
          if (error) throw error
        }
        setProducts((prev) => prev.map((p) => (selected.has(p.id) ? { ...p, approval: 'Approved' } : p)))
      } else if (activeIssue === 'no_barcode') {
        const prodPatch = new Map<string, string>()
        const varPatch: { id: string; barcode: string }[] = []
        for (const id of ids) {
          const p = products.find((x) => x.id === id)
          if (!p) continue
          const vs = variants.filter((v) => v.parent_product_id === id)
          if (vs.length > 0) {
            const has = p.barcode && p.barcode.trim() !== ''
            const base = has ? (p.barcode as string).trim() : genEan13()
            if (!has) prodPatch.set(id, base)
            vs.forEach((v, i) => { if (!(v.barcode && String(v.barcode).trim() !== '')) varPatch.push({ id: v.id, barcode: `${base}-${i + 1}` }) })
          } else if (!(p.barcode && p.barcode.trim() !== '')) {
            prodPatch.set(id, genEan13())
          }
        }
        for (const [id, bc] of prodPatch) {
          const { error } = await supabase.from('products').update({ barcode: bc }).eq('id', id)
          if (error) throw error
        }
        if (varPatch.length) {
          const res = await setVariantBarcodes(varPatch)
          if (res && 'error' in res && res.error) throw new Error(res.error)
        }
        setProducts((prev) => prev.map((p) => (prodPatch.has(p.id) ? { ...p, barcode: prodPatch.get(p.id)! } : p)))
        const vb = new Map(varPatch.map((v) => [v.id, v.barcode]))
        setVariants((prev) => prev.map((v) => (vb.has(v.id) ? { ...v, barcode: vb.get(v.id)! } : v)))
      } else if (activeIssue === 'price_mismatch') {
        for (const id of ids) {
          const p = products.find((x) => x.id === id)
          if (!p || p.price === null) continue
          const rows = (ctx.cpByProduct.get(id) || []).filter((cp) => cp.channel_price !== null && Math.abs((cp.channel_price as number) - (p.price as number)) > 0.001)
          for (const cp of rows) {
            const { error } = await supabase.from('channel_products').update({ channel_price: p.price }).eq('product_id', id).eq('channel_id', cp.channel_id)
            if (error) throw error
          }
        }
        setChannelProducts((prev) => prev.map((cp) => {
          if (!selected.has(cp.product_id) || cp.channel_price === null) return cp
          const p = products.find((x) => x.id === cp.product_id)
          return p && p.price !== null ? { ...cp, channel_price: p.price } : cp
        }))
      } else if (activeIssue === 'no_snoonu' || activeIssue === 'no_rafeeq' || activeIssue === 'no_channel_link') {
        const patches = new Map<string, Partial<Product>>()
        const skipped: string[] = []
        for (const id of ids) {
          const p = products.find((x) => x.id === id)
          if (!p) continue
          if (!p.sku || p.sku.trim() === '') { skipped.push(id); continue }
          const patch: Partial<Product> = {}
          const wantSnoonu = activeIssue === 'no_snoonu' || activeIssue === 'no_channel_link'
          const wantRafeeq = activeIssue === 'no_rafeeq' || activeIssue === 'no_channel_link'
          if (wantSnoonu && (!p.snoonu_id || p.snoonu_id.trim() === '')) patch.snoonu_id = p.sku
          if (wantRafeeq && (!p.rafeeq_product_id || String(p.rafeeq_product_id).trim() === '')) patch.rafeeq_product_id = p.sku
          if (Object.keys(patch).length) patches.set(id, patch)
        }
        for (const [id, patch] of patches) {
          const { error } = await supabase.from('products').update(patch).eq('id', id)
          if (error) throw error
        }
        setProducts((prev) => prev.map((p) => (patches.has(p.id) ? { ...p, ...patches.get(p.id) } : p)))
        if (skipped.length) setBulkErr(`تم تخطّي ${skipped.length} منتج بدون SKU — لا يمكن ربطها تلقائيًا`)
      }
      setLastUpdated(new Date()); setSelected(new Set())
    } catch (e: any) {
      setBulkErr(e?.message || 'فشل الإجراء الجماعي')
    } finally {
      setBulkBusy(false)
    }
  }

  // ---------- العرض ----------
  if (loading) return <div dir="rtl" className="grid min-h-[50vh] place-items-center text-muted">جارٍ فحص الكتالوج…</div>
  if (error) return (
    <div dir="rtl" className="grid min-h-[50vh] place-items-center text-center">
      <div><p className="font-semibold text-red-600">تعذّر تحميل البيانات</p><p className="mt-2 text-sm text-muted">{error}</p></div>
    </div>
  )

  const scoreColor = healthScore >= 95 ? 'text-green-600' : healthScore >= 80 ? 'text-amber-600' : 'text-red-600'
  const ringColor = healthScore >= 95 ? '#16a34a' : healthScore >= 80 ? '#d97706' : '#dc2626'
  const activeDef = ISSUES.find((i) => i.key === activeIssue)
  const quickField = activeIssue ? QUICK_FIELD[activeIssue] : undefined

  return (
    <div dir="rtl" className="mx-auto max-w-5xl space-y-5">
      {/* الهيدر */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-ink">صحّة الكتالوج</h1>
          <p className="mt-1 text-sm text-muted">{products.length.toLocaleString('ar')} منتج · فحص لحظي · <span className="text-emerald-700">افحص وصحّح من هنا</span></p>
          <div className="mt-2 flex items-center gap-2.5">
            <button onClick={() => load(true)} disabled={loading || refreshing} className="btn-ghost px-3 py-1.5 text-sm disabled:opacity-60">
              {refreshing ? 'جارٍ التحديث…' : '↻ تحديث'}
            </button>
            {lastUpdated && <span className="text-xs text-slate-400">آخر تحديث: {lastUpdated.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
          </div>
        </div>
        <div className="flex items-center gap-3.5">
          <div className="relative grid h-20 w-20 place-items-center rounded-full border-[5px]" style={{ borderColor: ringColor }}>
            <span className={`text-3xl font-extrabold leading-none ${scoreColor} tabular-nums`}>{healthScore}</span>
            <span className="absolute bottom-3.5 text-xs text-slate-400">%</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-sm text-slate-400">نظيف</span>
            <span className={`text-sm ${criticalTotal ? 'text-red-600' : 'text-green-600'}`}>{criticalTotal ? `${criticalTotal} منتج فيه مشكلة حرجة` : 'جاهز للأتمتة ✓'}</span>
          </div>
        </div>
      </header>

      {/* شريط البوابة */}
      <div className={`flex items-center gap-2.5 rounded-xl border px-4 py-3 ${criticalTotal ? 'border-red-200 bg-red-50' : 'border-green-200 bg-green-50'}`}>
        <span className="text-lg" aria-hidden="true">{criticalTotal ? '🚦' : '✅'}</span>
        <span className={`font-semibold ${criticalTotal ? 'text-red-800' : 'text-green-800'}`}>
          {criticalTotal ? 'بوابة الأتمتة مقفلة — لازم تُحل المشاكل الحرجة أول' : 'بوابة الأتمتة مفتوحة — الكتالوج نظيف 100%'}
        </span>
      </div>

      {/* بطاقات المشاكل */}
      <section className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {ISSUES.map((def) => {
          const n = (counts.get(def.key) || []).length
          const isActive = activeIssue === def.key
          const isCrit = def.severity === 'critical'
          return (
            <button key={def.key} type="button" aria-pressed={isActive}
              onClick={() => { setActiveIssue(isActive ? null : def.key); setSearch(''); setSelected(new Set()); setBulkErr(null) }}
              className={`flex flex-col gap-1.5 rounded-2xl border p-4 text-right transition ${isActive ? 'border-slate-900 ring-2 ring-slate-900' : n === 0 ? 'border-slate-200 bg-white' : isCrit ? 'border-red-200 bg-red-50/50' : 'border-amber-200 bg-amber-50/50'}`}>
              <div className="flex items-center justify-between">
                <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${n === 0 ? 'bg-green-100 text-green-700' : isCrit ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>{isCrit ? 'حرج' : 'تنبيه'}</span>
                <span className={`text-2xl font-extrabold tabular-nums ${n === 0 ? 'text-green-600' : isCrit ? 'text-red-600' : 'text-amber-600'}`}>{n === 0 ? '✓' : n}</span>
              </div>
              <h3 className="text-[15px] font-bold text-ink">{def.label}</h3>
              <p className="text-xs leading-relaxed text-muted">{def.desc}</p>
            </button>
          )
        })}
      </section>

      {/* قائمة المنتجات المتأثرة */}
      {activeIssue && (
        <section className="overflow-hidden rounded-2xl border border-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 p-4">
            <h2 className="flex items-center gap-2.5 text-lg font-bold text-ink">
              {activeDef?.label}
              <span className="rounded-full bg-slate-900 px-2.5 py-0.5 text-[13px] font-bold text-white tabular-nums">{activeList.length}</span>
            </h2>
            <input value={search} onChange={(e) => setSearch(e.target.value)} aria-label="بحث في المنتجات المتأثرة" type="search"
              placeholder="بحث بالـSKU أو الاسم أو الباركود…" className="input min-w-52 text-sm" />
          </div>

          {activeList.length === 0 ? (
            <p className="p-8 text-center font-semibold text-green-600">ما فيه منتجات بهذه المشكلة 🎉</p>
          ) : (
            <div className="overflow-x-auto">
              {/* شريط الإجراء الجماعي */}
              {(() => {
                const bulkLabel = BULK_ACTION[activeIssue]
                if (!bulkLabel) return null
                const allSelected = activeList.length > 0 && activeList.every((p) => selected.has(p.id))
                return (
                  <div className="flex flex-wrap items-center gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3">
                    <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-ink">
                      <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(activeList.map((p) => p.id)))} className="h-4 w-4" />
                      تحديد الكل ({activeList.length})
                    </label>
                    <span className="text-sm text-muted">محدد: {selected.size}</span>
                    <button type="button" onClick={runBulk} disabled={bulkBusy || selected.size === 0} className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50">{bulkBusy ? 'جارٍ التنفيذ…' : bulkLabel}</button>
                    {bulkErr && <span className="text-sm font-semibold text-red-600">{bulkErr}</span>}
                  </div>
                )
              })()}
              {quickField && bulkErr && !BULK_ACTION[activeIssue] ? (
                <div className="border-b border-slate-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-600">{bulkErr}</div>
              ) : null}

              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-right text-xs font-bold text-muted">
                    {BULK_ACTION[activeIssue] && <th className="px-4 py-2.5"></th>}
                    <th className="px-4 py-2.5">صورة</th>
                    <th className="px-4 py-2.5">SKU</th>
                    <th className="px-4 py-2.5">الاسم</th>
                    <th className="px-4 py-2.5">السعر</th>
                    <th className="px-4 py-2.5">التصنيف</th>
                    <th className="px-4 py-2.5">{quickField ? 'إصلاح سريع' : ''}</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {activeList.slice(0, 200).map((p) => (
                    <tr key={p.id} className="border-b border-slate-100">
                      {BULK_ACTION[activeIssue] && (
                        <td className="px-4 py-2.5">
                          <input type="checkbox" checked={selected.has(p.id)} aria-label={`تحديد ${p.name_ar || p.sku || 'منتج'}`}
                            onChange={() => setSelected((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n })} className="h-4 w-4" />
                        </td>
                      )}
                      <td className="px-4 py-2.5">
                        <div className="h-11 w-11 overflow-hidden rounded-md bg-slate-100 ring-1 ring-slate-200">
                          {p.image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={p.image_url} alt="" width={44} height={44} loading="lazy" className="h-full w-full object-cover" />
                          ) : <div className="grid h-full w-full place-items-center text-slate-300">📦</div>}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono" dir="ltr">{p.sku || '—'}</td>
                      <td className="px-4 py-2.5">
                        <div className="text-ink">{p.name_ar || '—'}</div>
                        {p.name_en && <div className="text-right text-xs text-muted" dir="ltr">{p.name_en}</div>}
                        {activeIssue === 'price_mismatch' && (
                          <div className="mt-1 flex flex-col gap-0.5">
                            {mismatchRows(p).map((m, i) => (
                              <span key={i} className="text-xs text-slate-500">{m.name}: النظام {m.system} · المنصّة {m.channel} <span className={`font-bold ${m.delta > 0 ? 'text-red-600' : 'text-amber-600'}`}>({m.delta > 0 ? '+' : ''}{m.delta})</span></span>
                            ))}
                          </div>
                        )}
                        {activeIssue === 'no_barcode' && (() => {
                          const vs = ctx.variantStats.get(p.id)
                          if (vs && vs.total > 0) return <div className="mt-1 text-xs font-bold text-amber-800">ناقص باركود: {vs.total - vs.withBc} من {vs.total} خيار</div>
                          return <div className="mt-1 text-xs text-amber-800">باركود المنتج فاضي</div>
                        })()}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {(() => {
                          const ep = ctx.priceByProduct.get(p.id)
                          if (ep?.fromVariants) return <span title="السعر من الخيارات">{priceRangeLabel(ep, (n) => String(n))} <span className="text-[10px] text-violet-700">🎚️ خيارات</span></span>
                          return p.price ?? '—'
                        })()}
                      </td>
                      <td className="px-4 py-2.5">{p.main_category || '—'}</td>
                      <td className="px-4 py-2.5">
                        {quickField === 'image_url' ? (
                          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-bold text-white">
                            {imgBusy === p.id ? '⏳ جارٍ الرفع…' : '📷 رفع صورة من الجهاز'}
                            <input type="file" accept="image/*" className="hidden" disabled={imgBusy === p.id}
                              aria-label={`رفع صورة ${p.name_ar || p.sku || ''}`}
                              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadDeviceImage(p.id, f); e.currentTarget.value = '' }} />
                          </label>
                        ) : quickField === 'price' ? (
                          <div className="flex items-center gap-1.5">
                            <input type="number" value={quickVal[p.id] ?? ''}
                              onChange={(e) => setQuickVal((s) => ({ ...s, [p.id]: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === 'Enter') quickSave(p, 'price') }}
                              aria-label={`سعر ${p.name_ar || p.sku || ''}`} placeholder="السعر"
                              dir="ltr" className="input w-24 py-1 text-xs" />
                            <button type="button" onClick={() => quickSave(p, 'price')} disabled={quickBusy === p.id || !(quickVal[p.id] ?? '').trim()}
                              className="btn-primary px-2.5 py-1 text-xs disabled:opacity-40">{quickBusy === p.id ? '…' : 'حفظ'}</button>
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        <button type="button" onClick={() => openFix(p)} className="text-sm font-semibold text-brand hover:underline">تصحيح ←</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {activeList.length > 200 && <p className="p-3 text-center text-sm text-slate-400">+{activeList.length - 200} منتج إضافي — استخدم البحث للتصفية</p>}
            </div>
          )}
        </section>
      )}

      {!activeIssue && <p className="text-center text-sm text-slate-400">اضغط أي بطاقة لعرض المنتجات المتأثرة وتصحيحها</p>}

      {/* نافذة التصحيح */}
      {fixProduct && (
        <div role="dialog" aria-modal="true" aria-label="تصحيح المنتج" onClick={() => !saving && setFixProduct(null)}
          className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4">
          <div onClick={(e) => e.stopPropagation()} className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4">
              <div>
                <h3 className="text-lg font-extrabold text-ink">تصحيح المنتج</h3>
                <span className="mt-0.5 inline-block font-mono text-[13px] text-muted" dir="ltr">{fixProduct.sku || '—'}</span>
              </div>
              <button type="button" onClick={() => !saving && setFixProduct(null)} aria-label="إغلاق" className="text-lg leading-none text-muted hover:text-ink">✕</button>
            </div>

            <div className="flex flex-col gap-1 overflow-y-auto p-5">
              {(() => {
                const focusField = activeIssue ? ISSUE_FIELD[activeIssue] : undefined
                const variant = ctx.variantStats.get(fixProduct.id)
                const hasVariants = !!variant && variant.total > 0
                const cls = (k: keyof Product) => `input mt-1 w-full ${focusField === k ? 'ring-2 ring-blue-300 border-blue-500' : ''}`
                const set = (k: keyof Product, v: any) => setForm((f) => ({ ...f, [k]: v }))
                const Label = ({ id, children }: { id: string; children: React.ReactNode }) => <label htmlFor={id} className="mt-2.5 block text-xs font-bold text-slate-600">{children}</label>
                return (
                  <>
                    <Label id="f-sku">SKU</Label>
                    <input id="f-sku" className={cls('sku')} value={(form.sku as string) ?? ''} onChange={(e) => set('sku', e.target.value)} dir="ltr" />
                    <Label id="f-ar">الاسم العربي</Label>
                    <input id="f-ar" className={cls('name_ar')} value={(form.name_ar as string) ?? ''} onChange={(e) => set('name_ar', e.target.value)} dir="rtl" />
                    <Label id="f-en">الاسم الإنجليزي</Label>
                    <input id="f-en" className={cls('name_en')} value={(form.name_en as string) ?? ''} onChange={(e) => set('name_en', e.target.value)} dir="ltr" />
                    <Label id="f-price">السعر</Label>
                    <input id="f-price" className={cls('price')} type="number" value={(form.price as number) ?? ''} onChange={(e) => set('price', e.target.value)} dir="ltr" />
                    <Label id="f-bc">الباركود</Label>
                    <div className="mt-1 flex gap-2">
                      <input id="f-bc" className={`${cls('barcode')} mt-0 flex-1`} value={(form.barcode as string) ?? ''} onChange={(e) => set('barcode', e.target.value)} dir="ltr" />
                      <button type="button" className="btn-ghost whitespace-nowrap px-3 text-xs" onClick={() => set('barcode', genEan13())}>توليد EAN-13</button>
                    </div>
                    {hasVariants && (
                      <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[13px] font-bold">باركود الخيارات ({variantForm.filter((v) => v.barcode.trim()).length}/{variantForm.length})</span>
                          <button type="button" className="btn-ghost px-3 text-xs" onClick={genVariantBarcodes}>توليد من الرئيسي (-1، -2…)</button>
                        </div>
                        <p className="my-2 text-[11px] leading-relaxed text-amber-800">كل خيار ياخذ نفس الباركود الرئيسي بلاحقة تسلسلية. لازم تحفظ ليُعتبر المنتج مكتمل.</p>
                        {variantForm.map((v, i) => (
                          <div key={v.id || `new-${i}`} className="mt-1.5 flex items-center gap-2">
                            <input className="input w-28 py-1.5" value={v.name} onChange={(e) => setVariantForm((vf) => vf.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} dir="rtl" placeholder={`خيار ${i + 1}`} aria-label={`اسم الخيار ${i + 1}`} />
                            <input className="input flex-1 py-1.5" value={v.barcode} onChange={(e) => setVariantForm((vf) => vf.map((x, j) => (j === i ? { ...x, barcode: e.target.value } : x)))} dir="ltr" placeholder="باركود الخيار" aria-label={`باركود الخيار ${i + 1}`} />
                            {!v.id && <button type="button" onClick={() => setVariantForm((vf) => vf.filter((_, j) => j !== i))} className="btn-ghost px-2 text-red-600" aria-label="حذف الخيار الجديد">✕</button>}
                          </div>
                        ))}
                        <button type="button" onClick={() => setVariantForm((vf) => [...vf, { id: '', name: '', barcode: '' }])} className="btn-ghost mt-2 px-3 text-xs">+ إضافة خيار</button>
                      </div>
                    )}
                    <Label id="f-cat">التصنيف</Label>
                    <input id="f-cat" className={cls('main_category')} value={(form.main_category as string) ?? ''} onChange={(e) => set('main_category', e.target.value)} dir="rtl" />
                    <label className="mt-2.5 block text-xs font-bold text-slate-600">صورة المنتج</label>
                    <div className="mt-1 flex items-center gap-3">
                      <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-slate-100 ring-1 ring-slate-200">
                        {form.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={form.image_url as string} alt="" className="h-full w-full object-cover" />
                        ) : <div className="grid h-full w-full place-items-center text-2xl text-slate-300">📦</div>}
                      </div>
                      <div className="flex-1">
                        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-brand px-3 py-2 text-xs font-bold text-white">
                          {imgBusy === fixProduct.id ? '⏳ جارٍ الرفع…' : (form.image_url ? '📷 استبدال الصورة' : '📷 رفع صورة من الجهاز')}
                          <input type="file" accept="image/*" className="hidden" disabled={imgBusy === fixProduct.id}
                            aria-label="رفع صورة المنتج من الجهاز"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadDeviceImage(fixProduct.id, f, (url) => set('image_url', url)); e.currentTarget.value = '' }} />
                        </label>
                        <p className="mt-1 text-[11px] text-muted">تُرفع الصورة فورًا وتُعيّن للمنتج. JPG/PNG/WebP حتى 10 ميغا.</p>
                      </div>
                    </div>
                    <label htmlFor="f-img" className="mt-2.5 block text-[11px] font-semibold text-slate-400">أو الصق رابطًا (اختياري)</label>
                    <input id="f-img" className={cls('image_url')} value={(form.image_url as string) ?? ''} onChange={(e) => set('image_url', e.target.value)} dir="ltr" placeholder="https://…" />
                    <div className="flex gap-3">
                      <div className="flex-1"><Label id="f-sn">Snoonu ID</Label><input id="f-sn" className={cls('snoonu_id')} value={(form.snoonu_id as string) ?? ''} onChange={(e) => set('snoonu_id', e.target.value)} dir="ltr" /></div>
                      <div className="flex-1"><Label id="f-rf">Rafeeq ID</Label><input id="f-rf" className={cls('rafeeq_product_id')} value={(form.rafeeq_product_id as string) ?? ''} onChange={(e) => set('rafeeq_product_id', e.target.value)} dir="ltr" /></div>
                    </div>
                    {mismatchRows(fixProduct).length > 0 && (
                      <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
                        <span className="text-[13px] font-bold">فرق سعر بين المنصّات</span>
                        {mismatchRows(fixProduct).map((m, i) => (
                          <p key={i} className="mt-1.5 text-xs text-slate-500">{m.name}: النظام {m.system} · المنصّة {m.channel} <span className={`font-bold ${m.delta > 0 ? 'text-red-600' : 'text-amber-600'}`}>({m.delta > 0 ? '+' : ''}{m.delta})</span></p>
                        ))}
                        <label className="mt-2 flex cursor-pointer items-center gap-2 text-[13px] font-semibold"><input type="checkbox" checked={syncChannels} onChange={(e) => setSyncChannels(e.target.checked)} /> مطابقة أسعار المنصّات على سعر النظام عند الحفظ</label>
                      </div>
                    )}
                    <label className="mt-3 flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-ink"><input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} /> اعتماد المنتج (Approved)</label>
                  </>
                )
              })()}
              {saveErr && <p className="mt-3 text-sm font-semibold text-red-600">{saveErr}</p>}
            </div>

            <div className="flex justify-end gap-2.5 border-t border-slate-200 bg-slate-50 px-5 py-3.5">
              <button type="button" onClick={() => setFixProduct(null)} disabled={saving} className="btn-ghost px-4 py-2 text-sm">إلغاء</button>
              <button type="button" onClick={saveFix} disabled={saving} className="btn-primary px-5 py-2 text-sm disabled:opacity-60">{saving ? 'جارٍ الحفظ…' : 'حفظ'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
