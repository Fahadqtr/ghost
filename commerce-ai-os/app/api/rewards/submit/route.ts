// Public: a customer uploads a screenshot of the review they left on Snoonu.
// The image is stored in the loyalty-reviews bucket and linked as a PENDING
// submission — no heart is granted until the owner/staff approve it in the
// admin app. No auth (customer-facing), so guards live here: a per-IP rate
// limit (before any service-role work), file type/size limits, and a cap on
// how many screenshots can queue per customer. Storage/DB errors are returned
// as a generic message (no raw service text).
import { createAdminClient } from "@/lib/supabase/admin";
import {
  addSubmission,
  getStateByPhone,
  normalizePhone,
  REVIEW_BUCKET,
} from "@/lib/loyalty/rewards";
import { rateLimit, clientIpFrom, runIfAllowed } from "@/lib/ratelimit";
import {
  REWARDS_RATE_LIMIT,
  RATE_LIMITED_MESSAGE,
  REWARDS_GENERIC_ERROR,
  toPublicRewardState,
} from "@/lib/loyalty/rewards-public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_PENDING = 5; // stop a customer from flooding the review queue
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export async function POST(req: Request) {
  const ip = clientIpFrom(req.headers.get("x-forwarded-for"), req.headers.get("x-real-ip"));
  return runIfAllowed(
    () => rateLimit("rewards:submit", ip, REWARDS_RATE_LIMIT),
    () => Response.json({ error: RATE_LIMITED_MESSAGE }, { status: 429 }),
    () => handleSubmit(req)
  );
}

async function handleSubmit(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "صيغة الطلب غير صحيحة." }, { status: 400 });
  }

  const rawPhone = String(form.get("phone") ?? "");
  const phone = normalizePhone(rawPhone);
  if (!phone) return Response.json({ error: "رقم الجوال غير صحيح." }, { status: 400 });

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    return Response.json({ error: "لا توجد صورة." }, { status: 400 });
  if (file.size > MAX_BYTES)
    return Response.json(
      { error: `الصورة كبيرة (${(file.size / 1048576).toFixed(1)}MB). الحد 10MB.` },
      { status: 400 }
    );
  const ext = EXT[file.type];
  if (!ext)
    return Response.json(
      { error: `نوع غير مدعوم "${file.type || "?"}". استخدمي JPG أو PNG.` },
      { status: 400 }
    );

  // Must be a registered customer, and not already flooding the queue.
  const state = await getStateByPhone(phone);
  if (!state)
    return Response.json({ error: "سجّلي اسمك ورقمك أولاً." }, { status: 400 });
  if (state.pending >= MAX_PENDING)
    return Response.json(
      { error: "عندك صور كثيرة بانتظار المراجعة. انتظري اعتمادها أولاً." },
      { status: 429 }
    );

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return Response.json({ error: REWARDS_GENERIC_ERROR }, { status: 500 });
  }

  const path = `${phone}/${Date.now()}_${Math.floor(Math.random() * 1e4)}.${ext}`;
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const { error: upErr } = await admin.storage
      .from(REVIEW_BUCKET)
      .upload(path, buf, { contentType: file.type, upsert: false, cacheControl: "3600" });
    if (upErr) return Response.json({ error: REWARDS_GENERIC_ERROR }, { status: 400 });

    const imageUrl = admin.storage.from(REVIEW_BUCKET).getPublicUrl(path).data.publicUrl;
    await addSubmission(phone, path, imageUrl);

    const next = await getStateByPhone(phone);
    return Response.json({ ok: true, state: next ? toPublicRewardState(next) : null });
  } catch {
    return Response.json({ error: REWARDS_GENERIC_ERROR }, { status: 400 });
  }
}
