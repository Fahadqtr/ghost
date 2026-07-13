// One-tap end-to-end test: publish a single throwaway Reel to Instagram to
// confirm the full pipeline (container → publish) and Arabic RTL rendering,
// BEFORE the cron is opened on the full schedule. Auth-gated + requires an
// explicit ?confirm=yes so it can't fire by accident. Delete the test post
// from Instagram afterwards.
import { publishReelToInstagram } from "@/lib/social/instagram";
import { requireUser } from "@/lib/auth/requireUser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// A short public sample video. Pass ?video=<public mp4 url> to test a real one.
const SAMPLE_VIDEO = "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";
const SAMPLE_CAPTION =
  "🌸 اختبار نشر — عالم ماليكا\n" +
  "هذا ريل تجريبي للتأكد إن النشر التلقائي يشتغل. اطلبيه من اللينك بالبايو 💄✨\n\n" +
  "Test reel — Malika's Universe. (delete me)\n" +
  "#قطر #ماليكا_يونيفرس #بيوتي #مكياج #Qatar";

export async function GET(req: Request) {
  const unauth = await requireUser();
  if (unauth) return Response.json({ error: unauth.error }, { status: 401 });

  const url = new URL(req.url);
  if (url.searchParams.get("confirm") !== "yes") {
    return Response.json({
      note: "⚠️ هذا ينشر ريل تجريبي فعلي على حساب انستقرام. للتنفيذ افتح نفس الرابط مع ?confirm=yes — واحذف المنشور بعد التأكد. تقدر تمرّر ?video=<رابط mp4 عام> و?caption=<نص> لاختبار فيديو حقيقي.",
    });
  }

  const videoUrl = url.searchParams.get("video") || SAMPLE_VIDEO;
  const caption = url.searchParams.get("caption") || SAMPLE_CAPTION;
  const r = await publishReelToInstagram(videoUrl, caption);
  return Response.json({
    ...r,
    hint: r.ok
      ? "✅ نُشر! افتح انستقرام وتأكد إن الريل ظهر والعربي يقرأ صح (RTL). احذف المنشور التجريبي بعدها."
      : "❌ فشل النشر — ألصق هذا الرد كامل.",
  });
}
