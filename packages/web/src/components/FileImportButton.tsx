export function FileImportButton({
  disabled = false,
  onClick,
}: {
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-1.5 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
    >
      Import file
    </button>
  );
}
