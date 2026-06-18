import { useEffect, useRef, useState } from "react";

export type ActivityExportFormat = "gpx" | "tcx" | "csv" | "fit";

const EXPORT_OPTIONS: Array<{
  format: ActivityExportFormat;
  label: string;
  requiresGps: boolean;
}> = [
  { format: "gpx", label: "GPX", requiresGps: true },
  { format: "tcx", label: "TCX", requiresGps: true },
  { format: "csv", label: "CSV", requiresGps: false },
  { format: "fit", label: "FIT", requiresGps: false },
];

interface ActivityExportDropdownProps {
  activityId: string;
  hasGps: boolean;
}

export function ActivityExportDropdown({ activityId, hasGps }: ActivityExportDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const handleExport = (format: ActivityExportFormat) => {
    window.location.assign(`/api/activity/${activityId}/export?format=${format}`);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover transition-colors cursor-pointer"
      >
        Export
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Export activity"
          className="absolute right-0 z-20 mt-1 min-w-[8rem] rounded-md border border-border bg-surface py-1 shadow-lg"
        >
          {EXPORT_OPTIONS.map(({ format, label, requiresGps }) => {
            const disabled = requiresGps && !hasGps;
            return (
              <button
                key={format}
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={() => handleExport(format)}
                className="block w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-surface-hover disabled:text-muted disabled:hover:bg-transparent disabled:cursor-not-allowed cursor-pointer"
                title={
                  disabled ? "This activity has no GPS track points for this format." : undefined
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
