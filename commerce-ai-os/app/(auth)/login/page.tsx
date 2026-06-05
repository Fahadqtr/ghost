import LoginForm from "@/components/LoginForm";
import { APP_NAME, APP_OWNER } from "@/lib/constants";

export const metadata = { title: `Sign in — ${APP_NAME}` };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-xl font-bold text-white">
            M
          </div>
          <h1 className="text-xl font-semibold text-ink">{APP_NAME}</h1>
          <p className="text-sm text-muted">{APP_OWNER}</p>
        </div>
        <div className="card">
          <LoginForm />
          <p className="mt-4 text-center text-xs text-muted">
            Internal tool · accounts are created in Supabase by the owner.
          </p>
        </div>
      </div>
    </main>
  );
}
