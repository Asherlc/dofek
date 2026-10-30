import { providerLabel } from "@dofek/providers/providers";
import type { ClimbingCatalogueContext as Context } from "@dofek/training/climbing-catalogue";
import {
  climbingCatalogueConfidenceLabel,
  climbingCatalogueTagLabel,
} from "@dofek/training/climbing-catalogue";
import { useEffect, useId, useState } from "react";
import { trpc } from "../lib/trpc";

type Props = {
  context?: Context;
  open: boolean;
  onToggle: () => void;
  onRefresh: () => void;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | null;
};

export function ClimbingCatalogueContextView({
  context,
  open,
  onToggle,
  onRefresh,
  loading,
  refreshing,
  error,
}: Props) {
  const contentId = useId();
  const message = error ?? context?.error;
  const pending = refreshing || (context?.status === "pending" && !message);
  return (
    <section className="border-t border-border pt-3 text-xs">
      <button
        type="button"
        className="min-h-11 font-medium text-foreground"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={onToggle}
      >
        Catalogue context
      </button>
      {open && (
        <div id={contentId} className="space-y-3">
          <p className="text-subtle">Cached reference information</p>
          {context?.fetchedAt && (
            <p className="text-subtle">Fetched {new Date(context.fetchedAt).toLocaleString()}</p>
          )}
          {message && (
            <p role="alert" className="text-red-500">
              {message}
            </p>
          )}
          {loading && !context && <p role="status">Loading catalogue context…</p>}
          {context?.sources.map((source) => (
            <div key={source.providerId} className="space-y-2">
              <h5 className="font-medium">{providerLabel(source.providerId)}</h5>
              {source.searchArea && (
                <p className="text-subtle">Search area: {source.searchArea.name}</p>
              )}
              {!source.searchComplete && (
                <p className="text-subtle">Search incomplete; more candidates may exist.</p>
              )}
              {source.matches.map(({ candidate, confidence, evidence }) => (
                <div key={candidate.externalId} className="space-y-1">
                  <p className="text-subtle">{climbingCatalogueConfidenceLabel(confidence)}</p>
                  {evidence?.map((reason) => (
                    <p key={reason} className="text-subtle">
                      {reason}
                    </p>
                  ))}
                  <a
                    className="text-accent underline"
                    href={candidate.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {candidate.name}
                  </a>
                  {candidate.locations.length > 0 && (
                    <p className="text-subtle">
                      {candidate.locations.map((location) => location.name).join(" › ")}
                    </p>
                  )}
                  {candidate.grade && <p>Catalogue grade: {candidate.grade}</p>}
                  {candidate.tags.map((tag) => (
                    <p
                      key={`${tag.sourceKey}:${tag.category}:${tag.label}:${tag.scope}:${tag.inheritedFrom}`}
                    >
                      {climbingCatalogueTagLabel(tag)}
                    </p>
                  ))}
                  {candidate.angle && (
                    <p>
                      Source angle: {candidate.angle.value}
                      {candidate.angle.unit === "degrees" ? "°" : " (units not supplied)"}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ))}
          {context?.status === "ready" &&
            context.sources.every((source) => source.matches.length === 0) && (
              <p>No catalogue candidates to display.</p>
            )}
          {pending ? (
            <p role="status">Looking up catalogue info…</p>
          ) : (
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="min-h-11 text-accent underline"
            >
              {context && context.status !== "missing"
                ? "Refresh catalogue info"
                : "Find catalogue info"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function OpenCatalogueContext({ id, onToggle }: { id: string; onToggle: () => void }) {
  const utils = trpc.useUtils();
  const query = trpc.climbing.catalogueContext.useQuery(
    { id },
    {
      enabled: true,
      staleTime: 0,
      refetchInterval: (query) =>
        query.state.data?.status === "pending" && !query.state.error ? 1500 : false,
    },
  );
  const [now, setNow] = useState(Date.now);
  const authorizationError = [
    "NOT_FOUND",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "PRECONDITION_FAILED",
  ].includes(query.error?.data?.code ?? "");
  const canDisplay = query.isFetchedAfterMount && !authorizationError;
  const expiresAt = query.data?.expiresAt;
  useEffect(() => {
    if (!canDisplay || !expiresAt) return;
    const remaining = Date.parse(expiresAt) - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => {
      setNow(Date.now());
      void query.refetch();
    }, remaining);
    return () => clearTimeout(timer);
  }, [canDisplay, expiresAt, query.refetch]);
  const expired = expiresAt != null && Date.parse(expiresAt) <= Math.max(now, Date.now());
  const refresh = trpc.climbing.refreshCatalogueContext.useMutation({
    onSuccess: (context) => utils.climbing.catalogueContext.setData({ id }, context),
  });
  return (
    <ClimbingCatalogueContextView
      context={canDisplay && !expired ? query.data : undefined}
      open={true}
      onToggle={onToggle}
      onRefresh={() => refresh.mutate({ id })}
      loading={query.isLoading || (!query.isFetchedAfterMount && query.isFetching)}
      refreshing={refresh.isPending}
      error={
        authorizationError ? query.error?.message : (refresh.error?.message ?? query.error?.message)
      }
    />
  );
}

export function ClimbingCatalogueContext({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const onToggle = () => setOpen(!open);
  return open ? (
    <OpenCatalogueContext id={id} onToggle={onToggle} />
  ) : (
    <ClimbingCatalogueContextView open={false} onToggle={onToggle} onRefresh={() => {}} />
  );
}
