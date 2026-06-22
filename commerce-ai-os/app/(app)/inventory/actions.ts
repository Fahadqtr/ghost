"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import Anthropic from "@anthropic-ai/sdk";

function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

// Prefer the service-role client (bypasses RLS); fall back to the request-scoped
// RLS client when SUPABASE_SERVICE_ROLE_KEY isn't configured (e.g. a preview
// deployment). Reads and inventory writes work under RLS for a signed-in user.
function writableClient(): any {
  try {
    return createAdminClient();
  } catch {
    return createClient();
  }
}

/** Single-row inline save (kept for backward compatibility). */
export async function updateInventory(
  id: string,
  values: { stock_quantity: string; low_stock_threshold: string }
) {
  const supabase = createClient();
  const { error } = await supabase
    .from("inventory")
    .update({
      stock_quantity: toNum(values.stock_quantity),
      low_stock_threshold: toNum(values.low_stock_threshold),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) return { error: error.message };
  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  return { ok: true };
}

export type BulkUpdate = {
  id: string;
  stock_quantity?: string | number | null;
  low_stock_threshold?: string | number | null;
};

/** Apply many inventory edits in one call (bulk save / set-selected). */
export async function bulkUpdateInventory(updates: BulkUpdate[]) {
  const supabase = createClient();
  const now = new Date().toISOString();
  let ok = 0;
  const errors: string[] = [];

  for (const u of updates) {
    const patch: Record<string, unknown> = { updated_at: now };
    if (u.stock_quantity !== undefined) patch.stock_quantity = toNum(u.stock_quantity);
    if (u.low_stock_threshold !== undefined) patch.low_stock_threshold = toNum(u.low_stock_threshold);
    const { error } = await supabase.from("inventory").update(patch).eq("id", u.id);
    if (error) errors.push(`${u.id}: ${error.message}`);
    else ok++;
  }

  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  return { ok, failed: errors.length, errors: errors.slice(0, 5) };
}

export type StocktakeCount = {
  inventoryId: string;
  sku?: string | null;
  counted: number;
  location?: string | null; // when set, also save the product's shelf location
};

/**
 * Apply a shelf stocktake: set each inventory row's stock_quantity to the
 * physically counted number, and write a `stocktake` ledger row recording the
 * variance (old → new). Service-role client so it works under preview too.
 */
export async function applyStocktake(counts: StocktakeCount[]) {
  const admin = writableClient();
  const now = new Date().toISOString();
  let ok = 0;
  const errors: string[] = [];

  for (const c of counts) {
    const counted = Math.max(0, Math.floor(Number(c.counted)));
    if (!c.inventoryId || Number.isNaN(counted)) {
      errors.push(`${c.sku ?? c.inventoryId}: invalid count`);
      continue;
    }
    const { data: inv, error: readErr } = await admin
      .from("inventory")
      .select("id, stock_quantity, product_id, location")
      .eq("id", c.inventoryId)
      .single();
    if (readErr || !inv) {
      errors.push(`${c.sku ?? c.inventoryId}: not found`);
      continue;
    }
    const before = inv.stock_quantity ?? 0;
    const newLoc = c.location != null ? c.location.trim().toUpperCase() : null;
    const locChanged = newLoc != null && newLoc !== (inv.location ?? null);
    if (before === counted && !locChanged) {
      ok++; // no change needed, still a success
      continue;
    }
    const patch: Record<string, unknown> = { stock_quantity: counted, updated_at: now };
    if (locChanged) patch.location = newLoc;
    const { error: upErr } = await admin.from("inventory").update(patch).eq("id", inv.id);
    if (upErr) {
      errors.push(`${c.sku ?? c.inventoryId}: ${upErr.message}`);
      continue;
    }
    ok++;
    // Best-effort ledger entry recording the variance. (product_id is a legacy
    // bigint column — the uuid goes in details, not product_id, or the insert
    // would error and drop the row.)
    await admin.from("malak_audit").insert({
      agent: "stocktake",
      action: "stocktake",
      action_type: "stocktake",
      sku: c.sku ?? null,
      field: "stock_quantity",
      old_value: String(before),
      new_value: String(counted),
      status: "done",
      details: { productId: inv.product_id ?? null, counted, previous: before, variance: counted - before },
    });
  }

  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  return { ok, failed: errors.length, errors: errors.slice(0, 5) };
}

// ── Shelf / bin locations ──────────────────────────────────────────────────

/** Set (or clear) a product's physical shelf location, e.g. "A1". */
export async function setLocation(inventoryId: string, location: string) {
  if (!inventoryId) return { error: "Missing inventory row." };
  const admin = writableClient();
  const value = location.trim().toUpperCase() || null;
  const { error } = await admin
    .from("inventory")
    .update({ location: value, updated_at: new Date().toISOString() })
    .eq("id", inventoryId);
  if (error) return { error: error.message };
  revalidatePath("/inventory");
  revalidatePath("/inventory/shelves");
  return { ok: true };
}

/**
 * Create a shelf and its slots in one go: shelf "A" with count 5 makes
 * A1..A5. Existing slots are left untouched (idempotent upsert).
 */
export async function createShelf(shelf: string, count: number) {
  const letter = shelf.trim().toUpperCase().replace(/[^A-Z]/g, "");
  const n = Math.max(1, Math.min(200, Math.floor(count)));
  if (!letter) return { error: "Enter a shelf letter (A–Z)." };
  const admin = writableClient();
  const rows = Array.from({ length: n }, (_, i) => ({
    code: `${letter}${i + 1}`,
    shelf: letter,
    sort: i + 1,
  }));
  const { error } = await admin.from("shelf_slots").upsert(rows, { onConflict: "code" });
  if (error) return { error: error.message };
  revalidatePath("/inventory/shelves");
  revalidatePath("/inventory");
  return { ok: true, created: rows.length };
}

/** Add a single slot by code, e.g. "C7". */
export async function addSlot(code: string) {
  const c = code.trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z]+[0-9]+$/.test(c)) return { error: "Use a code like A1, B12." };
  const shelf = c.match(/^[A-Z]+/)![0];
  const sort = parseInt(c.replace(/^[A-Z]+/, ""), 10) || 0;
  const admin = writableClient();
  const { error } = await admin.from("shelf_slots").upsert({ code: c, shelf, sort }, { onConflict: "code" });
  if (error) return { error: error.message };
  revalidatePath("/inventory/shelves");
  return { ok: true };
}

