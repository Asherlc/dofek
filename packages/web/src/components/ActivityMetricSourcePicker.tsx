import type { ActivityMetricSource } from "@dofek/providers/activity-metric-source";
import { providerSourceLogo } from "@dofek/providers/providers";
import * as Popover from "@radix-ui/react-popover";
import { useId, useRef, useState } from "react";
import { ProviderLogo } from "./ProviderLogo.tsx";

interface ActivityMetricSourcePickerProps {
  label: string;
  sources: ActivityMetricSource[];
  selectedId: string;
  onChange: (sourceId: string) => void;
  className?: string;
}

export function AttributionIcon({
  attribution,
}: {
  attribution: ActivityMetricSource["presentation"]["attribution"];
}) {
  if (!attribution) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center text-muted"
      title={attribution.label}
      aria-hidden="true"
    >
      {attribution.kind === "apple_health" ? (
        <ProviderLogo provider="apple_health" size={14} />
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {attribution.kind === "cloud" ? (
            <path d="M6 19a4.5 4.5 0 0 1-.6-9A6.5 6.5 0 0 1 18 8.5 5.25 5.25 0 0 1 18.5 19H6Z" />
          ) : (
            <path d="m7 7 10 10-5 4V3l5 4L7 17" />
          )}
        </svg>
      )}
    </span>
  );
}

export function ActivityMetricSourcePicker({
  label,
  sources,
  selectedId,
  onChange,
  className = "rounded-lg border border-border px-3",
}: ActivityMetricSourcePickerProps) {
  const [open, setOpen] = useState(false);
  const groupId = useId();
  const selectedRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLInputElement | null>>([]);
  const selected = sources.find((source) => source.id === selectedId);
  if (!selected) return null;
  const { presentation } = selected;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${label} source: ${selected.label}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={`inline-flex min-h-11 min-w-0 max-w-full items-center gap-2 bg-transparent py-2 text-xs text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 ${className}`}
        >
          <ProviderLogo
            provider={providerSourceLogo(presentation.providerId, presentation.sourceName).provider}
            sourceName={presentation.sourceName}
            size={19}
          />
          <span className="min-w-0 truncate font-medium">{presentation.displayName}</span>
          <AttributionIcon attribution={presentation.attribution} />
          <svg
            className="ml-1 shrink-0 text-muted"
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path d="m3 4.5 3 3 3-3" />
          </svg>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label={`${label} source`}
          align="start"
          sideOffset={6}
          collisionPadding={16}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            selectedRef.current?.focus();
          }}
          className="z-50 w-80 max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-xl border border-border bg-surface p-2 text-foreground shadow-xl"
        >
          <fieldset className="space-y-1">
            <legend className="sr-only">Available recordings</legend>
            {sources.map((source, index) => (
              <label
                key={source.id}
                title={source.label}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover focus-within:outline-2 focus-within:outline-offset-2"
              >
                <ProviderLogo
                  provider={
                    providerSourceLogo(
                      source.presentation.providerId,
                      source.presentation.sourceName,
                    ).provider
                  }
                  sourceName={source.presentation.sourceName}
                  size={22}
                />
                <span className="min-w-0 flex-1 break-words text-sm font-medium">
                  {source.presentation.displayName}
                </span>
                <AttributionIcon attribution={source.presentation.attribution} />
                <input
                  aria-label={source.label}
                  ref={(element) => {
                    optionRefs.current[index] = element;
                    if (source.id === selectedId) selectedRef.current = element;
                  }}
                  type="radio"
                  name={groupId}
                  value={source.id}
                  checked={source.id === selectedId}
                  onChange={() => {
                    onChange(source.id);
                    setOpen(false);
                  }}
                  onKeyDown={(event) => {
                    const direction = ["ArrowDown", "ArrowRight"].includes(event.key)
                      ? 1
                      : ["ArrowUp", "ArrowLeft"].includes(event.key)
                        ? -1
                        : 0;
                    if (direction) {
                      event.preventDefault();
                      const nextIndex = (index + direction + sources.length) % sources.length;
                      const nextSource = sources[nextIndex];
                      if (nextSource) {
                        onChange(nextSource.id);
                        optionRefs.current[nextIndex]?.focus();
                      }
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      setOpen(false);
                    }
                  }}
                  className="shrink-0 accent-accent"
                />
              </label>
            ))}
          </fieldset>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
