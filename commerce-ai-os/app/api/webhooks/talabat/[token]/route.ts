import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseTalabatOrder } from "@/lib/talabat/order-compute";
import { parseTalabatOrderLines } from "@/lib/talabat/order-lines";
import { buildTalabatDedupKey } from "@/lib/talabat/order-lines";
import { resolveTalabatOrder } from "@/lib/talabat/order-resolver";
import { buildTalabatDeductionPlan, sanitizeResolution } from "@/lib/talabat/deduction-plan";
import { evaluateDeductGate, isAutoDeductEnabled } from "@/lib/talabat/event-gate";
import { loadTalabatResolutionContext } from "@/lib/talabat/resolution-context";
import { loadStockSnapshots } from "@/lib/talabat/stock-snapshots";
import { processStoredTalabatOrder, type ProcessOrderDeps } from "@/lib/talabat/process-order";
import {
  handleTalabatWebhookPost,
  handleTalabatWebhookGet,
  constantTimeEqual,
} from "@/lib/talabat/webhook-core";

// Talabat / Delivery Hero ORDER webhook receiver. Register this URL in the
// Vendor Portal (Order Webhook Settings):
//   https://<app>/api/webhooks/talabat/<TALABAT_WEBHOOK_TOKEN>
// The token in the path is the shared secret. We STORE the full raw payload +
// best-effort display fields and ack 200 quickly. Automatic stock deduction is
// CLOSED BY DEFAULT — it runs server-side (after the response) only when
// TALABAT_AUTO_DEDUCT_ENABLED === "true" and the event is in
// TALABAT_DEDUCT_EVENT_ALLOWLIST. All processing/deduction logic lives in the
// self-contained, unit-tested modules under lib/talabat.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clean(v: string | undefined): string { return String(v ?? "").trim().replace(/^["']|["']$/g, ""); }

function tokenOk(given: string): boolean {
  const want = clean(process.env.TALABAT_WEBHOOK_TOKEN);
  if (!want) return false; // missing secret → fail closed
  return constantTimeEqual(given, want);
}

/** Build the injected dependencies for the server-only processor. */
function buildProcessDeps(): ProcessOrderDeps {
  return {
    enabledFlag: process.env.TALABAT_AUTO_DEDUCT_ENABLED,
    allowlistRaw: process.env.TALABAT_DEDUCT_EVENT_ALLOWLIST,
    parseLines: parseTalabatOrderLines,
    buildDedupKey: buildTalabatDedupKey,
    resolveOrder: resolveTalabatOrder,
    buildPlan: buildTalabatDeductionPlan,
    sanitize: sanitizeResolution,
    evaluateGate: evaluateDeductGate,
    loadContext: loadTalabatResolutionContext,
    loadSnapshots: loadStockSnapshots,
  };
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const rawText = await req.text().catch(() => "");
  const headerEvent = req.headers.get("x-event-type") || req.headers.get("x-dh-event") || null;

  const result = await handleTalabatWebhookPost(
    {
      tokenOk,
      parseLines: (payload: any) => ({ orderCode: parseTalabatOrderLines(payload).orderCode }),
      parseDisplay: (payload: any) => {
        const p = parseTalabatOrder(payload);
        return { status: p.status, customerName: p.customerName, total: p.total, currency: p.currency, placedAt: p.placedAt, items: p.items };
      },
      insertOrder: async (row) => {
        try {
          const admin = createAdminClient();
          const { data, error } = await admin.from("talabat_orders").insert(row).select("id, processing_status").single();
          if (error || !data) return { id: null, error: true };
          return { id: String(data.id), error: false };
        } catch {
          return { id: null, error: true };
        }
      },
      isAutoDeductEnabled: () => isAutoDeductEnabled(process.env.TALABAT_AUTO_DEDUCT_ENABLED),
      schedule: (fn) => after(fn),
      processOrder: async (orderId: string) => {
        const admin = createAdminClient();
        return processStoredTalabatOrder(admin, orderId, buildProcessDeps());
      },
      log: (msg: string) => console.error(msg),
    },
    { token: String(token || ""), rawText, headerEvent },
  );

  return new Response(result.body, {
    status: result.status,
    headers: result.contentType ? { "Content-Type": result.contentType } : undefined,
  });
}

// A GET on the same URL is handy for a quick "is it reachable?" check.
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const result = handleTalabatWebhookGet({ tokenOk }, { token: String(token || "") });
  return new Response(result.body, {
    status: result.status,
    headers: result.contentType ? { "Content-Type": result.contentType } : undefined,
  });
}
