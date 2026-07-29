"use client";

// Prefetch-safe password recovery landing page.
//
// Accepted link formats (token in either place; fragment preferred):
//   https://app.malikasuniverse.com/auth/recovery#token_hash=...&type=recovery
//   https://app.malikasuniverse.com/auth/recovery?token_hash=...&type=recovery
//
// On load we only READ the token — fragment first, query as a fallback — keep it
// in memory (useRef), and immediately clear BOTH the query and the fragment from
// the URL. We do NOT verify automatically (Gmail prefetch abuses that).
// Verification (verifyOtp) runs only when the user clicks "Continue password
// reset"; then they set a new password (updateUser) and we sign out.
//
// Anon browser client only — no service-role, no admin API. The token is never
// written to storage/cookies or logged, and errors are safe generic messages.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  resolveRecoveryToken,
  validateNewPassword,
  RECOVERY_ERRORS,
  MIN_RECOVERY_PASSWORD_LENGTH,
} from "@/lib/auth/recovery";

type Stage = "verify" | "setPassword" | "done";

export default function RecoveryPage() {
  const [stage, setStage] = useState<Stage>("verify");
  const [linkValid, setLinkValid] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const tokenHashRef = useRef<string | null>(null);
  const clientRef = useRef<ReturnType<typeof createClient> | null>(null);
  const busyRef = useRef(false);

  // On load: read the token — fragment first, query as a fallback — keep it in
  // memory, and immediately strip BOTH the query and the fragment from the URL.
  // NO verification happens here — only on an explicit click.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const { tokenHash, source } = resolveRecoveryToken(
      window.location.hash,
      window.location.search
    );
    // Drop query + fragment (pathname only) so the token isn't left in the
    // address bar, history, or any later referrer.
    window.history.replaceState(null, "", window.location.pathname);

    const valid = source !== "none";
    if (valid) tokenHashRef.current = tokenHash;

    // Reading the one-time token from the URL is a client-only, post-mount
    // action — there is no SSR-safe way to derive this during render, so the
    // state update must live here in the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLinkValid(valid);
    if (!valid) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError(RECOVERY_ERRORS.invalidLink);
    }
  }, []);

  function getClient() {
    if (!clientRef.current) clientRef.current = createClient();
    return clientRef.current;
  }

  async function handleContinue() {
    if (busyRef.current) return; // single-flight guard against double clicks
    const token = tokenHashRef.current;
    if (!token) {
      setError(RECOVERY_ERRORS.invalidLink);
      return;
    }
    busyRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const { error: verifyError } = await getClient().auth.verifyOtp({
        token_hash: token,
        type: "recovery",
      });
      if (verifyError) {
        setError(RECOVERY_ERRORS.invalidLink);
        return;
      }
      setStage("setPassword");
    } catch {
      setError(RECOVERY_ERRORS.verifyFailed);
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (busyRef.current) return;

    const check = validateNewPassword(newPassword, confirmPassword);
    if (!check.ok) {
      setError(check.error ?? "Invalid password.");
      return;
    }

    busyRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const supabase = getClient();
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) {
        setError(RECOVERY_ERRORS.updateFailed);
        return;
      }
      await supabase.auth.signOut();
      tokenHashRef.current = null;
      setNewPassword("");
      setConfirmPassword("");
      setNotice("Password updated successfully.");
      setStage("done");
    } catch {
      setError(RECOVERY_ERRORS.updateFailed);
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-xl font-bold text-white">
            M
          </div>
          <h1 className="text-xl font-semibold text-ink">Reset your password</h1>
        </div>

        <div className="card space-y-4">
          {notice ? (
            <p
              role="status"
              aria-live="polite"
              className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700"
            >
              {notice}
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          {stage === "done" ? (
            <Link href="/login" className="btn-primary block w-full text-center">
              Go to sign in
            </Link>
          ) : stage === "setPassword" ? (
            <form onSubmit={handleSetPassword} className="space-y-4">
              <div>
                <label className="label" htmlFor="new-password">
                  New password
                </label>
                <input
                  id="new-password"
                  type="password"
                  required
                  minLength={MIN_RECOVERY_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="input"
                />
                <p className="mt-1 text-xs text-muted">
                  At least {MIN_RECOVERY_PASSWORD_LENGTH} characters.
                </p>
              </div>
              <div>
                <label className="label" htmlFor="confirm-password">
                  Confirm password
                </label>
                <input
                  id="confirm-password"
                  type="password"
                  required
                  minLength={MIN_RECOVERY_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="input"
                />
              </div>
              <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-60">
                {loading ? "Updating…" : "Set new password"}
              </button>
            </form>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted">
                Click below to continue resetting your password.
              </p>
              <button
                type="button"
                onClick={handleContinue}
                disabled={loading || !linkValid}
                className="btn-primary w-full disabled:opacity-60"
              >
                {loading ? "Verifying…" : "Continue password reset"}
              </button>
              {!linkValid ? (
                <Link href="/login" className="block text-center text-sm text-violet-700 hover:underline">
                  Back to sign in
                </Link>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
