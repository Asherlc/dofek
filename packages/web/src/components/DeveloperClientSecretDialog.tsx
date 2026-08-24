import type { DeveloperClientSecret } from "@dofek/auth/developer-clients";
import { useState } from "react";
import { captureException } from "../lib/telemetry.ts";
import { ModalDialog, ModalDialogDescription, ModalDialogTitle } from "./ModalDialog.tsx";

interface DeveloperClientSecretDialogProps {
  onDismiss: () => void;
  secret: DeveloperClientSecret | null;
}

export function DeveloperClientSecretDialog({
  onDismiss,
  secret,
}: DeveloperClientSecretDialogProps) {
  const [copyError, setCopyError] = useState<string | null>(null);

  async function copy(value: string): Promise<void> {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(value);
    } catch (error: unknown) {
      captureException(error, { source: "developer-client-copy" });
      setCopyError("Copy failed. Select and copy the value manually.");
    }
  }

  return (
    <ModalDialog
      open={secret !== null}
      onClose={onDismiss}
      contentClassName="w-[calc(100%-2rem)] max-w-lg rounded-xl border border-border bg-surface-solid p-6 shadow-2xl"
    >
      <ModalDialogTitle className="text-lg font-semibold text-foreground">
        Save your developer credential
      </ModalDialogTitle>
      <ModalDialogDescription className="mt-2 text-sm text-muted">
        This secret is shown only once and cannot be recovered. Store it securely before closing.
      </ModalDialogDescription>

      {secret ? (
        <div className="mt-5 space-y-4">
          <div className="space-y-1">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">Client ID</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 select-all overflow-x-auto rounded bg-background p-2 text-sm text-foreground">
                {secret.client.clientId}
              </code>
              <button
                type="button"
                onClick={() => void copy(secret.client.clientId)}
                aria-label="Copy client ID"
                className="rounded border border-border px-3 py-2 text-sm text-foreground"
              >
                Copy
              </button>
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">
              Client secret
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 select-all overflow-x-auto rounded bg-background p-2 text-sm text-foreground">
                {secret.clientSecret}
              </code>
              <button
                type="button"
                onClick={() => void copy(secret.clientSecret)}
                aria-label="Copy client secret"
                className="rounded border border-border px-3 py-2 text-sm text-foreground"
              >
                Copy
              </button>
            </div>
          </div>
          {copyError ? (
            <p role="alert" className="text-sm text-red-400">
              {copyError}
            </p>
          ) : null}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onDismiss}
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent"
            >
              I saved the secret
            </button>
          </div>
        </div>
      ) : null}
    </ModalDialog>
  );
}
