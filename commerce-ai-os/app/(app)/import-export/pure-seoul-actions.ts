"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computePureSeoulIdMap, type CatalogNameRow } from "@/lib/pure-seoul-map-compute";

// Pure Seoul is an INDEPENDENT platform selling the same products as Malika. Its
// approval/rejection lives in the shared `platform_status` overlay (platform =
// 'pure_seoul') — writing here NEVER touches products.approval (Malika's master)
// nor any other platform. See app/(app)/platforms/actions.ts for the table DDL.
const PS = "pure_seoul";

// Upsert a Pure-Seoul-only approval/rejection for the given product ids. An
// empty approval clears the row's status; reason is stored as its own field.
export async function setPureSeoulApproval(ids: string[], approval: string, reason?: string) {
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return { error: "غير مسجّل الدخول.", updated: 0 };
  const list = (ids ?? []).filter(Boolean);
  if (list.length === 0) return { error: "ما في منتجات محدّدة.", updated: 0 };
  const sb = createClient();
  const now = new Date().toISOString();
  const rows = list.map((product_id) => ({
    product_id,
    platform: PS,
    approval: approval === "" ? null : approval,
    rejection_reason: reason !== undefined ? (reason.trim() || null) : null,
    updated_at: now,
  }));
  let updated = 0, failed = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await sb.from("platform_status").upsert(chunk, { onConflict: "product_id,platform" });
    if (error) failed += chunk.length; else updated += chunk.length;
  }
  revalidatePath("/import-export/pure-seoul");
  revalidatePath("/platforms/pure_seoul");
  return { ok: failed === 0, updated, failed };
}

// Convenience wrapper for the screenshot/paste reject tool on the Pure Seoul page.
export async function rejectPureSeoulProducts(ids: string[], reason: string) {
  return setPureSeoulApproval(ids, "Rejected", reason);
}

// Auto-fill availability into the system from a Pure Seoul upload. Hidden
// products = OutOfStock (مخلّصة), visible = InStock. Writes ONLY the
// `availability` column on platform_status (platform='pure_seoul'); approval/
// rejection are left untouched. Requires:
//   alter table platform_status add column if not exists availability text;
export async function applyPureSeoulAvailability(outIds: string[], inIds: string[]) {
  const sb = createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: "غير مسجّل الدخول.", outOfStock: 0, inStock: 0 };
  const now = new Date().toISOString();
  const mk = (ids: string[], availability: string) =>
    [...new Set((ids ?? []).filter(Boolean))].map((product_id) => ({ product_id, platform: PS, availability, updated_at: now }));
  const rows = [...mk(outIds, "OutOfStock"), ...mk(inIds, "InStock")];
  if (rows.length === 0) return { error: "ما في منتجات مطابقة لتطبيقها.", outOfStock: 0, inStock: 0 };
  let failed = 0, firstErr = "";
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await sb.from("platform_status").upsert(chunk, { onConflict: "product_id,platform" });
    if (error) { failed += chunk.length; if (!firstErr) firstErr = error.message; }
  }
  if (firstErr) {
    const hint = /availability/.test(firstErr)
      ? " — شغّل في Supabase: alter table platform_status add column if not exists availability text;"
      : "";
    return { error: firstErr + hint, outOfStock: 0, inStock: 0, failed };
  }
  revalidatePath("/platforms/pure_seoul");
  revalidatePath("/import-export/pure-seoul");
  return { ok: true, outOfStock: new Set(outIds.filter(Boolean)).size, inStock: new Set(inIds.filter(Boolean)).size, failed };
}

export interface PSRejected {
  id: string;
  sku: string | null;
  name_en: string | null;
  category: string | null;
  reason: string | null;
  updated_at: string | null;
}

// List products currently rejected on Pure Seoul (independent of Malika). Reads
// the standalone status table and joins the product's display fields.
export async function getPureSeoulRejected(): Promise<PSRejected[]> {
  const sb = createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return [];
  const { data, error } = await sb
    .from("platform_status")
    .select("product_id, rejection_reason, updated_at, products(sku, name_en, main_category)")
    .eq("platform", PS)
    .eq("approval", "Rejected")
    .order("updated_at", { ascending: false });
  if (error || !data) return [];
  return data.map((r: any) => ({
    id: r.product_id,
    sku: r.products?.sku ?? null,
    name_en: r.products?.name_en ?? null,
    category: r.products?.main_category ?? null,
    reason: r.rejection_reason ?? null,
    updated_at: r.updated_at ?? null,
  }));
}

