"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { LOCALE_COOKIE, type Locale } from "@/lib/i18n";

// Flips the `locale` cookie (ar ⇄ en) then refreshes so server components
// (html dir/lang, nav, pages) re-render in the chosen language.
export default function LanguageToggle({ locale }: { locale: Locale }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const switchTo = (l: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    start(() => router.refresh());
  };

  return (
    <button
      type="button"
      onClick={() => switchTo(locale === "ar" ? "en" : "ar")}
      disabled={pending}
      title="Language · اللغة"
      aria-label="Toggle language"
      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
    >
      🌐 {locale === "ar" ? "EN" : "ع"}
    </button>
  );
}
