interface ProviderDisconnectControlProps {
  canDisconnect: boolean;
  showConfirm: boolean;
  isPending?: boolean;
  onOpenConfirm: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ProviderDisconnectControl({
  canDisconnect,
  showConfirm,
  isPending = false,
  onOpenConfirm,
  onConfirm,
  onCancel,
}: ProviderDisconnectControlProps) {
  if (!canDisconnect) return null;

  if (showConfirm) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">Are you sure?</span>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isPending}
          className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
        >
          {isPending ? "Disconnecting..." : "Confirm"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover transition-colors"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpenConfirm}
      className="px-3 py-1.5 text-xs rounded bg-accent/10 text-red-400 hover:bg-surface-hover transition-colors"
    >
      Disconnect
    </button>
  );
}