// One parsed row from a Pure Seoul "NonFoodProducts" export.
export interface PSRow {
  id?: string;
  global_id?: string;
  name_en?: string;
  name_ar?: string;
  description_en?: string;
  description_ar?: string;
  price?: string;
  approval?: string;
  branchStatus?: string;
  stock?: string;          // "Stock for …" quantity, when the export has it
}

export interface PSItem {
  id?: string | null;                // matched master product id (for applying status)
  sku: string | null;
  name_en: string | null;
  price?: string | number | null;   // Malika price (correct)
  psPrice?: string | null;          // Pure Seoul price
  category?: string | null;
  psName?: string | null;           // closest Pure Seoul name (for review pairs)
  score?: number;                   // match confidence for review pairs
  psStock?: number | null;          // Pure Seoul stock quantity
}

export interface PSCompare {
  ok: boolean;
  error?: string;
  counts: {
    psRows: number;
    matched: number;
    missingOnPS: number;   // confident: in Malika, no match nor close name on PS → ADD
    reviewOnPS: number;    // a close PS name exists (likely same / size-variant) → review
    extraOnPS: number;
    priceDiffs: number;
    psRejected: number;
    psInactive: number;
    psInStock: number;     // present on PS with stock > 0
    psOutOfStock: number;  // present on PS but finished (stock <= 0) — مخلّصة
  };
  hasStock: boolean;       // whether the export carried an availability signal
  missingOnPS: PSItem[];   // confident missing
  reviewOnPS: PSItem[];    // needs human review (name/size variants)
  extraOnPS: PSItem[];
  priceDiffs: PSItem[];
  psInStock: PSItem[];     // موجودة ومتوفّرة
  psOutOfStock: PSItem[];  // مخلّصة (نافدة)
  // Full (uncapped) matched master ids for one-click "apply to system".
  applyOutIds: string[];   // matched + hidden → mark OutOfStock
  applyInIds: string[];    // matched + visible → mark InStock
}

const S = (v: unknown) => String(v ?? "").trim();
// Aggressive normalization for name matching: lowercase + keep only letters/
// digits (drops spaces, dashes, parens, apostrophes, units punctuation). This
// matches name variants like "Body Cream" = "BodyCream", "(100g)" = "100g"
// without hiding genuinely-missing products (it only matches when alnum-identical).
const norm = (s: unknown) => S(s).toLowerCase().replace(/[^a-z0-9]/g, "");// Token set that KEEPS numeric tokens (sizes/counts) even when short — numbers
// are the discriminator between "6 Color" and "10 Color". Words must be ≥3 chars.
const tokset = (s: unknown) => new Set(
  S(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 || /^[0-9]+$/.test(w))
);
// True when `a` is fully contained in `b` (same product, b just has extra
// size/qualifier words). Requires ≥3 shared tokens to avoid generic over-match,
// and — since tokset keeps numbers — guarantees a's sizes/counts all exist in b.
const isSubset = (a: Set<string>, b: Set<string>) => {
  if (a.size < 3) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
};
const jaccard = (a: Set<string>, b: Set<string>) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };
const numEq = (a: unknown, b: unknown) => {
  const x = Number(a), y = Number(b);
  if (isNaN(x) || isNaN(y)) return S(a) === S(b);
  return x === y;
};

