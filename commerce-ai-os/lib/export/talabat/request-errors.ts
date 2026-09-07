// WHAT TO TELL THE OWNER WHEN A REQUEST FAILS (PURE).
//
// STEP 90E. A 5xx with NO body is its own case, and the generic "the request
// failed" is wrong for it: the server process died mid-request, so there is no
// error code to render and the message reads like a network blip the owner
// should just retry through. It happened three times on the image work, and
// each time the screen said the same unhelpful thing.
//
// Say what actually happened, and say the one thing they will want to know
// first — that no mail went anywhere. It must never suggest the mail provider
// failed: on these routes nothing has contacted one.

export const SERVER_DIED_AR = "توقف الخادم أثناء تنفيذ التوليد. لم يتم إرسال أي بريد.";
export const REQUEST_FAILED_AR = "تعذّر تنفيذ الطلب.";

/**
 * The owner-facing text for a failed response.
 *
 * A precise backend message always wins. The empty-5xx case is recognised only
 * when the body really carried nothing — a 4xx, or any response with a code in
 * it, keeps the generic wording rather than claiming the server died.
 */
export function errorTextFor(res: { status: number }, body: unknown): string {
  const ar = (body as { message_ar?: unknown } | null)?.message_ar;
  if (typeof ar === "string" && ar !== "") return ar;
  const empty = body === null || typeof body !== "object" || Object.keys(body).length === 0;
  return res.status >= 500 && empty ? SERVER_DIED_AR : REQUEST_FAILED_AR;
}
