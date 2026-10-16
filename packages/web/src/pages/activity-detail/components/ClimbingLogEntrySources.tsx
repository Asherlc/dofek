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
  const additionalLinks = links.filter((link) => link !== primaryRoute);
  const hasSingleProvider = new Set(links.map((link) => link.providerId)).size === 1;
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
      {sourceName && <p className="text-xs text-dim">{sourceName}</p>}
      {additionalLinks.length > 0 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {additionalLinks.map((link) => (
            <li key={`${link.providerId}:${link.kind}:${link.url}`}>
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline hover:no-underline"
                aria-label={
                  link.kind === "route"
                    ? `${name} route on ${providerSourceLabel(link.providerId)}`
                    : `${providerSourceLabel(link.providerId)} ticks`
                }
              >
                {sourceName && hasSingleProvider
                  ? link.kind === "route"
                    ? "Route"
                    : "Ticks"
                  : `${providerSourceLabel(link.providerId)} ${link.kind}`}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
