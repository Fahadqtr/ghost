import Link from "next/link";
import TalabatSync from "@/components/TalabatSync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default function TalabatSyncPage() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div>
        <Link href="/import-export" className="text-xs text-muted hover:underline">← Import / Export</Link>
        <h2 className="text-lg font-semibold text-ink">🍊 Talabat Sync</h2>
        <p className="text-sm text-muted">
          قارن تصدير طلبات مع الكتالوج — الناقص عندهم يطلع كملف إكسل + صور جاهزين للإرسال بالإيميل.
        </p>
      </div>
      <TalabatSync />
    </div>
  );
}
