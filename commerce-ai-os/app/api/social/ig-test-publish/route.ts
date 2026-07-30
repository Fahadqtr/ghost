// One-tap end-to-end test: publish a single throwaway post to Instagram to
// confirm the full pipeline (container → publish) and Arabic RTL rendering,
// BEFORE the cron is opened on the full schedule. Auth-gated + requires an
// explicit ?confirm=yes so it can't fire by accident. Delete the test post
// from Instagram afterwards.
//
//   ?type=image (default) → a normal image post. Cleanest proof of publish +
//                           Arabic RTL. Pass ?image=<public jpg/png url>.
//   ?type=reel            → a Reel (needs a 9:16 H.264 MP4). Pass ?video=<url>.
//   ?caption=<text>       → override the caption.
import { publishToInstagram, publishReelToInstagram } from "@/lib/social/instagram";
import { requireOwner } from "@/lib/malak/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Stable, directly-served sample media.
const SAMPLE_IMAGE = "https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=1080&h=1080&fit=crop";
const SAMPLE_VIDEO = "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";
const SAMPLE_CAPTION =
  "🌸 اختبار نشر — عالم ماليكا\n" +
  "هذا منشور تجريبي للتأكد إن النشر التلقائي يشتغل والعربي يظهر صح. 💄✨\n\n" +
  "Test post — Malika's Universe. (delete me)\n" +
  "#قطر #ماليكا_يونيفرس #بيوتي #مكياج #Qatar";

export async function GET(req: Request) {
  const owner = await requireOwner();
  if (!owner.ok) return Response.json({ error: owner.error }, { status: owner.status });

  const url = new URL(req.url);
  if (url.searchParams.get("confirm") !== "yes") {
    return Response.json({
      note: "⚠️ هذا ينشر منشورًا تجريبيًا فعليًا على انستقرام. للتنفيذ أضف ?confirm=yes — واحذف المنشور بعد التأكد. الافتراضي منشور صورة (يثبت النشر + العربي RTL). للريل: ?type=reel&video=<رابط mp4 عمودي 9:16>. لصورتك: ?image=<رابط>. للكابشن: ?caption=<نص>.",
    });
  }

  const type = url.searchParams.get("type") === "reel" ? "reel" : "image";
  const caption = url.searchParams.get("caption") || SAMPLE_CAPTION;

  const r = type === "reel"
    ? await publishReelToInstagram(url.searchParams.get("video") || SAMPLE_VIDEO, caption)
    : await publishToInstagram(url.searchParams.get("image") || SAMPLE_IMAGE, caption);

  return Response.json({
    ...r, type,
    hint: r.ok
      ? "✅ نُشر! افتح انستقرام وتأكد إن المنشور ظهر والعربي يقرأ صح (RTL). احذف المنشور التجريبي بعدها."
      : "❌ فشل النشر — ألصق هذا الرد كامل.",
  });
}
