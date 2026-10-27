interface PaginationControlsProps {
  page: number;
  pageSize: number;
  totalItems: number;
  itemLabel: string;
  onPageChange: (page: number) => void;
  className?: string;
}

export function PaginationControls({
  page,
  pageSize,
  totalItems,
  itemLabel,
  onPageChange,
  className = "",
}: PaginationControlsProps) {
  const totalPages = Math.ceil(totalItems / pageSize);
  if (totalPages <= 1) return null;

  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);

  return (
    <nav
      aria-label={`${itemLabel} pagination`}
      className={`flex items-center justify-between gap-3 border-t border-border/50 pt-3 ${className}`}
    >
      <span className="text-xs text-subtle tabular-nums">
        {totalItems.toLocaleString()} {itemLabel}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 0}
          aria-label={`Previous ${itemLabel} page`}
          className="cursor-pointer rounded border border-border-strong px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-30"
        >
          Previous
        </button>
        <span className="text-xs text-subtle tabular-nums">
          {currentPage + 1} / {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages - 1}
          aria-label={`Next ${itemLabel} page`}
          className="cursor-pointer rounded border border-border-strong px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-30"
        >
          Next
        </button>
      </div>
    </nav>
  );
}
