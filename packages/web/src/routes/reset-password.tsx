import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { confirmPasswordReset } from "../lib/auth.ts";
import { captureException } from "../lib/telemetry.ts";

function ResetPasswordPage() {
  const { token } = useSearch({ from: "/reset-password" });
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setSubmitting(true);
    try {
      await confirmPasswordReset(token, password);
      setSuccess(true);
    } catch (err: unknown) {
      captureException(err, { operation: "auth.password-reset-confirm" });
      setError(err instanceof Error ? err.message : "Password reset failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-page flex items-center justify-center">
      <div className="w-full max-w-sm p-8 rounded-2xl bg-surface-solid border border-border shadow-xl">
        <h1 className="text-2xl font-bold text-foreground text-center mb-6">Reset password</h1>
        {success ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-subtle">Your password has been reset.</p>
            <Link to="/login" className="text-sm text-accent hover:text-accent/80">
              Sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <label htmlFor="reset-password" className="block text-xs text-muted mb-1">
              New password
            </label>
            <input
              id="reset-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
            />
            <label htmlFor="reset-password-confirm" className="block text-xs text-muted mb-1">
              Confirm password
            </label>
            <input
              id="reset-password-confirm"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
            />
            {error ? <p className="text-xs text-red-400">{error}</p> : null}
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2 text-sm font-medium rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Resetting..." : "Reset password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): { token: string } => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: ResetPasswordPage,
});
