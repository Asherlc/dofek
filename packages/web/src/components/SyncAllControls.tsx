import { SYNC_ALL_ACTIONS } from "@dofek/providers/sync-actions";
import { useRef, useState } from "react";
import { ModalDialog, ModalDialogDescription, ModalDialogTitle } from "./ModalDialog.tsx";

export interface SyncAllControlsProps {
  busy: boolean;
  errorMessage?: string;
  onFullSync: () => void;
  onRecentSync: () => void;
}

export function SyncAllControls({
  busy,
  errorMessage,
  onFullSync,
  onRecentSync,
}: SyncAllControlsProps) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <section aria-label="Sync all providers" className="space-y-2">
      <div className="flex flex-col items-start gap-1 sm:items-end">
        <button
          type="button"
          onClick={onRecentSync}
          disabled={busy}
          aria-label={SYNC_ALL_ACTIONS.recent.accessibilityLabel}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Syncing…" : SYNC_ALL_ACTIONS.recent.label}
        </button>
        <p className="text-xs text-muted">{SYNC_ALL_ACTIONS.recent.description}</p>
        <button
          type="button"
          onClick={() => setConfirmationOpen(true)}
          disabled={busy}
          aria-label={SYNC_ALL_ACTIONS.full.accessibilityLabel}
          className="text-xs font-medium text-accent underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          {SYNC_ALL_ACTIONS.full.label}
        </button>
      </div>

      {busy ? (
        <output aria-live="polite" className="block text-xs text-muted">
          {SYNC_ALL_ACTIONS.progressMessage}
        </output>
      ) : null}
      {errorMessage ? (
        <p role="alert" className="text-xs text-red-400">
          {errorMessage}
        </p>
      ) : null}

      <ModalDialog
        open={confirmationOpen}
        onClose={() => setConfirmationOpen(false)}
        initialFocusRef={cancelRef}
        contentClassName="w-[calc(100%-2rem)] max-w-md rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <ModalDialogTitle className="text-base font-semibold text-foreground">
          {SYNC_ALL_ACTIONS.full.confirmationTitle}
        </ModalDialogTitle>
        <ModalDialogDescription className="mt-2 text-sm leading-6 text-muted">
          {SYNC_ALL_ACTIONS.full.confirmationDescription}
        </ModalDialogDescription>
        <div className="mt-5 flex justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => setConfirmationOpen(false)}
            className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-hover"
          >
            {SYNC_ALL_ACTIONS.full.cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmationOpen(false);
              onFullSync();
            }}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent/90"
          >
            {SYNC_ALL_ACTIONS.full.confirmLabel}
          </button>
        </div>
      </ModalDialog>
    </section>
  );
}
