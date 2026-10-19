import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingSourceLink } from "@dofek/training/climbing-context";

export function ClimbingLogEntrySources({
  name,
  sourceName,
  links,
}: {
  name: string;
  sourceName: string | null;
  links: ClimbingSourceLink[];
}) {
  const primaryRoute = links.find((link) => link.kind === "route");
  const sources = [
    ...new Set([
      ...(sourceName
        ?.split(",")
        .map((source) => source.trim())
        .filter(Boolean) ?? []),
      ...links.map((link) => providerSourceLabel(link.providerId)),
    ]),
  ];
  return (
    <div className="min-w-0 space-y-0.5 break-words">
      <h4 className="text-sm font-medium text-foreground">
        {primaryRoute ? (
          <a
            href={primaryRoute.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${name} on ${providerSourceLabel(primaryRoute.providerId)}`}
            className="text-accent underline hover:no-underline"
          >
            {name}
          </a>
        ) : (
          name
        )}
      </h4>
      {sources.length > 0 && (
        <p className="text-xs text-dim">
          {sources.map((source, index) => {
            const tickSource = links.find(
              (link) => link.kind === "ticks" && providerSourceLabel(link.providerId) === source,
            );
            return (
              <span key={source}>
                {index > 0 && ", "}
                {tickSource ? (
                  <a
                    href={tickSource.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent underline hover:no-underline"
                  >
                    {source}
                  </a>
                ) : (
                  source
                )}
              </span>
            );
          })}
        </p>
      )}
    </div>
  );
}
