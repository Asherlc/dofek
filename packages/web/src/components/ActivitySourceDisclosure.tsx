import type { ActivityOrigin } from "@dofek/providers/activity-origin";
import { activitySourceDetails } from "@dofek/providers/activity-source-details";
import * as Popover from "@radix-ui/react-popover";
import { ProviderLogo } from "./ProviderLogo.tsx";

export function ActivitySourceDisclosure({ origin }: { origin: ActivityOrigin }) {
  const details = activitySourceDetails(origin);
  if (!details) return null;

  return (
    <Popover.Root>
      <Popover.Trigger
        type="button"
        aria-label={`Activity source: ${details.recordingApp.label}`}
        className="relative z-20 inline-flex min-h-8 items-center gap-1 rounded border border-border px-1.5 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-accent"
      >
        <ProviderLogo provider={details.recordingApp.provider} size={18} />
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path
            d="m2 3.5 3 3 3-3"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label="Activity source"
          sideOffset={6}
          align="start"
          collisionPadding={12}
          className="z-50 w-64 max-w-[calc(100vw-24px)] rounded-lg border border-border bg-surface-solid p-4 text-foreground shadow-lg"
        >
          <dl className="space-y-3">
            <div>
              <dt className="text-xs text-muted">Recorded in</dt>
              <dd className="mt-1 flex items-center gap-2 text-sm font-medium">
                <ProviderLogo provider={details.recordingApp.provider} />
                {details.recordingApp.label}
              </dd>
            </div>
            {details.importedVia ? (
              <div>
                <dt className="text-xs text-muted">Imported via</dt>
                <dd className="mt-1 flex items-center gap-2 text-sm font-medium">
                  <ProviderLogo provider={details.importedVia.provider} />
                  {details.importedVia.label}
                </dd>
              </div>
            ) : null}
          </dl>
          <Popover.Close
            type="button"
            aria-label="Close activity source"
            className="absolute right-2 top-2 rounded px-2 py-1 text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span aria-hidden="true">×</span>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
