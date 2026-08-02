import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";
import { ModalDialog, ModalDialogTitle } from "./ModalDialog.tsx";

const enabledAuthSubmitButtonClassName =
  "w-full py-2 text-sm font-medium rounded bg-emerald-600 text-white hover:bg-emerald-500 transition-colors";
const disabledAuthSubmitButtonClassName =
  "w-full py-2 text-sm font-medium rounded bg-surface-hover text-muted cursor-not-allowed transition-colors";

function authSubmitButtonClassName(disabled: boolean) {
  return disabled ? disabledAuthSubmitButtonClassName : enabledAuthSubmitButtonClassName;
}

function credentialSubmitHint(username: string, password: string, loading: boolean) {
  if (loading) return null;
  if (!username.trim() && !password) return "Enter your email and password to continue.";
  if (!username.trim()) return "Enter your email to continue.";
  if (!password) return "Enter your password to continue.";
  return null;
}

// -- Credential Auth Modal --

export function CredentialAuthModal({
  providerId,
  providerName,
  description,
  onClose,
  onSuccess,
}: {
  providerId: string;
  providerName: string;
  description?: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const signInDisabled = loading || !username.trim() || !password;
  const signInHint = credentialSubmitHint(username, password, loading);

  const signInMutation = trpc.credentialAuth.signIn.useMutation({
    meta: locallyReportedErrorMeta,
  });

  const handleSignIn = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError("");
      setLoading(true);
      try {
        await signInMutation.mutateAsync({ providerId, username, password });
        onSuccess();
      } catch (err: unknown) {
        captureException(err, {
          operation: "credentialAuth.signIn",
          providerId,
        });
        setError(err instanceof Error ? err.message : "Sign in failed");
      } finally {
        setLoading(false);
      }
    },
    [providerId, username, password, signInMutation, onSuccess],
  );

  return (
    <ModalDialog
      open
      onClose={onClose}
      initialFocusRef={emailRef}
      contentClassName="bg-surface-solid border border-border-strong rounded-xl p-6 w-[calc(100%-2rem)] max-w-sm shadow-2xl"
    >
      <div className="flex items-center justify-between mb-4">
        <ModalDialogTitle className="text-sm font-semibold text-foreground">
          Connect {providerName}
        </ModalDialogTitle>
        <button
          type="button"
          onClick={onClose}
          className="text-subtle hover:text-foreground text-lg leading-none p-1"
          aria-label="Close"
        >
          &times;
        </button>
      </div>

      {description && (
        <div className="mb-3 text-xs text-amber-400 bg-amber-400/10 rounded px-3 py-2 leading-relaxed">
          {description}
        </div>
      )}

      {error && (
        <div role="alert" className="mb-3 text-xs text-red-400 bg-red-400/10 rounded px-3 py-2">
          {error}
        </div>
      )}

      <form onSubmit={handleSignIn} className="space-y-3">
        <div>
          <label htmlFor={`${providerId}-email`} className="block text-xs text-muted mb-1">
            Email
          </label>
          <input
            ref={emailRef}
            id={`${providerId}-email`}
            type="email"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label htmlFor={`${providerId}-password`} className="block text-xs text-muted mb-1">
            Password
          </label>
          <input
            id={`${providerId}-password`}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
          />
        </div>
        {signInHint ? (
          <p id={`${providerId}-auth-hint`} className="text-xs text-muted">
            {signInHint}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={signInDisabled}
          aria-describedby={signInHint ? `${providerId}-auth-hint` : undefined}
          className={authSubmitButtonClassName(signInDisabled)}
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>
    </ModalDialog>
  );
}

// -- Personal Token Auth Modal --

export function TokenAuthModal({
  providerId,
  providerName,
  tokenLabel,
  instructionsUrl,
  onClose,
  onSuccess,
}: {
  providerId: string;
  providerName: string;
  tokenLabel: string;
  instructionsUrl: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const tokenRef = useRef<HTMLInputElement>(null);
  const connectDisabled = loading || !token;
  const connectHint = !loading && !token ? "Enter your token to continue." : null;
  const connectMutation = trpc.tokenAuth.connect.useMutation({
    meta: locallyReportedErrorMeta,
  });
  const handleClose = useCallback(() => {
    if (!loading) onClose();
  }, [loading, onClose]);

  const handleConnect = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError("");
      setLoading(true);
      try {
        await connectMutation.mutateAsync({ providerId, token });
      } catch (caught: unknown) {
        captureException(caught, {
          operation: "tokenAuth.connect",
          providerId,
        });
        setError(caught instanceof Error ? caught.message : "Token connection failed");
        setLoading(false);
        return;
      }
      setLoading(false);
      onSuccess();
    },
    [connectMutation, onSuccess, providerId, token],
  );

  return (
    <ModalDialog
      open
      onClose={handleClose}
      initialFocusRef={tokenRef}
      contentClassName="bg-surface-solid border border-border-strong rounded-xl p-6 w-[calc(100%-2rem)] max-w-sm shadow-2xl"
    >
      <div className="flex items-center justify-between mb-4">
        <ModalDialogTitle className="text-sm font-semibold text-foreground">
          Connect {providerName}
        </ModalDialogTitle>
        <button
          type="button"
          onClick={handleClose}
          disabled={loading}
          className="text-subtle hover:text-foreground text-lg leading-none p-1"
          aria-label="Close"
        >
          &times;
        </button>
      </div>

      <p className="mb-3 text-xs text-muted">
        <a
          href={instructionsUrl}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          Create a {tokenLabel}
        </a>{" "}
        in {providerName}, then paste it below.
      </p>

      {error && (
        <div role="alert" className="mb-3 text-xs text-red-400 bg-red-400/10 rounded px-3 py-2">
          {error}
        </div>
      )}

      <form onSubmit={handleConnect} className="space-y-3">
        <div>
          <label htmlFor={`${providerId}-token`} className="block text-xs text-muted mb-1">
            {tokenLabel}
          </label>
          <input
            ref={tokenRef}
            id={`${providerId}-token`}
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required
            autoComplete="off"
            className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
          />
        </div>
        {connectHint ? (
          <p id={`${providerId}-token-auth-hint`} className="text-xs text-muted">
            {connectHint}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={connectDisabled}
          aria-describedby={connectHint ? `${providerId}-token-auth-hint` : undefined}
          className={authSubmitButtonClassName(connectDisabled)}
        >
          {loading ? "Connecting..." : "Connect"}
        </button>
      </form>
    </ModalDialog>
  );
}

// -- Garmin Auth Modal --

export function GarminAuthModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const signInDisabled = loading || !username.trim() || !password;
  const signInHint = credentialSubmitHint(username, password, loading);

  const signInMutation = trpc.garminAuth.signIn.useMutation({
    meta: locallyReportedErrorMeta,
  });

  const handleSignIn = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError("");
      setLoading(true);
      try {
        await signInMutation.mutateAsync({ username, password });
        onSuccess();
      } catch (err: unknown) {
        captureException(err, {
          operation: "garminAuth.signIn",
          providerId: "garmin",
        });
        setError(err instanceof Error ? err.message : "Sign in failed");
      } finally {
        setLoading(false);
      }
    },
    [username, password, signInMutation, onSuccess],
  );

  return (
    <ModalDialog
      open
      onClose={onClose}
      initialFocusRef={emailRef}
      contentClassName="bg-surface-solid border border-border-strong rounded-xl p-6 w-[calc(100%-2rem)] max-w-sm shadow-2xl"
    >
      <div className="flex items-center justify-between mb-4">
        <ModalDialogTitle className="text-sm font-semibold text-foreground">
          Connect Garmin
        </ModalDialogTitle>
        <button
          type="button"
          onClick={onClose}
          className="text-subtle hover:text-foreground text-lg leading-none p-1"
          aria-label="Close"
        >
          &times;
        </button>
      </div>

      {error && (
        <div className="mb-3 text-xs text-red-400 bg-red-400/10 rounded px-3 py-2">{error}</div>
      )}

      <form onSubmit={handleSignIn} className="space-y-3">
        <div>
          <label htmlFor="garmin-email" className="block text-xs text-muted mb-1">
            Email
          </label>
          <input
            ref={emailRef}
            id="garmin-email"
            type="email"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label htmlFor="garmin-password" className="block text-xs text-muted mb-1">
            Password
          </label>
          <input
            id="garmin-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
          />
        </div>
        {signInHint ? (
          <p id="garmin-auth-hint" className="text-xs text-muted">
            {signInHint}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={signInDisabled}
          aria-describedby={signInHint ? "garmin-auth-hint" : undefined}
          className={authSubmitButtonClassName(signInDisabled)}
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>
    </ModalDialog>
  );
}

// -- WHOOP Auth Modal --

type WhoopStep = "credentials" | "verify" | "saving";

export function WhoopAuthModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [step, setStep] = useState<WhoopStep>("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const credentialSignInDisabled = loading || !username.trim() || !password;
  const credentialSignInHint = credentialSubmitHint(username, password, loading);
  const verificationDisabled = loading || !code;
  const verificationHint = !loading && !code ? "Enter the verification code to continue." : null;

  useEffect(() => {
    if (step === "verify") codeRef.current?.focus();
  }, [step]);

  const signInMutation = trpc.whoopAuth.signIn.useMutation({
    meta: locallyReportedErrorMeta,
  });
  const verifyMutation = trpc.whoopAuth.verifyCode.useMutation({
    meta: locallyReportedErrorMeta,
  });
  const saveTokensMutation = trpc.whoopAuth.saveTokens.useMutation({
    meta: locallyReportedErrorMeta,
  });

  const handleSignIn = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError("");
      setLoading(true);
      let operation = "whoopAuth.signIn";
      try {
        const result = await signInMutation.mutateAsync({ username, password });
        if (result.status === "verification_required") {
          setChallengeId(result.challengeId);
          setStep("verify");
        } else if (result.status === "success" && result.token) {
          setStep("saving");
          operation = "whoopAuth.saveTokens";
          await saveTokensMutation.mutateAsync(result.token);
          onSuccess();
        }
      } catch (err: unknown) {
        captureException(err, { operation, providerId: "whoop" });
        setError(err instanceof Error ? err.message : "Sign in failed");
      } finally {
        setLoading(false);
      }
    },
    [username, password, signInMutation, saveTokensMutation, onSuccess],
  );

  const handleVerify = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError("");
      setLoading(true);
      let operation = "whoopAuth.verifyCode";
      try {
        const result = await verifyMutation.mutateAsync({ challengeId, code });
        if (result.status === "success") {
          setStep("saving");
          operation = "whoopAuth.saveTokens";
          await saveTokensMutation.mutateAsync(result.token);
          onSuccess();
        }
      } catch (err: unknown) {
        captureException(err, { operation, providerId: "whoop" });
        setError(err instanceof Error ? err.message : "Verification failed");
      } finally {
        setLoading(false);
      }
    },
    [challengeId, code, verifyMutation, saveTokensMutation, onSuccess],
  );

  return (
    <ModalDialog
      open
      onClose={onClose}
      initialFocusRef={emailRef}
      contentClassName="bg-surface-solid border border-border-strong rounded-xl p-6 w-[calc(100%-2rem)] max-w-sm shadow-2xl"
    >
      <div className="flex items-center justify-between mb-4">
        <ModalDialogTitle className="text-sm font-semibold text-foreground">
          Connect WHOOP
        </ModalDialogTitle>
        <button
          type="button"
          onClick={onClose}
          className="text-subtle hover:text-foreground text-lg leading-none p-1"
          aria-label="Close"
        >
          &times;
        </button>
      </div>

      {error && (
        <div className="mb-3 text-xs text-red-400 bg-red-400/10 rounded px-3 py-2">{error}</div>
      )}

      {step === "credentials" && (
        <form onSubmit={handleSignIn} className="space-y-3">
          <div>
            <label htmlFor="whoop-email" className="block text-xs text-muted mb-1">
              Email
            </label>
            <input
              ref={emailRef}
              id="whoop-email"
              type="email"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label htmlFor="whoop-password" className="block text-xs text-muted mb-1">
              Password
            </label>
            <input
              id="whoop-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
            />
          </div>
          {credentialSignInHint ? (
            <p id="whoop-credentials-auth-hint" className="text-xs text-muted">
              {credentialSignInHint}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={credentialSignInDisabled}
            aria-describedby={credentialSignInHint ? "whoop-credentials-auth-hint" : undefined}
            className={authSubmitButtonClassName(credentialSignInDisabled)}
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      )}

      {step === "verify" && (
        <form onSubmit={handleVerify} className="space-y-3">
          <p className="text-xs text-muted">
            WHOOP sent a verification code to your phone. Enter it below.
          </p>
          <div>
            <label htmlFor="whoop-code" className="block text-xs text-muted mb-1">
              Verification Code
            </label>
            <input
              ref={codeRef}
              id="whoop-code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              inputMode="numeric"
              pattern="[0-9]*"
              className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent text-center tracking-widest text-lg"
              placeholder="000000"
            />
          </div>
          {verificationHint ? (
            <p id="whoop-verification-auth-hint" className="text-xs text-muted">
              {verificationHint}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={verificationDisabled}
            aria-describedby={verificationHint ? "whoop-verification-auth-hint" : undefined}
            className={authSubmitButtonClassName(verificationDisabled)}
          >
            {loading ? "Verifying..." : "Verify"}
          </button>
        </form>
      )}

      {step === "saving" && (
        <div className="text-center py-4">
          <div className="text-sm text-foreground">Saving credentials...</div>
        </div>
      )}
    </ModalDialog>
  );
}
