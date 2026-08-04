import { Suspense } from "react";
import Link from "next/link";
import LoginForm from "@/components/LoginForm";
import LanguageToggle from "@/components/LanguageToggle";
import { APP_NAME, APP_OWNER } from "@/lib/constants";
import { getT } from "@/lib/i18n-server";

export const metadata = { title: `Sign in — ${APP_NAME}` };

export default async function LoginPage() {
  const { locale, t } = await getT();
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-3 flex justify-end"><LanguageToggle locale={locale} /></div>
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-xl font-bold text-white">
            M
          </div>
          <h1 className="text-xl font-semibold text-ink">{APP_NAME}</h1>
          <p className="text-sm text-muted">{APP_OWNER}</p>
        </div>
        <div className="card">
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
          <p className="mt-4 text-center text-xs text-muted">
            {t("login.internalNote")}
          </p>
        </div>

        {/* Employees use the stock page (code only), not a Supabase account. */}
        <div className="mt-4 text-center">
          <Link
            href="/staff"
            className="inline-flex items-center gap-2 rounded-xl border border-violet-200 bg-white px-4 py-2.5 text-sm font-semibold text-violet-700 shadow-xs hover:bg-violet-50"
          >
            📦 {t("login.staffEntry")}
          </Link>
          <p className="mt-1.5 text-[11px] text-muted">{t("login.staffHint")}</p>
        </div>
      </div>
    </main>
  );
}
