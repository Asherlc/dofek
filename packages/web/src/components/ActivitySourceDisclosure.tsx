import type {
  ActivitySourceTree,
  ActivitySourceTreeNode,
} from "@dofek/providers/activity-source-tree";
import { useId, useState } from "react";
import { ProviderLogo } from "./ProviderLogo.tsx";

export function ActivitySourceDisclosure({ tree }: { tree: ActivitySourceTree }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const othersId = useId();
  const { primary, otherSources } = tree;

  return (
    <div className="relative z-20 min-w-0 border-t border-border/60 text-sm">
      <button
        type="button"
        aria-label={primary ? `${primary.label} Sources` : "Sources"}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((current) => !current)}
        className="flex min-h-12 w-full items-center gap-2 px-4 py-3 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent sm:px-5"
      >
        {primary ? (
          <>
            <ProviderLogo provider={primary.providerId} size={18} />
            <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
              {primary.label}
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
      <div id={contentId} hidden={!expanded}>
        {expanded ? (
          <div className="px-4 pb-4 sm:px-5">
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
                    aria-label={`View ${primary.label} activity`}
                    className="ml-[26px] mt-1 inline-block text-xs text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    View activity ↗
                  </a>
                ) : null}
                <SourceTreeNodes nodes={primary.children} connected />
              </>
            ) : null}
            {otherSources.length > 0 ? (
              <section
                aria-labelledby={othersId}
                className={primary ? "mt-4 border-t border-border/60 pt-3" : ""}
              >
                <p id={othersId} className="mb-2 text-xs font-medium text-muted">
                  Other matching sources
                </p>
                <SourceTreeNodes nodes={otherSources} />
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
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
            <ProviderLogo provider={node.providerId} size={18} />
            {node.url ? (
              <a
                href={node.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 font-medium text-accent [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {node.label}
              </a>
            ) : (
              <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{node.label}</span>
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
