import {
  getNewPasswordValidationError,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENT_TEXT,
} from "@dofek/auth/auth";
import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { PasswordInput } from "../components/PasswordInput.tsx";
import { confirmPasswordReset } from "../lib/auth.ts";
import { captureException } from "../lib/telemetry.ts";

function PasswordResetForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const passwordError = getNewPasswordValidationError(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }
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

  return success ? (
    <div className="space-y-4 text-center">
      <p className="text-sm text-subtle">Your password has been reset.</p>
      <Link to="/login" className="text-sm text-accent hover:text-accent/80">
        Sign in
      </Link>
    </div>
  ) : (
    <form onSubmit={handleSubmit} className="space-y-3" noValidate>
      <label htmlFor="reset-password" className="block text-xs text-muted mb-1">
        New password
      </label>
      <PasswordInput
        id="reset-password"
        visibilityLabel="new password"
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
          setError(null);
        }}
        required
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        autoComplete="new-password"
        aria-invalid={error ? true : undefined}
        aria-describedby="reset-password-message"
        className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
      />
      <label htmlFor="reset-password-confirm" className="block text-xs text-muted mb-1">
        Confirm password
      </label>
      <PasswordInput
        id="reset-password-confirm"
        visibilityLabel="confirm password"
        value={confirmPassword}
        onChange={(event) => {
          setConfirmPassword(event.target.value);
          setError(null);
        }}
        required
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        autoComplete="new-password"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "reset-password-message" : undefined}
        className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
      />
      {error ? (
        <p id="reset-password-message" role="alert" className="text-xs text-red-400">
          {error}
        </p>
      ) : (
        <p id="reset-password-message" className="text-xs text-subtle">
          {PASSWORD_REQUIREMENT_TEXT}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className={`w-full py-2 text-sm font-medium rounded transition-colors ${
          submitting
            ? "bg-surface-hover text-muted cursor-not-allowed"
            : "bg-emerald-600 text-white hover:bg-emerald-500"
        }`}
      >
        {submitting ? "Resetting..." : "Reset password"}
      </button>
    </form>
  );
}

function ResetPasswordPage() {
  const { token } = useSearch({ from: "/reset-password" });

  return (
    <div className="min-h-screen bg-page flex items-center justify-center">
      <div className="w-full max-w-sm p-8 rounded-2xl bg-surface-solid border border-border shadow-xl">
        <h1 className="text-2xl font-bold text-foreground text-center mb-6">Reset password</h1>
        {token ? (
          <PasswordResetForm token={token} />
        ) : (
          <div role="alert" className="space-y-4 text-center">
            <p className="text-sm text-subtle">This password reset link is missing or invalid.</p>
            <p className="text-sm text-muted">
              Return to sign in and request a new password reset link.
            </p>
            <Link to="/login" className="text-sm text-accent hover:text-accent/80">
              Return to sign in
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): { token?: string } => {
    const token = typeof search.token === "string" ? search.token : undefined;
    return token ? { token } : {};
  },
  component: ResetPasswordPage,
});
