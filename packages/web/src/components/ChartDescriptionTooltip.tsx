import { useId, useState } from "react";
import { ModalDialog, ModalDialogDescription, ModalDialogTitle } from "./ModalDialog.tsx";

interface ChartDescriptionTooltipProps {
  description: string;
  className?: string;
}

export function ChartDescriptionTooltip({ description, className }: ChartDescriptionTooltipProps) {
  const descriptionId = useId();
  const [open, setOpen] = useState(false);

  return (
    <span className={`inline-flex ${className ?? ""}`}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label="About this chart"
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border-strong px-2 text-xs font-semibold text-muted transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-solid"
        onClick={() => setOpen(true)}
      >
        About
      </button>
      <ModalDialog
        ariaDescribedBy={descriptionId}
        open={open}
        onClose={() => setOpen(false)}
        closeOnInteractOutside
        contentClassName="w-[calc(100vw-2rem)] max-w-sm rounded-lg border border-border-strong bg-surface-solid p-5 shadow-xl"
      >
        <ModalDialogTitle className="text-base font-semibold text-foreground">
          About this chart
        </ModalDialogTitle>
        <ModalDialogDescription
          id={descriptionId}
          className="mt-2 text-sm leading-relaxed text-muted"
        >
          {description}
        </ModalDialogDescription>
        <button
          type="button"
          aria-label="Close chart explanation"
          className="mt-4 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border-strong px-4 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-solid"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </ModalDialog>
    </span>
  );
}
