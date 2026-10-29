import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import { activitySourceTreeWithHardware } from "@dofek/providers/activity-source-hardware";
import {
  type ActivitySourceTree,
  type ActivitySourceTreeNode,
  activitySourceNodePresentation,
} from "@dofek/providers/activity-source-tree";
import { type ReactNode, useId, useState } from "react";
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
  const { primary, otherSources } = activitySourceTreeWithHardware(
    tree,
    hardware ?? EMPTY_HARDWARE,
  );
  if (!primary && otherSources.length === 0 && !hardwareLoading && !hardwareError)
    return <>{heading}</>;

  return (
    <div
      className={
        heading
          ? "relative z-20 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 text-sm"
          : "relative z-20 min-w-0 border-t border-border/60 text-sm"
      }
    >
      {heading}
      <button
        type="button"
        aria-label={primary ? `${primary.label} Sources` : "Sources"}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((current) => !current)}
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
          Sources
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
      <div id={contentId} hidden={!expanded} className="col-span-full">
        {expanded ? (
          <div className="px-4 pb-4 sm:px-5">
            {!hardware && hardwareLoading && !hardwareError ? (
              <QueryStatePanel variant="loading" contextLabel="Device details" height={72} />
            ) : null}
            {primary ? (
              <>
                {primary.description ? (
                  <p className="ml-[26px] text-xs text-muted [overflow-wrap:anywhere]">
                    {primary.description}
                  </p>
                ) : null}
                {primary.url ? (
                  <a
                    href={primary.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`View activity for ${primary.label}`}
                    className="ml-[26px] mt-1 inline-block text-xs text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    View activity ↗
                  </a>
                ) : null}
                <SourceNodeDetails node={primary} />
                <SourceTreeNodes nodes={primary.children} connected />
              </>
            ) : null}
            {otherSources.length > 0 ? (
              <section
                aria-label="Additional sources"
                className={primary ? "mt-4 border-t border-border/60 pt-3" : ""}
              >
                <SourceTreeNodes nodes={otherSources} />
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SourceNodeDetails({ node }: { node: ActivitySourceTreeNode }) {
  if (!node.details?.length) return null;
  return (
    <dl className="ml-[26px] mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs text-muted [overflow-wrap:anywhere]">
      {node.details.map((detail) => (
        <div className="contents" key={detail.label}>
          <dt>{detail.label}</dt>
          <dd>{detail.value}</dd>
        </div>
      ))}
    </dl>
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
              ? "relative pt-3 before:absolute before:-left-4 before:top-[23px] before:w-3 before:border-t before:border-border"
              : ""
          }
        >
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
          <SourceNodeDetails node={node} />
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
