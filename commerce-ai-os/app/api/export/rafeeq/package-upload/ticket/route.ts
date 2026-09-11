// RAFEEQ PACKAGE UPLOAD — mint a scoped upload credential (OWNER ONLY).
//
// POST → after the owner is verified, returns a signed upload token scoped to
//        ONE object path in the private `rafeeq-packages` bucket, plus the
//        resumable endpoint the browser uploads to directly.
//
// The archive itself never passes through this route: a 92 MB body would meet
// the platform's request limit, and nothing here needs to read the bytes.

import { requireOwner } from "@/lib/malak/authz";
import { createRafeeqUploadTicket } from "@/lib/rafeeq/package-upload.server";
import { RAFEEQ_UPLOAD_BLOCK_AR, type RafeeqUploadBlock } from "@/lib/export/rafeeq/package-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const jsonRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const messageAr = (code: string) =>
  RAFEEQ_UPLOAD_BLOCK_AR[code as RafeeqUploadBlock]
  ?? (code === "not_configured"
    ? "تهيئة التخزين غير مكتملة على الخادم."
    : "تعذّر تجهيز الرفع — حاول مرة أخرى.");

export async function POST(req: Request) {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);

  let body: { filename?: unknown; bytes?: unknown; sha256?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: "empty_file", message_ar: messageAr("empty_file") }, 400);
  }

  const result = await createRafeeqUploadTicket({
    filename: typeof body.filename === "string" ? body.filename : "",
    bytes: typeof body.bytes === "number" ? body.bytes : 0,
    sha256: typeof body.sha256 === "string" ? body.sha256 : "",
  });
  if (!result.ok) return jsonRes({ error: result.error, message_ar: messageAr(result.error) }, result.status);
  return jsonRes(result.value, 200);
}