/** Delete one slot. Products sitting there keep their (now free-text) location. */
export async function deleteSlot(code: string) {
  const admin = writableClient();
  const { error } = await admin.from("shelf_slots").delete().eq("code", code);
  if (error) return { error: error.message };
  revalidatePath("/inventory/shelves");
  return { ok: true };
}

/** Delete a whole shelf (all its slots). */
export async function deleteShelf(shelf: string) {
  const admin = writableClient();
  const { error } = await admin.from("shelf_slots").delete().eq("shelf", shelf.trim().toUpperCase());
  if (error) return { error: error.message };
  revalidatePath("/inventory/shelves");
  return { ok: true };
}

export type CsvRow = { sku: string; stock_quantity?: string | number; low_stock_threshold?: string | number };

/** Import stock by SKU: maps each SKU → inventory row, then bulk-updates. */
export async function importInventoryBySku(rows: CsvRow[]) {
  const supabase = createClient();
  const clean = rows
    .map((r) => ({ ...r, sku: String(r.sku ?? "").trim() }))
    .filter((r) => r.sku);
  if (clean.length === 0) return { updated: 0, notFound: 0, failed: 0, missing: [] as string[] };

  const skus = Array.from(new Set(clean.map((r) => r.sku)));

  // sku -> inventory.id (inventory joined to products via product_id)
  const skuToInv = new Map<string, string>();
  for (let i = 0; i < skus.length; i += 300) {
    const chunk = skus.slice(i, i + 300);
    const { data } = await supabase
      .from("inventory")
      .select("id, products!inner(sku)")
      .in("products.sku", chunk);
    for (const row of (data ?? []) as any[]) {
      const sku = row.products?.sku;
      if (sku) skuToInv.set(String(sku), row.id);
    }
  }

  const now = new Date().toISOString();
  let updated = 0,
    failed = 0;
  const missing: string[] = [];

  for (const r of clean) {
    const id = skuToInv.get(r.sku);
    if (!id) {
      missing.push(r.sku);
      continue;
    }
    const patch: Record<string, unknown> = { updated_at: now };
    if (r.stock_quantity !== undefined && r.stock_quantity !== "") patch.stock_quantity = toNum(r.stock_quantity);
    if (r.low_stock_threshold !== undefined && r.low_stock_threshold !== "")
      patch.low_stock_threshold = toNum(r.low_stock_threshold);
    const { error } = await supabase.from("inventory").update(patch).eq("id", id);
    if (error) failed++;
    else updated++;
  }

  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  return { updated, notFound: missing.length, failed, missing: missing.slice(0, 20) };
}

