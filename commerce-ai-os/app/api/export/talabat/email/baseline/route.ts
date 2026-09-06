// TALABAT BASELINE — owner-only upload of the latest Talabat export (SERVER-ONLY).
//
// GET  → the active baseline's metadata (filename, rows, fingerprint, when).
// POST → validate and store one .xlsx. The file is PARSED FIRST: an unreadable
//        or wrong-shaped workbook never reaches storage, because the next
//        generation would otherwise compare against garbage.
//
// Storage is versioned by content fingerprint, so an already-generated artifact
// can always be traced to the exact file it came from.

import { requireOwner } from "@/lib/malak/authz";
import { uploadTalabatBaseline, readActiveBaseline } from "@/lib/talabat/email-workflow.server";
import { BASELINE_MAX_BYTES, BASELINE_REJECTION_AR, type BaselineRejection } from "@/lib/export/talabat/baseline-upload";
import { generationErrorMessageAr } from "@/lib/export/talabat/email-artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const jsonRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// Upload rejections first, then the generation vocabulary (which carries
// baseline_write_failed). The send vocabulary is deliberately unreachable here.
const messageAr = (code: string) =>
  BASELINE_REJECTION_AR[code as BaselineRejection] ?? generationErrorMessageAr(code);

export async function GET() {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);
  return jsonRes({ active: await readActiveBaseline() }, 200);
}

export async function POST(req: Request) {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);

  let filename = "";
  let bytes: Uint8Array;
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return jsonRes({ error: "empty_file", message_ar: messageAr("empty_file") }, 422);
    }
    // Refuse an oversize body before reading it into memory.
    if (file.size > BASELINE_MAX_BYTES) {
      return jsonRes({ error: "too_large", message_ar: messageAr("too_large") }, 413);
    }
    filename = file.name;
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return jsonRes({ error: "unreadable_workbook", message_ar: messageAr("unreadable_workbook") }, 400);
  }

  const result = await uploadTalabatBaseline(filename, bytes, owner.email);
  if (!result.ok) return jsonRes({ error: result.error, message_ar: messageAr(result.error) }, result.status);
  return jsonRes(result.value, 200);
}
