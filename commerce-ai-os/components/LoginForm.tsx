"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { LOGIN_ERRORS, requestPasswordReset } from "@/lib/auth/recovery";

type Mode = "signin" | "forgot";

export default function LoginForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Synchronous single-flight guard: a second click before the first request
  // resolves is ignored (React state updates alone can lag behind fast clicks).
  const busyRef = useRef(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setNotice(null);
    setLoading(true);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        // Never surface the raw Supabase error to the UI.
        setError(LOGIN_ERRORS.signInFailed);
        return;
      }
      // Session cookie is set; refresh so the server (middleware + layout) sees it.
      router.refresh();
      router.push("/dashboard");
    } catch {
      setError(LOGIN_ERRORS.generic);
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setNotice(null);
    setLoading(true);

    try {
      const supabase = createClient();
      const redirectTo =
        typeof window !== "undefined" ? `${window.location.origin}/auth/recovery` : undefined;
      // Trims the email, checks the returned { error }, and maps failures
      // (rate limit, misconfig, network) to a generic message — never raw.
      const outcome = await requestPasswordReset(email, (normalizedEmail) =>
        supabase.auth.resetPasswordForEmail(normalizedEmail, { redirectTo })
      );
      if (outcome.status === "sent") {
        // Generic, non-enumerating confirmation — shown ONLY on success.
        setNotice(outcome.message);
      } else {
        setError(outcome.message);
      }
    } finally {
      // finally only tears down the in-flight guards; it never decides the
      // user-facing outcome (so we can't show success on a failed request).
      busyRef.current = false;
      setLoading(false);
    }
  }

  if (mode === "forgot") {
    return (
      <form onSubmit={handleForgot} className="space-y-4">
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
            placeholder="you@example.com"
          />
        </div>

        {notice ? (
          <p role="status" aria-live="polite" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-60">
          {loading ? "Sending…" : "Send reset link"}
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("signin");
            setError(null);
            setNotice(null);
          }}
          className="w-full text-center text-sm text-violet-700 hover:underline"
        >
          Back to sign in
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="input"
          placeholder="you@example.com"
        />
      </div>
      <div>
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input"
          placeholder="••••••••"
        />
      </div>

      {notice ? (
        <p role="status" aria-live="polite" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-60">
        {loading ? "Signing in…" : "Sign in"}
      </button>

      <button
        type="button"
        onClick={() => {
          setMode("forgot");
          setError(null);
          setNotice(null);
        }}
        className="w-full text-center text-sm text-violet-700 hover:underline"
      >
        Forgot password?
      </button>
    </form>
  );
}
