// Self-contained core of the Talabat order webhook (store-first, ack-fast). All
// I/O (token secret, body read, DB insert, scheduling, background processing) is
// dependency-injected so node:test can drive it with fakes. The route (route.ts)
// is the thin adapter that wires the real admin client, parsers, after(), and
// processor.
//
// Security contract:
//   * the token is VALIDATED before the body is read — readBody() is not called
//     until the token passes (missing secret / wrong token → 404), and the token
//     is never logged and never used as an order identity / dedup key;
//   * store the order FIRST, then acknowledge; processing runs server-side only;
//   * an insert failure never schedules processing and never leaks a raw error;
//   * if after() fails to register, the order is marked failed (never left
//     silently pending) and the processor is NOT run inline.

/** Constant-time token comparison. Missing/empty secret or length mismatch → false. */
export function constantTimeEqual(given: string, want: string): boolean {
  if (!want || !given || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

/** Coerce a stored event to a trimmed string capped at 80 chars; anything that is
 *  not a non-empty string (object/array/number/null) → null. */
export function normalizeStoredEvent(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, 80) : null;
}

export interface WebhookResult {
  status: number;
  body: string;
  contentType?: string;
}

export interface WebhookPostDeps {
  tokenOk: (given: string) => boolean;
  /** Read the request body — invoked ONLY after the token passes. */
  readBody: () => Promise<string>;
  /** New parser — the ONLY source of order_code + the structured event (never the token). */
  parseLines: (payload: any) => { orderCode: string | null; event: string | null };
  /** Old parser — secondary DISPLAY fields only (status/customer/total/…); never the identity. */
  parseDisplay: (payload: any) => { status: string; customerName: string; total: number | null; currency: string; placedAt: string | null; items: any[] };
  /** Insert the order and return its internal id. Must NOT throw for a normal DB error. */
  insertOrder: (row: Record<string, unknown>) => Promise<{ id: string | null; error: boolean }>;
  /** True only when the auto-deduct flag is exactly "true". */
  isAutoDeductEnabled: () => boolean;
  /** Request-scoped after() — runs the callback AFTER the response is sent. May throw. */
  schedule: (fn: () => void | Promise<void>) => void;
  /** Server-only processor, invoked with the internal order id (reloads from DB). */
  processOrder: (orderId: string) => Promise<unknown>;
  /** Called (and awaited) when schedule() throws, so the order is not left pending. */
  handleScheduleFailure: (orderId: string) => Promise<unknown>;
  /** Called when the background processOrder() rejects unexpectedly, so a crashed
   *  callback marks the order failed (verified) instead of leaving it pending. */
  handleUnexpectedProcessingFailure: (orderId: string) => Promise<unknown>;
  /** Generic, PII-free logger. */
  log: (msg: string) => void;
}

function ackFast(): WebhookResult {
  return { status: 200, body: JSON.stringify({ ok: true }), contentType: "application/json" };
}

/**
 * Handle a POST. Validates the token BEFORE reading the body, stores the order,
 * returns fast. Schedules processing only when the flag is enabled; the processor
 * re-checks the flag + event allowlist. The `headerEvent` is derived from headers
 * (not the body) so it is safe to compute before the token check in the adapter,
 * but the body is only read here, after the token passes.
 */
export async function handleTalabatWebhookPost(
  deps: WebhookPostDeps,
  input: { token: string; headerEvent: string | null },
): Promise<WebhookResult> {
  // TOKEN FIRST — the body is NOT read until this passes.
  if (!deps.tokenOk(String(input.token || ""))) return { status: 404, body: "Not found" };

  // Reading the body must not crash the webhook — on any throw, fall back to an
  // empty body and log only a generic stage (never the body/token).
  let rawText = "";
  try {
    rawText = await deps.readBody();
  } catch {
    deps.log("[talabat-webhook] read_body threw");
  }
  let payload: any = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = { _unparsed: String(rawText).slice(0, 20000) };
  }

  // Parsing must not crash the webhook either. A throwing parser falls back to a
  // null identity / safe display defaults; nothing is lost (raw is still stored).
  let parsed: { orderCode: string | null; event: string | null };
  try {
    parsed = deps.parseLines(payload);
  } catch {
    deps.log("[talabat-webhook] parse_lines threw");
    parsed = { orderCode: null, event: null };
  }
  let disp: { status: string; customerName: string; total: number | null; currency: string; placedAt: string | null; items: any[] };
  try {
    disp = deps.parseDisplay(payload);
  } catch {
    deps.log("[talabat-webhook] parse_display threw");
    disp = { status: "RECEIVED", customerName: "", total: null, currency: "QAR", placedAt: null, items: [] };
  }
  // Event: a validated header event first, else the NEW parser's event (so a
  // nested order.event is not lost). String only, capped at 80; else null.
  const event = normalizeStoredEvent(input.headerEvent) ?? normalizeStoredEvent(parsed.event);

  // STORE FIRST. Any DB failure is swallowed into a generic ack (never a raw
  // error / payload / customer / token) and NEVER schedules processing.
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
      event,
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
  // the background callback reloads the order by internal id (no raw closure). If
  // registering the callback throws, the order is marked failed (never left
  // silently pending) and the processor is NOT run inline.
  if (deps.isAutoDeductEnabled()) {
    const orderId = ins.id;
    try {
      deps.schedule(async () => {
        try {
          await deps.processOrder(orderId);
        } catch {
          // The background run rejected unexpectedly — mark the order failed
          // (verified) instead of leaving it silently pending. Never re-run.
          deps.log(`[talabat-processing] stage failed order=${orderId} stage=processing`);
          try {
            await deps.handleUnexpectedProcessingFailure(orderId);
          } catch {
            deps.log(`[talabat-processing] stage failed order=${orderId} stage=processing_failure_handler`);
          }
        }
      });
    } catch {
      deps.log(`[talabat-processing] stage failed order=${orderId} stage=schedule_register`);
      try {
        await deps.handleScheduleFailure(orderId);
      } catch {
        deps.log(`[talabat-processing] stage failed order=${orderId} stage=schedule_failure_handler`);
      }
    }
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