// Compare a Pure Seoul export against the Malika master catalog. Read-only.
// Matches PS→Malika by global_id (= our snoonu_id) then by name_en.
export async function comparePureSeoul(rows: PSRow[]): Promise<PSCompare> {
  const empty: PSCompare = {
    ok: false,
    counts: { psRows: 0, matched: 0, missingOnPS: 0, reviewOnPS: 0, extraOnPS: 0, priceDiffs: 0, psRejected: 0, psInactive: 0, psInStock: 0, psOutOfStock: 0 },
    hasStock: false,
    missingOnPS: [], reviewOnPS: [], extraOnPS: [], priceDiffs: [], psInStock: [], psOutOfStock: [],
    applyOutIds: [], applyInIds: [],
  };
  if (!rows?.length) return { ...empty, error: "ما في صفوف في الملف." };

  try {
    const sb = createClient();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return { ...empty, error: "غير مسجّل الدخول." };

    const all: any[] = [];
    for (let f = 0; ; f += 1000) {
      const { data, error } = await sb.from("products")
        .select("id, snoonu_id, pure_seoul_id, sku, name_en, price, main_category").range(f, f + 999);
      if (error) {
        // Tolerate a catalog that hasn't run the pure_seoul_id migration yet.
        if (/pure_seoul_id/.test(error.message)) {
          const retry = await sb.from("products").select("id, snoonu_id, sku, name_en, price, main_category").range(f, f + 999);
          if (retry.error) return { ...empty, error: retry.error.message };
          all.push(...(retry.data ?? []));
          if ((retry.data ?? []).length < 1000) break;
          continue;
        }
        return { ...empty, error: error.message };
      }
      all.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }

    // Pure Seoul is a separate merchant, so its SPI lives in products.pure_seoul_id
    // (bridged by an earlier name-map). Match by that id first — exact and stable —
    // then fall back to name for anything not yet bridged.
    const byPsId = new Map<string, any>();
    for (const p of all) if (S(p.pure_seoul_id)) byPsId.set(S(p.pure_seoul_id), p);
    const byId = new Map<string, any>();
    for (const p of all) if (S(p.snoonu_id)) byId.set(S(p.snoonu_id), p);
    const byName = new Map<string, any>();
    for (const p of all) { const n = norm(p.name_en); if (n) byName.set(n, p); }

    const matchedMalika = new Set<any>();
    const extraOnPS: PSItem[] = [];
    const priceDiffs: PSItem[] = [];
    const psInStock: PSItem[] = [];
    const psOutOfStock: PSItem[] = [];
    const applyOutIds: string[] = [];
    const applyInIds: string[] = [];
    let matched = 0, psRejected = 0, psInactive = 0;
    // Pure Seoul has NO quantity system: a HIDDEN product (Availability = False /
    // branchStatus inactive) IS the out-of-stock (مخلّصة) signal. So classify by
    // availability, not by any stock number.
    const hasStock = rows.some((r) => { const b = S(r.branchStatus).toLowerCase(); return b === "active" || b === "inactive"; });

    for (const r of rows) {
      if (S(r.approval) === "Rejected") psRejected++;
      const bs = S(r.branchStatus).toLowerCase();
      if (bs === "inactive") psInactive++;
      const m = byPsId.get(S(r.global_id) || S(r.id)) || byId.get(S(r.global_id)) || byName.get(norm(r.name_en));
      if (m) {
        matched++;
        matchedMalika.add(m);
        if (!numEq(r.price, m.price)) {
          priceDiffs.push({ sku: m.sku ?? null, name_en: m.name_en ?? null, psPrice: S(r.price) || null, price: m.price ?? null });
        }
      } else {
        extraOnPS.push({ sku: null, name_en: S(r.name_en) || null, psPrice: S(r.price) || null });
      }
      // Present (موجودة) vs hidden = out of stock (مخلّصة).
      if (hasStock) {
        const item: PSItem = {
          id: m?.id ?? null,
          sku: m?.sku ?? null,
          name_en: S(r.name_en) || (m?.name_en ?? null),
          psPrice: S(r.price) || null,
        };
        if (bs === "inactive") { psOutOfStock.push(item); if (m?.id) applyOutIds.push(m.id); }
        else if (bs === "active") { psInStock.push(item); if (m?.id) applyInIds.push(m.id); }
      }
    }

    // Split the unmatched Malika products into "confident missing" (no close PS
    // name) vs "review" (a similar PS name exists — likely the same item or a
    // size/shade variant). Names alone can't be 100% (e.g. "6 Color" vs "10
    // Color"), so the review bucket is surfaced for a human to confirm.
    // Pre-compute PS token sets (numbers kept) for subset + similarity passes.
    const psTok = rows.map((r) => ({ t: tokset(r.name_en), n: S(r.name_en) })).filter((x) => x.t.size);
    const missingOnPS: PSItem[] = [];
    const reviewOnPS: PSItem[] = [];
    for (const p of all) {
      if (matchedMalika.has(p)) continue;
      const pt = tokset(p.name_en);
      // Subset auto-match: one name fully contains the other (extra size/qualifier
      // words only) AND all numeric tokens align → same product, count as matched.
      let sub = false;
      let best = 0, bn = "";
      if (pt.size) for (const x of psTok) {
        if (!sub && (isSubset(pt, x.t) || isSubset(x.t, pt))) { sub = true; bn = x.n; best = 1; break; }
        const s = jaccard(pt, x.t); if (s > best) { best = s; bn = x.n; }
      }
      if (sub) { matched++; matchedMalika.add(p); continue; }
      const base = { sku: p.sku ?? null, name_en: p.name_en ?? null, price: p.price ?? null, category: p.main_category ?? null };
      if (best >= 0.55) reviewOnPS.push({ ...base, psName: bn, score: Math.round(best * 100) / 100 });
      else missingOnPS.push(base);
    }
    reviewOnPS.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    return {
      ok: true,
      counts: {
        psRows: rows.length,
        matched,
        missingOnPS: missingOnPS.length,
        reviewOnPS: reviewOnPS.length,
        extraOnPS: extraOnPS.length,
        priceDiffs: priceDiffs.length,
        psRejected,
        psInactive,
        psInStock: psInStock.length,
        psOutOfStock: psOutOfStock.length,
      },
      hasStock,
      missingOnPS: missingOnPS.slice(0, 500),
      reviewOnPS: reviewOnPS.slice(0, 500),
      extraOnPS: extraOnPS.slice(0, 500),
      priceDiffs: priceDiffs.slice(0, 500),
      psInStock: psInStock.slice(0, 500),
      psOutOfStock: psOutOfStock.slice(0, 1000),
      applyOutIds,
      applyInIds,
    };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : "خطأ غير متوقع." };
  }
}

