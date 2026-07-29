import {
  getEmailValidationError,
  getNewPasswordValidationError,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENT_TEXT,
} from "@dofek/auth/auth";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ProviderLogo, providerLabel } from "../components/ProviderLogo.tsx";
import type { ConfiguredProviders } from "../lib/auth.ts";
import {
  fetchConfiguredProviders,
  loginWithPassword,
  registerWithPassword,
  requestPasswordReset,
} from "../lib/auth.ts";
import { captureException } from "../lib/telemetry.ts";

type AuthMode = "login" | "register" | "reset";

function LoginPage() {
  const { providerGuide, returnTo: requestedReturnTo } = useSearch({ from: "__root__" });
  const [providers, setProviders] = useState<ConfiguredProviders | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [emailTouched, setEmailTouched] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);

  useEffect(() => {
    fetchConfiguredProviders()
      .then(setProviders)
      .catch((err: unknown) => {
        captureException(err, { operation: "auth.providers" });
        setError(err instanceof Error ? err.message : "Failed to load providers");
      })
      .finally(() => setLoading(false));
  }, []);

  const allProviders = providers
    ? [
        ...providers.identity.map((id) => ({ id, type: "identity" as const })),
        ...providers.data.map((id) => ({ id, type: "data" as const })),
      ]
    : [];
  const returnTo =
    requestedReturnTo ?? (providerGuide ? "/dashboard?providerGuide=true" : undefined);
  const returnToQuery = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : "";
  const showPasswordAuth = providers?.password ?? false;
  const showOAuthProviders = allProviders.length > 0;
  const emailValidationError =
    authMode === "reset" || !emailTouched ? null : getEmailValidationError(email);
  const passwordValidationError = passwordTouched
    ? password
      ? authMode === "register"
        ? getNewPasswordValidationError(password)
        : null
      : "Enter your password."
    : null;

  function changeAuthMode(mode: AuthMode) {
    setAuthMode(mode);
    setFormError(null);
    setEmailTouched(false);
    setPasswordTouched(false);
    setPasswordVisible(false);
  }

  async function handlePasswordSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailTouched(true);
    setPasswordTouched(true);
    setFormError(null);
    const emailError = getEmailValidationError(email);
    const passwordError = password
      ? authMode === "register"
        ? getNewPasswordValidationError(password)
        : null
      : "Enter your password.";
    if (emailError || passwordError) return;

    setSubmitting(true);
    try {
      const result =
        authMode === "register"
          ? await registerWithPassword({
              email,
              password,
              name: name.trim() || undefined,
              returnTo,
            })
          : await loginWithPassword({ email, password, returnTo });
      window.location.href = result.redirect;
    } catch (err: unknown) {
      captureException(err, {
        operation: authMode === "register" ? "auth.register" : "auth.login",
      });
      setFormError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePasswordResetSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await requestPasswordReset(email);
      setFormError(result.message);
    } catch (err: unknown) {
      captureException(err, { operation: "auth.password-reset-request" });
      setFormError(err instanceof Error ? err.message : "Password reset failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-page flex items-center justify-center">
      <div className="w-full max-w-sm p-8 rounded-2xl bg-surface-solid border border-border shadow-xl">
        <h1 className="text-2xl font-bold text-foreground text-center mb-2">Dofek</h1>
        <p className="text-muted text-center mb-8 text-sm">Sign in to view your health data</p>

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-border-strong border-t-accent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="text-center">
            <p className="text-red-400 text-sm mb-2">Unable to connect to server</p>
            <p className="text-subtle text-xs">{error}</p>
          </div>
        ) : !showPasswordAuth && !showOAuthProviders ? (
          <p className="text-subtle text-center text-sm">No login providers configured.</p>
        ) : (
          <div className="space-y-6">
            {showPasswordAuth ? (
              <div>
                {authMode === "reset" ? (
                  <>
                    {formError ? (
                      <div className="mb-3 text-xs text-accent bg-accent/10 rounded px-3 py-2">
                        {formError}
                      </div>
                    ) : null}
                    <form onSubmit={handlePasswordResetSubmit} className="space-y-3">
                      <div>
                        <label htmlFor="reset-email" className="block text-xs text-muted mb-1">
                          Email
                        </label>
                        <input
                          id="reset-email"
                          type="email"
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                          required
                          autoComplete="email"
                          className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
                          placeholder="you@example.com"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={submitting}
                        className="w-full py-2 text-sm font-medium rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                      >
                        {submitting ? "Sending..." : "Send reset link"}
                      </button>
                      <button
                        type="button"
                        onClick={() => changeAuthMode("login")}
                        className="w-full text-xs text-muted hover:text-foreground transition-colors"
                      >
                        Back to sign in
                      </button>
                    </form>
                  </>
                ) : (
                  <>
                    <div className="flex rounded-lg border border-border overflow-hidden mb-4">
                      <button
                        type="button"
                        onClick={() => changeAuthMode("login")}
                        className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                          authMode === "login"
                            ? "bg-accent/15 text-foreground"
                            : "bg-transparent text-muted hover:text-foreground"
                        }`}
                      >
                        Sign in
                      </button>
                      <button
                        type="button"
                        onClick={() => changeAuthMode("register")}
                        className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                          authMode === "register"
                            ? "bg-accent/15 text-foreground"
                            : "bg-transparent text-muted hover:text-foreground"
                        }`}
                      >
                        Create account
                      </button>
                    </div>

                    <form onSubmit={handlePasswordSubmit} className="space-y-3" noValidate>
                      {authMode === "register" ? (
                        <div>
                          <label htmlFor="register-name" className="block text-xs text-muted mb-1">
                            Name
                          </label>
                          <input
                            id="register-name"
                            type="text"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            autoComplete="name"
                            className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
                            placeholder="Your name"
                          />
                        </div>
                      ) : null}
                      <div>
                        <label htmlFor="auth-email" className="block text-xs text-muted mb-1">
                          Email
                        </label>
                        <input
                          id="auth-email"
                          type="email"
                          value={email}
                          onChange={(event) => {
                            setEmail(event.target.value);
                            setFormError(null);
                          }}
                          onBlur={() => setEmailTouched(true)}
                          required
                          autoComplete="email"
                          aria-invalid={emailValidationError ? true : undefined}
                          aria-describedby={emailValidationError ? "auth-email-error" : undefined}
                          className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
                          placeholder="you@example.com"
                        />
                        {emailValidationError ? (
                          <p
                            id="auth-email-error"
                            role="alert"
                            className="mt-1 text-xs text-red-400"
                          >
                            {emailValidationError}
                          </p>
                        ) : null}
                      </div>
                      <div>
                        <label htmlFor="auth-password" className="block text-xs text-muted mb-1">
                          Password
                        </label>
                        <div className="relative">
                          <input
                            id="auth-password"
                            type={passwordVisible ? "text" : "password"}
                            value={password}
                            onChange={(event) => {
                              setPassword(event.target.value);
                              setFormError(null);
                            }}
                            onBlur={() => setPasswordTouched(true)}
                            required
                            minLength={authMode === "register" ? PASSWORD_MIN_LENGTH : undefined}
                            maxLength={authMode === "register" ? PASSWORD_MAX_LENGTH : undefined}
                            autoComplete={
                              authMode === "register" ? "new-password" : "current-password"
                            }
                            aria-invalid={passwordValidationError ? true : undefined}
                            aria-describedby={
                              passwordValidationError || authMode === "register" || formError
                                ? "auth-password-message"
                                : undefined
                            }
                            className="w-full px-3 py-2 pr-16 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
                          />
                          <button
                            type="button"
                            onClick={() => setPasswordVisible((visible) => !visible)}
                            aria-label={passwordVisible ? "Hide password" : "Show password"}
                            className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-muted hover:text-foreground transition-colors"
                          >
                            {passwordVisible ? "Hide" : "Show"}
                          </button>
                        </div>
                        {passwordValidationError ? (
                          <p
                            id="auth-password-message"
                            role="alert"
                            className="mt-1 text-xs text-red-400"
                          >
                            {passwordValidationError}
                          </p>
                        ) : formError ? (
                          <p
                            id="auth-password-message"
                            role="alert"
                            className="mt-1 text-xs text-red-400"
                          >
                            {formError}
                          </p>
                        ) : authMode === "register" ? (
                          <p id="auth-password-message" className="mt-1 text-xs text-subtle">
                            {PASSWORD_REQUIREMENT_TEXT}
                          </p>
                        ) : null}
                      </div>
                      {authMode === "login" ? (
                        <button
                          type="button"
                          onClick={() => changeAuthMode("reset")}
                          className="text-xs text-muted hover:text-accent transition-colors"
                        >
                          Forgot password?
                        </button>
                      ) : null}
                      <button
                        type="submit"
                        disabled={submitting || !email.trim() || !password}
                        className="w-full py-2 text-sm font-medium rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                      >
                        {submitting
                          ? authMode === "register"
                            ? "Creating account..."
                            : "Signing in..."
                          : authMode === "register"
                            ? "Create account"
                            : "Sign in with email"}
                      </button>
                    </form>
                  </>
                )}
              </div>
            ) : null}

            {showPasswordAuth && showOAuthProviders ? (
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-subtle uppercase tracking-wide">or</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            ) : null}

            {showOAuthProviders ? (
              <div className="space-y-3">
                {allProviders.map(({ id, type }) => (
                  <a
                    key={id}
                    href={
                      type === "identity"
                        ? `/auth/login/${id}${returnToQuery}`
                        : `/auth/login/data/${id}${returnToQuery}`
                    }
                    className="flex items-center justify-center gap-3 w-full px-4 py-3 rounded-lg bg-accent/10 hover:bg-surface-hover border border-border-strong hover:border-border-strong text-foreground transition-colors text-sm font-medium"
                  >
                    <ProviderLogo provider={id} size={20} />
                    Sign in with {providerLabel(id)}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/login")({
  component: LoginPage,
});
