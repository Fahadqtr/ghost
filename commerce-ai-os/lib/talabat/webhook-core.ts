// Self-contained core of the Talabat order webhook (store-first, ack-fast). All
// I/O (token secret, DB insert, scheduling, background processing) is dependency-
// injected so node:test can drive it with fakes. The route (route.ts) is the thin
// adapter that wires the real admin client, parsers, after(), and processor.
//
// Security contract (unchanged from the original route):
//   * missing secret or wrong token → 404 (fail closed), never logs the token;
//   * the token is NEVER used as an order identity / dedup key;
//   * store the order FIRST, then acknowledge; processing runs server-side only;
//   * an insert failure never schedules processing and never leaks a raw error.

/** Constant-time token comparison. Missing/empty secret or length mismatch → false. */
export function constantTimeEqual(given: string, want: string): boolean {
  if (!want || !given || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

export interface WebhookResult {
  status: number;
  body: string;
  contentType?: string;
}

export interface WebhookPostDeps {
  tokenOk: (given: string) => boolean;
  /** New parser — the ONLY source of order_code (never the token). */
  parseLines: (payload: any) => { orderCode: string | null };
  /** Old parser — secondary DISPLAY fields only (status/customer/total/…); never the identity. */
  parseDisplay: (payload: any) => { status: string; customerName: string; total: number | null; currency: string; placedAt: string | null; items: any[] };
  /** Insert the order and return its internal id. Must NOT throw for a normal DB error. */
  insertOrder: (row: Record<string, unknown>) => Promise<{ id: string | null; error: boolean }>;
  /** True only when the auto-deduct flag is exactly "true". */
  isAutoDeductEnabled: () => boolean;
  /** Request-scoped after() — runs the callback AFTER the response is sent. */
  schedule: (fn: () => void | Promise<void>) => void;
  /** Server-only processor, invoked with the internal order id (reloads from DB). */
  processOrder: (orderId: string) => Promise<unknown>;
  /** Generic, PII-free logger. */
  log: (msg: string) => void;
}

function ackFast(): WebhookResult {
  return { status: 200, body: JSON.stringify({ ok: true }), contentType: "application/json" };
}

/**
 * Handle a POST. Returns fast after storing. Only schedules processing when the
 * feature flag is enabled; the processor re-checks the flag + event allowlist.
 */
export async function handleTalabatWebhookPost(
  deps: WebhookPostDeps,
  input: { token: string; rawText: string; headerEvent: string | null },
): Promise<WebhookResult> {
  if (!deps.tokenOk(String(input.token || ""))) return { status: 404, body: "Not found" };

  // Read the body once; keep raw even if it isn't valid JSON (nothing lost).
  let payload: any = null;
  try {
    payload = input.rawText ? JSON.parse(input.rawText) : null;
  } catch {
    payload = { _unparsed: String(input.rawText).slice(0, 20000) };
  }

  const parsed = deps.parseLines(payload);   // order_code source of truth
  const disp = deps.parseDisplay(payload);   // display-only secondary fields
  const rawEvent = input.headerEvent || (payload && (payload.event || payload.type)) || null;

  // STORE FIRST. Any DB failure is swallowed into a generic ack (never a raw
  // error, never the payload/customer/token) and NEVER schedules processing.
  let ins: { id: string | null; error: boolean };
  try {
    ins = await deps.insertOrder({
      order_code: parsed.orderCode,            // NEW parser only — never the token
      status: disp.status || null,
      customer_name: disp.customerName || null,
      total: disp.total,
      currency: disp.currency || null,
      placed_at: disp.placedAt || null,
      items: disp.items,
      raw: payload ?? { _empty: true },
      event: rawEvent ? String(rawEvent).slice(0, 80) : null,
    });
  } catch {
    deps.log("[talabat-webhook] insert threw");
    return ackFast();
  }
  if (!ins || ins.error || !ins.id) {
    deps.log("[talabat-webhook] insert failed");
    return ackFast();
  }

  // ACK FAST. Schedule server-side processing ONLY when auto-deduct is enabled;
  // the background callback reloads the order by internal id (no raw closure).
  if (deps.isAutoDeductEnabled()) {
    const orderId = ins.id;
    deps.schedule(async () => {
      try {
        await deps.processOrder(orderId);
      } catch {
        deps.log(`[talabat-processing] stage failed order=${orderId} stage=schedule`);
      }
    });
  }

  return ackFast();
}

export interface WebhookGetDeps {
  tokenOk: (given: string) => boolean;
}

/** GET health check — behavior unchanged: 404 on bad token, else a static ok body. */
export function handleTalabatWebhookGet(deps: WebhookGetDeps, input: { token: string }): WebhookResult {
  if (!deps.tokenOk(String(input.token || ""))) return { status: 404, body: "Not found" };
  return {
    status: 200,
    body: JSON.stringify({ ok: true, endpoint: "talabat-order-webhook", ready: true }),
    contentType: "application/json",
  };
}
