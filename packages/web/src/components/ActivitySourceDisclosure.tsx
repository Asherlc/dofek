import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import { activitySourceTreeWithHardware } from "@dofek/providers/activity-source-hardware";
import {
  type ActivitySourceTree,
  type ActivitySourceTreeNode,
  activitySourceNodePresentation,
} from "@dofek/providers/activity-source-tree";
import * as Popover from "@radix-ui/react-popover";
import { type ReactNode, useId, useRef, useState } from "react";
import { AttributionIcon } from "./ActivityMetricSourcePicker.tsx";
import { ProviderLogo } from "./ProviderLogo.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

const EMPTY_HARDWARE: ActivityHardware = { items: [], power: [] };

interface Props {
  tree: ActivitySourceTree;
  heading?: ReactNode;
  hardware?: ActivityHardware;
  hardwareLoading?: boolean;
  hardwareError?: unknown;
  onRetryHardware?: () => void;
}

export function ActivitySourceDisclosure({
  tree,
  heading,
  hardware,
  hardwareLoading = false,
  hardwareError,
  onRetryHardware,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { primary, otherSources } = activitySourceTreeWithHardware(
    tree,
    hardware ?? EMPTY_HARDWARE,
  );
  if (!primary && otherSources.length === 0 && !hardwareLoading && !hardwareError)
    return <>{heading}</>;

  const trigger = (
    <button
      type="button"
      ref={triggerRef}
      aria-label={primary ? `${primary.label} Lineage` : "Lineage"}
      aria-expanded={expanded}
      aria-controls={contentId}
      onClick={heading ? undefined : () => setExpanded((current) => !current)}
      className={
        heading
          ? "flex min-h-8 max-w-64 items-center gap-2 rounded px-2 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-accent"
          : "flex min-h-12 w-full items-center gap-2 px-4 py-3 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent sm:px-5"
      }
    >
      {primary ? (
        <>
          <ProviderLogo provider={primary.providerId} sourceName={primary.sourceName} size={18} />
          <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
            <SourceLabel node={primary} />
          </span>
        </>
      ) : null}
      <span className={primary ? "ml-auto shrink-0 text-xs text-muted" : "flex-1 font-medium"}>
        Lineage
      </span>
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        aria-hidden="true"
        className={expanded ? "shrink-0 rotate-180 text-muted" : "shrink-0 text-muted"}
      >
        <path
          d="m3 4.5 3 3 3-3"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
  const details = (
    <div className="px-4 pb-4 sm:px-5">
      {!hardware && hardwareLoading && !hardwareError ? (
        <QueryStatePanel variant="loading" contextLabel="Device details" height={72} />
      ) : null}
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Lineage</h2>
        <button
          type="button"
          aria-label="Close lineage"
          onClick={() => {
            setExpanded(false);
            triggerRef.current?.focus();
          }}
          className="flex size-8 items-center justify-center rounded text-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {primary ? (
        <section aria-label="Original">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
            Original
          </h3>
          <SourceTreeNodes nodes={[primary]} />
        </section>
      ) : (
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
          Original unknown
        </h3>
      )}
      {otherSources.length > 0 ? (
        <section
          aria-label={primary ? "Other" : "Available recordings"}
          className={primary ? "mt-4 border-t border-border/60 pt-3" : ""}
        >
          {primary ? (
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
              Other
            </h3>
          ) : null}
          <SourceTreeNodes nodes={otherSources} />
        </section>
      ) : null}
    </div>
  );

  return (
    <Popover.Root open={expanded} onOpenChange={setExpanded}>
      <div
        className={
          heading
            ? "relative z-20 grid min-w-0 grid-cols-1 items-start gap-x-3 gap-y-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto]"
            : "relative z-20 min-w-0 border-t border-border/60 text-sm"
        }
      >
        {heading}
        {heading ? <Popover.Trigger asChild>{trigger}</Popover.Trigger> : trigger}
        {hardwareError ? (
          <div className="col-span-full">
            <QueryStatePanel
              contextLabel="Device details"
              error={hardwareError}
              onRetry={onRetryHardware}
              height={72}
            />
          </div>
        ) : null}
        {heading ? (
          <Popover.Portal>
            <Popover.Content
              id={contentId}
              aria-label="Lineage"
              align="end"
              sideOffset={6}
              collisionPadding={16}
              className="z-50 w-96 max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-xl border border-border bg-surface-solid pt-4 text-sm text-foreground shadow-xl"
            >
              {details}
            </Popover.Content>
          </Popover.Portal>
        ) : (
          <div id={contentId} hidden={!expanded}>
            {expanded ? details : null}
          </div>
        )}
      </div>
    </Popover.Root>
  );
}

function SourceTreeNodes({
  nodes,
  connected = false,
}: {
  nodes: ActivitySourceTreeNode[];
  connected?: boolean;
}) {
  if (nodes.length === 0) return null;
  return (
    <ul className={connected ? "ml-2 border-l border-border pl-4" : "space-y-3"}>
      {nodes.map((node) => (
        <li
          key={node.id}
          className={
            connected
              ? "relative pt-3 before:absolute before:-left-4 before:top-[20px] before:w-3 before:border-t before:border-border"
              : ""
          }
        >
          {connected ? <p className="mb-1 text-xs text-accent">Shared to</p> : null}
          <div className="flex min-w-0 items-center gap-2">
            <ProviderLogo provider={node.providerId} sourceName={node.sourceName} size={18} />
            {node.url ? (
              <a
                href={node.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 font-medium text-accent [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-accent"
              >
                <SourceLabel node={node} />
              </a>
            ) : (
              <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
                <SourceLabel node={node} />
              </span>
            )}
          </div>
          {node.description ? (
            <p className="ml-[26px] mt-0.5 text-xs text-muted [overflow-wrap:anywhere]">
              {node.description}
            </p>
          ) : null}
          <SourceTreeNodes nodes={node.children} connected />
        </li>
      ))}
    </ul>
  );
}

function SourceLabel({ node }: { node: ActivitySourceTreeNode }) {
  const { displayName, attribution } = activitySourceNodePresentation(node);
  if (!attribution) return <>{displayName}</>;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span aria-hidden="true">{displayName}</span>
      <span className="sr-only">{node.label}</span>
      <AttributionIcon attribution={attribution} />
    </span>
  );
}
