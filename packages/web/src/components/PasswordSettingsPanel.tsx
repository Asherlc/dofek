import { useState } from "react";
import { useAuth } from "../lib/auth-context.tsx";
import { trpc } from "../lib/trpc.ts";

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

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);
    setSuccess(null);
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
    <form onSubmit={handleSubmit} className="space-y-3 max-w-md">
      {hasPassword ? (
        <div>
          <label htmlFor="current-password" className="block text-xs text-muted mb-1">
            Current password
          </label>
          <input
            id="current-password"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
            autoComplete="current-password"
            className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
          />
        </div>
      ) : null}
      <div>
        <label htmlFor="new-password" className="block text-xs text-muted mb-1">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
        />
      </div>
      <div>
        <label htmlFor="confirm-password" className="block text-xs text-muted mb-1">
          Confirm password
        </label>
        <input
          id="confirm-password"
          type="password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
        />
      </div>
      {localError ? <p className="text-xs text-red-400">{localError}</p> : null}
      {setPassword.error ? (
        <p className="text-xs text-red-400">{setPassword.error.message}</p>
      ) : null}
      {success ? <p className="text-xs text-accent">{success}</p> : null}
      <button
        type="submit"
        disabled={setPassword.isPending}
        className="px-3 py-2 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors cursor-pointer"
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