export interface PsIdMapResult {
  ok: boolean; error?: string;
  mapped: number;      // catalog products newly stamped with a pure_seoul_id
  alreadySet: number;  // already carried the same id
  unmatched: number;   // PS rows with no confident catalog match
  failed: number;      // write failures
}

// Persist Pure Seoul's SPI(UniqueIdentifier) onto the matching catalog product
// (products.pure_seoul_id), matched BY NAME (exact → subset → strong). Run once
// from a Pure Seoul export; afterwards comparePureSeoul/fills match by id exactly.
// Service-role write (the column is protected). Requires supabase/pure_seoul_id.sql.
export async function setPureSeoulIds(rows: PSRow[]): Promise<PsIdMapResult> {
  const base: PsIdMapResult = { ok: false, mapped: 0, alreadySet: 0, unmatched: 0, failed: 0 };
  if (!rows?.length) return { ...base, error: "ما في صفوف في الملف." };

  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return { ...base, error: "غير مسجّل الدخول." };

  let admin: ReturnType<typeof createAdminClient>;
  try { admin = createAdminClient(); }
  catch (e) { return { ...base, error: e instanceof Error ? e.message : "الخادم غير مهيأ." }; }

  // Read catalog names + existing pure_seoul_id (paged).
  const cat: CatalogNameRow[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await admin.from("products").select("id, name_en, name_ar, pure_seoul_id").range(f, f + 999);
    if (error) {
      if (/pure_seoul_id/.test(error.message)) return { ...base, error: "شغّل supabase/pure_seoul_id.sql في Supabase أول." };
      return { ...base, error: error.message };
    }
    cat.push(...((data ?? []) as CatalogNameRow[]));
    if ((data ?? []).length < 1000) break;
  }

  // Pure Seoul SPI = global_id when present (NonFoodProducts export), else id
  // (AllExportData "SPI(UniqueIdentifier)").
  const psRows = rows.map((r) => ({ spi: S(r.global_id) || S(r.id), nameEn: S(r.name_en), nameAr: S(r.name_ar) }));
  const { pairs, mapped, alreadySet, unmatched } = computePureSeoulIdMap(psRows, cat);

  // Write in concurrent chunks (one targeted update per product — never touches
  // any other column).
  let failed = 0;
  for (let i = 0; i < pairs.length; i += 80) {
    const part = pairs.slice(i, i + 80);
    const results = await Promise.all(
      part.map((p) => admin.from("products").update({ pure_seoul_id: p.pure_seoul_id }).eq("id", p.product_id)
        .then((r: any) => Boolean(r.error)))
    );
    failed += results.filter(Boolean).length;
  }

  revalidatePath("/import-export/pure-seoul");
  return { ok: failed === 0, mapped: mapped - failed, alreadySet, unmatched, failed };
}

export interface AddPsResult {
  ok: boolean; error?: string;
  added: number;    // new exclusive products created
  skipped: number;  // already in the catalog (name match) or already linked
  failed: number;
}