/**
 * Push current Supabase stock to Shopify for the given SKUs.
 * Honest, env-gated: requires SHOPIFY_SHOP + SHOPIFY_ADMIN_TOKEN. Without them
 * it returns a clear "not configured" status instead of pretending to work.
 */
export async function pushStockToShopify(items: { sku: string; quantity: number }[]) {
  const SHOP = process.env.SHOPIFY_SHOP;
  const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
  const LOCATION = process.env.SHOPIFY_LOCATION_ID || "gid://shopify/Location/81908531438";
  const VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

  if (!SHOP || !TOKEN) {
    return {
      configured: false as const,
      message:
        "Shopify push is not configured. Add SHOPIFY_SHOP and SHOPIFY_ADMIN_TOKEN (Admin API token with write_inventory) to the server env to enable it.",
    };
  }

  const endpoint = `https://${SHOP}/admin/api/${VERSION}/graphql.json`;
  const gql = async (query: string, variables?: unknown) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    return res.json();
  };

  let pushed = 0;
  const errors: string[] = [];
  for (const it of items) {
    try {
      const q = await gql(
        `query($q:String!){ productVariants(first:1, query:$q){ edges { node { inventoryItem { id } } } } }`,
        { q: `sku:${it.sku}` }
      );
      const invItem = q?.data?.productVariants?.edges?.[0]?.node?.inventoryItem?.id;
      if (!invItem) {
        errors.push(`${it.sku}: not found in Shopify`);
        continue;
      }
      const m = await gql(
        `mutation($input:InventorySetQuantitiesInput!){ inventorySetQuantities(input:$input){ userErrors{ message } } }`,
        {
          input: {
            name: "available",
            ignoreCompareQuantity: true,
            reason: "correction",
            quantities: [{ inventoryItemId: invItem, locationId: LOCATION, quantity: it.quantity }],
          },
        }
      );
      const ue = m?.data?.inventorySetQuantities?.userErrors;
      if (ue && ue.length) errors.push(`${it.sku}: ${ue[0].message}`);
      else pushed++;
    } catch (e: any) {
      errors.push(`${it.sku}: ${e?.message ?? "request failed"}`);
    }
  }

  return { configured: true as const, pushed, failed: errors.length, errors: errors.slice(0, 5) };
}

export type MovementInput = {
  inventoryId: string;
  sku?: string | null;
  type: "in" | "out";
  quantity: string | number;
  reason?: string | null;
  note?: string | null;
  by?: string | null;
};

/**
 * Record a stock IN/OUT movement: updates inventory.stock_quantity and writes a
 * ledger row into malak_audit (action_type stock_in / stock_out). Atomic-ish
 * read-modify-write via the service-role client (server-only).
 */
export async function recordMovement(input: MovementInput) {
  const admin = writableClient();
  const qty = Math.floor(Math.abs(Number(input.quantity)));
  if (!input.inventoryId || !qty || Number.isNaN(qty)) {
    return { error: "Pick a product and a quantity greater than 0." };
  }
  if (input.type !== "in" && input.type !== "out") return { error: "Invalid movement type." };

  const { data: inv, error: readErr } = await admin
    .from("inventory")
    .select("id, stock_quantity, sold_quantity, product_id")
    .eq("id", input.inventoryId)
    .single();
  if (readErr || !inv) return { error: "Inventory row not found." };

  const before = inv.stock_quantity ?? 0;
  const delta = input.type === "in" ? qty : -qty;
  const after = before + delta;
  if (after < 0) {
    return { error: `Not enough stock: have ${before}, tried to remove ${qty}.` };
  }

  const patch: Record<string, unknown> = { stock_quantity: after, updated_at: new Date().toISOString() };
  if (input.type === "out" && (input.reason ?? "").toLowerCase() === "sale") {
    patch.sold_quantity = (inv.sold_quantity ?? 0) + qty;
  }

  const { error: upErr } = await admin.from("inventory").update(patch).eq("id", inv.id);
  if (upErr) return { error: upErr.message };

  // Ledger insert is best-effort: the stock change above already succeeded.
  // NOTE: malak_audit.product_id is legacy bigint while products.id is uuid, so
  // we keep the uuid inside `details` rather than the product_id column (writing
  // it there errors and silently drops the whole ledger row).
  const { error: logErr } = await admin.from("malak_audit").insert({
    agent: input.by || "inventory",
    action: input.type === "in" ? "stock_in" : "stock_out",
    action_type: input.type === "in" ? "stock_in" : "stock_out",
    sku: input.sku ?? null,
    field: "stock_quantity",
    old_value: String(before),
    new_value: String(after),
    status: "done",
    details: {
      productId: inv.product_id ?? null,
      quantity: qty,
      direction: input.type,
      reason: input.reason ?? null,
      note: input.note ?? null,
    },
  });
  if (logErr) console.error("[recordMovement] audit insert failed:", logErr.message);

  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
  revalidatePath("/dashboard");
  return { ok: true, before, after, logged: !logErr };
}

