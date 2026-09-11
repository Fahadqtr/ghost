// RAFEEQ PACKAGE UPLOAD — verify what landed, then issue the link (OWNER ONLY).
//
// POST → checks the stored object's size against storage itself (not against
//        the browser's word for it) and, when it matches, returns a signed
//        download URL valid for 7 days. The bucket stays private; the link
//        carries its own scoped credential, so Rafeeq needs no login.

import { requireOwner } from "@/lib/malak/authz";
import { verifyRafeeqUploadAndLink } from "@/lib/rafeeq/package-upload.server";
import { RAFEEQ_UPLOAD_BLOCK_AR, type RafeeqUploadBlock } from "@/lib/export/rafeeq/package-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const jsonRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const messageAr = (code: string) =>
  RAFEEQ_UPLOAD_BLOCK_AR[code as RafeeqUploadBlock] ?? "تعذّر التحقق من الملف المرفوع.";

export async function POST(req: Request) {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);

  let body: { objectPath?: unknown; bytes?: unknown; sha256?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: "object_missing", message_ar: messageAr("object_missing") }, 400);
  }

  const result = await verifyRafeeqUploadAndLink(
    typeof body.objectPath === "string" ? body.objectPath : "",
    typeof body.bytes === "number" ? body.bytes : -1,
    typeof body.sha256 === "string" ? body.sha256 : "",
  );
  if (!result.ok) return jsonRes({ error: result.error, message_ar: messageAr(result.error) }, result.status);
  return jsonRes(result.value, 200);
}