// Add Pure Seoul EXCLUSIVES to the catalog — products that don't confidently
// match any existing product by name (so they're genuinely not in Malika yet).
// Each new product gets an mk#### SKU + unique EAN-13 barcode (same scheme as the
// Snoonu sync) and carries pure_seoul_id = its Pure Seoul SPI (NOT snoonu_id,
// which stays empty until it's listed on Malika's own Snoonu). Service-role
// write. Requires supabase/pure_seoul_id.sql.
export async function addPureSeoulNewProducts(rows: PSRow[]): Promise<AddPsResult> {
  const base: AddPsResult = { ok: false, added: 0, skipped: 0, failed: 0 };
  if (!rows?.length) return { ...base, error: "ما في صفوف في الملف." };

  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return { ...base, error: "غير مسجّل الدخول." };

  let admin: ReturnType<typeof createAdminClient>;
  try { admin = createAdminClient(); }
  catch (e) { return { ...base, error: e instanceof Error ? e.message : "الخادم غير مهيأ." }; }

  // Read the catalog: name index + existing pure_seoul_ids + max mk# + barcodes.
  const cat: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await admin.from("products").select("id, name_en, name_ar, pure_seoul_id, sku, barcode").range(f, f + 999);
    if (error) {
      if (/pure_seoul_id/.test(error.message)) return { ...base, error: "شغّل supabase/pure_seoul_id.sql في Supabase أول." };
      return { ...base, error: error.message };
    }
    cat.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  const existingPsId = new Set<string>();
  const byName = new Map<string, boolean>();
  const catTok = cat.map((c) => ({ t: tokset(c.name_en) })).filter((x) => x.t.size);
  let maxMk = 0;
  const usedBarcodes = new Set<string>();
  for (const p of cat) {
    if (S(p.pure_seoul_id)) existingPsId.add(S(p.pure_seoul_id));
    for (const n of [norm(p.name_en), norm(p.name_ar)]) if (n) byName.set(n, true);
    const m = /^mk(\d+)$/i.exec(S(p.sku));
    if (m) maxMk = Math.max(maxMk, parseInt(m[1], 10));
    const bc = S(p.barcode); if (bc) usedBarcodes.add(bc);
  }

  const nextSku = () => `mk${++maxMk}`;
  const ean13Check = (d12: string) => {
    let sum = 0; for (let i = 0; i < 12; i++) sum += (+d12[i]) * (i % 2 === 0 ? 1 : 3);
    return String((10 - (sum % 10)) % 10);
  };
  let bcSeq = 1;
  const nextBarcode = () => {
    for (;;) { const b = "29" + String(bcSeq++).padStart(10, "0"); const bc = b + ean13Check(b); if (!usedBarcodes.has(bc)) { usedBarcodes.add(bc); return bc; } }
  };
  const cleanName = (v: unknown) => S(v).replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const num = (v: unknown) => { const t = S(v); if (t === "") return null; const n = Number(t); return isNaN(n) ? null : n; };

  // A PS row is a NEW exclusive when its SPI isn't already linked AND its name
  // doesn't confidently match any existing product (exact → subset → strong).
  const seen = new Set<string>();
  const toInsert: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const r of rows) {
    const spi = S(r.global_id) || S(r.id);
    if (!spi || seen.has(spi)) continue;
    seen.add(spi);
    if (existingPsId.has(spi)) { skipped++; continue; }
    const nn = norm(r.name_en) || norm(r.name_ar);
    if (nn && byName.has(nn)) { skipped++; continue; }
    const tt = tokset(r.name_en);
    let nameMatch = false;
    if (tt.size) for (const x of catTok) {
      if (isSubset(tt, x.t) || isSubset(x.t, tt) || jaccard(tt, x.t) >= 0.72) { nameMatch = true; break; }
    }
    if (nameMatch) { skipped++; continue; }
    toInsert.push({
      sku: nextSku(),
      barcode: nextBarcode(),
      pure_seoul_id: spi,
      name_en: cleanName(r.name_en),
      name_ar: cleanName(r.name_ar),
      description_en: S(r.description_en) || null,
      description_ar: S(r.description_ar) || null,
      price: num(r.price),
      main_category: "Uncategorized",
      notes: "Imported from Pure Seoul — exclusive; set category / image.",
    });
  }

  if (toInsert.length === 0) return { ok: true, added: 0, skipped, failed: 0 };

  let added = 0, failed = 0;
  const newIds: string[] = [];
  for (let i = 0; i < toInsert.length; i += 200) {
    const part = toInsert.slice(i, i + 200);
    const { data, error } = await admin.from("products").insert(part).select("id");
    if (error) { failed += part.length; continue; }
    added += data?.length ?? 0;
    for (const p of data ?? []) newIds.push(p.id);
  }
  // Seed inventory rows (stock 0) so they show on the Inventory page.
  for (let i = 0; i < newIds.length; i += 200) {
    const part = newIds.slice(i, i + 200).map((product_id) => ({ product_id, stock_quantity: 0, low_stock_threshold: 5, sold_quantity: 0 }));
    await admin.from("inventory").insert(part);
  }

  revalidatePath("/products");
  revalidatePath("/import-export/pure-seoul");
  return { ok: failed === 0, added, skipped, failed };
}
