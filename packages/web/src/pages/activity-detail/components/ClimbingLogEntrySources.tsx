import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingSourceLink } from "@dofek/training/climbing-context";
import { selectClimbingSources } from "@dofek/training/climbing-sources";
import type { ReactElement } from "react";

export function ClimbingLogEntrySources({
  name,
  sourceName,
  links,
  titleControl,
}: {
  titleControl?: ReactElement;
  name: string;
  sourceName: string | null;
  links: ClimbingSourceLink[];
}) {
  const { primaryRoute, additionalRoutes, sources } = selectClimbingSources(
    sourceName,
    links,
    providerSourceLabel,
  );
  const routeLinks =
    titleControl && primaryRoute ? [primaryRoute, ...additionalRoutes] : additionalRoutes;
  const visibleSources = titleControl
    ? sources.filter(
        ({ label, tickSource }) =>
          tickSource || !routeLinks.some((link) => providerSourceLabel(link.providerId) === label),
      )
    : sources;
  return (
    <div className="min-w-0 space-y-0.5 break-words">
      <h4 className="text-sm font-medium text-foreground">
        {titleControl ??
          (primaryRoute ? (
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
          ))}
      </h4>
      {visibleSources.length > 0 && (
        <p className="text-xs text-dim">
          {visibleSources.map(({ label, tickSource }, index) => (
            <span key={label}>
              {index > 0 && ", "}
              {tickSource ? (
                <a
                  href={tickSource.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent underline hover:no-underline"
                >
                  {label}
                </a>
              ) : (
                label
              )}
            </span>
          ))}
        </p>
      )}
      {routeLinks.length > 0 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {routeLinks.map((link) => (
            <li key={`${link.providerId}:${link.url}`}>
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${name} route on ${providerSourceLabel(link.providerId)}`}
                className="text-accent underline hover:no-underline"
              >
                Route on {providerSourceLabel(link.providerId)}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