export type RecogCandidate = {
  inventoryId: string;
  sku: string | null;
  name: string | null;
  name_ar: string | null;
  barcode: string | null;
  stock: number;
  image_url: string | null;
};

/**
 * Visual product recognition: send a captured photo to Claude (vision), extract
 * brand / type / keywords, then search the catalog and return the closest
 * matching products for the user to confirm. Human-in-the-loop by design.
 */
export async function recognizeProduct(imageDataUrl: string): Promise<
  { error: string } | { guess: string; terms: string[]; candidates: RecogCandidate[] }
> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: "AI vision isn’t configured on the server (ANTHROPIC_API_KEY missing)." };

  const m = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/.exec(imageDataUrl || "");
  if (!m) return { error: "Invalid image capture." };
  const media_type = m[1] as "image/png" | "image/jpeg" | "image/webp";
  const data = m[2];

  let guess = "";
  let tokens: string[] = [];
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system:
        "You identify retail beauty, skincare, cosmetics and home products from a photo, to search a store catalog. Reply with ONLY compact JSON, no prose.",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type, data } },
            {
              type: "text",
              text:
                'Identify this product for catalog search. Return JSON exactly: {"brand": string, "type": string, "color": string, "keywords": string[], "guess_name": string}. keywords = 5-10 lowercase English words a catalog search would match: brand name, product type, and distinctive words/text visible on the packaging.',
            },
          ],
        },
      ],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    guess = String(json.guess_name ?? "");
    const raw: string[] = [
      ...(Array.isArray(json.keywords) ? json.keywords : []),
      json.brand,
      json.type,
    ].filter(Boolean);
    // tokenise to safe alphanumeric words for ilike search
    tokens = Array.from(
      new Set(
        raw
          .join(" ")
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length >= 3)
      )
    ).slice(0, 12);
  } catch (e: any) {
    return { error: `Vision request failed: ${e?.message ?? "unknown error"}` };
  }

  if (tokens.length === 0) return { guess, terms: [], candidates: [] };

  try {
  const admin = writableClient();
  const orExpr = tokens
    .flatMap((t) => [`name_en.ilike.%${t}%`, `keywords_en.ilike.%${t}%`])
    .join(",");
  const { data: prods } = await admin
    .from("products")
    .select("id, sku, name_en, name_ar, barcode, image_url, keywords_en")
    .or(orExpr)
    .limit(1000);

  const scored = ((prods ?? []) as any[])
    .map((p) => {
      const hay = `${p.name_en ?? ""} ${p.keywords_en ?? ""}`.toLowerCase();
      const score = tokens.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const ids = scored.map((x) => x.p.id);
  const invRes = ids.length
    ? await admin.from("inventory").select("id, stock_quantity, product_id").in("product_id", ids)
    : { data: [] as any[] };
  const inv = (invRes.data ?? []) as any[];
  const invByProd = new Map<any, any>(inv.map((r: any) => [r.product_id, r]));

  const candidates: RecogCandidate[] = scored
    .map(({ p }) => {
      const iv = invByProd.get(p.id);
      if (!iv) return null;
      return {
        inventoryId: iv.id,
        sku: p.sku ?? null,
        name: p.name_en ?? null,
        name_ar: p.name_ar ?? null,
        barcode: p.barcode ?? null,
        stock: iv.stock_quantity ?? 0,
        image_url: p.image_url ?? null,
      };
    })
    .filter((c): c is RecogCandidate => c !== null);

  return { guess, terms: tokens, candidates };
  } catch (e: any) {
    return { error: `Catalog search failed: ${e?.message ?? "unknown error"}` };
  }
}
