import {
  getNewPasswordValidationError,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENT_TEXT,
} from "@dofek/auth/auth";
import { useState } from "react";
import { useAuth } from "../lib/auth-context.tsx";
import { trpc } from "../lib/trpc.ts";
import { PasswordInput } from "./PasswordInput.tsx";

const CURRENT_PASSWORD_REQUIRED_ERROR = "Enter your current password.";

export function PasswordSettingsPanel() {
  const auth = useAuth();
  const utils = trpc.useUtils();
  const status = trpc.auth.passwordCredentialStatus.useQuery();
  const setPassword = trpc.auth.setPassword.useMutation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const hasPassword = status.data?.hasPassword ?? false;
  const currentPasswordError = localError === CURRENT_PASSWORD_REQUIRED_ERROR;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);
    setSuccess(null);
    if (hasPassword && !currentPassword) {
      setLocalError(CURRENT_PASSWORD_REQUIRED_ERROR);
      return;
    }
    const passwordError = getNewPasswordValidationError(newPassword);
    if (passwordError) {
      setLocalError(passwordError);
      return;
    }
    if (newPassword !== confirmPassword) {
      setLocalError("Passwords do not match");
      return;
    }
    await setPassword.mutateAsync(
      {
        currentPassword: hasPassword ? currentPassword : undefined,
        newPassword,
      },
      {
        onSuccess: async () => {
          setCurrentPassword("");
          setNewPassword("");
          setConfirmPassword("");
          if (hasPassword) {
            await auth.logout();
            return;
          }
          setSuccess("Password set.");
          await utils.auth.passwordCredentialStatus.invalidate();
        },
      },
    );
  }

  if (status.isLoading) {
    return <p className="text-sm text-subtle">Loading password status...</p>;
  }

  if (status.error) {
    return <p className="text-sm text-red-400">{status.error.message}</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 max-w-md" noValidate>
      {hasPassword ? (
        <div>
          <label htmlFor="current-password" className="block text-xs text-muted mb-1">
            Current password
          </label>
          <PasswordInput
            id="current-password"
            visibilityLabel="current password"
            value={currentPassword}
            onChange={(event) => {
              setCurrentPassword(event.target.value);
              setLocalError(null);
            }}
            required
            autoComplete="current-password"
            aria-invalid={currentPasswordError ? true : undefined}
            aria-describedby={currentPasswordError ? "password-form-message" : undefined}
            className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
          />
        </div>
      ) : null}
      <div>
        <label htmlFor="new-password" className="block text-xs text-muted mb-1">
          New password
        </label>
        <PasswordInput
          id="new-password"
          visibilityLabel="new password"
          value={newPassword}
          onChange={(event) => {
            setNewPassword(event.target.value);
            setLocalError(null);
          }}
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="new-password"
          aria-invalid={localError && !currentPasswordError ? true : undefined}
          aria-describedby="password-form-message"
          className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
        />
      </div>
      <div>
        <label htmlFor="confirm-password" className="block text-xs text-muted mb-1">
          Confirm password
        </label>
        <PasswordInput
          id="confirm-password"
          visibilityLabel="confirm password"
          value={confirmPassword}
          onChange={(event) => {
            setConfirmPassword(event.target.value);
            setLocalError(null);
          }}
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="new-password"
          aria-invalid={localError && !currentPasswordError ? true : undefined}
          aria-describedby={
            localError && !currentPasswordError ? "password-form-message" : undefined
          }
          className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
        />
      </div>
      {localError ? (
        <p id="password-form-message" role="alert" className="text-xs text-red-400">
          {localError}
        </p>
      ) : (
        <p id="password-form-message" className="text-xs text-subtle">
          {PASSWORD_REQUIREMENT_TEXT}
        </p>
      )}
      {setPassword.error ? (
        <p className="text-xs text-red-400">{setPassword.error.message}</p>
      ) : null}
      {success ? <p className="text-xs text-accent">{success}</p> : null}
      <button
        type="submit"
        disabled={setPassword.isPending}
        className="px-3 py-2 rounded bg-accent text-on-accent hover:bg-accent/90 disabled:opacity-50 transition-colors cursor-pointer"
      >
        {setPassword.isPending
          ? hasPassword
            ? "Changing password..."
            : "Setting password..."
          : hasPassword
            ? "Change password"
            : "Set password"}
      </button>
    </form>
  );
}
