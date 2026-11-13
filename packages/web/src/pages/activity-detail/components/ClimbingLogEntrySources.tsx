import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingSourceLink } from "@dofek/training/climbing-context";
import type { ClimbKind } from "@dofek/training/climbing-log";
import { selectClimbingSources } from "@dofek/training/climbing-sources";
import type { ReactElement } from "react";
import { ProviderLogo } from "../../../components/ProviderLogo.tsx";

export function ClimbingLogEntrySources({
  name,
  climbKind,
  sourceName,
  providerId,
  links,
  titleControl,
}: {
  titleControl?: ReactElement;
  name: string;
  climbKind: ClimbKind | null;
  sourceName: string | null;
  providerId?: string;
  links: ClimbingSourceLink[];
}) {
  const climbLabel = climbKind === "boulder" ? "Problem" : "Route";
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
    <div className="min-w-0 space-y-1.5 break-words">
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
      <div className="flex flex-wrap items-center gap-2">
        {visibleSources.length > 0 && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-dim">
            {visibleSources.map(({ label, tickSource }) => (
              <span key={label} className="inline-flex items-center gap-1.5">
                {tickSource ? (
                  <a
                    href={tickSource.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Climb on ${label}`}
                    className="inline-flex items-center gap-1.5 rounded-md bg-accent/8 px-2 py-1 align-middle font-medium text-muted hover:bg-accent/15 hover:text-accent"
                  >
                    Climb
                    <ProviderLogo provider={tickSource.providerId} size={14} />
                    <span aria-hidden="true" className="text-dim">
                      ↗
                    </span>
                  </a>
                ) : (
                  <>
                    {providerId && label === providerSourceLabel(providerId) && (
                      <ProviderLogo provider={providerId} size={14} />
                    )}
                    {label}
                  </>
                )}
              </span>
            ))}
          </p>
        )}
        {routeLinks.length > 0 && (
          <ul className="flex flex-wrap gap-2 text-xs">
            {routeLinks.map((link) => (
              <li key={`${link.providerId}:${link.url}`}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${name} ${climbLabel.toLowerCase()} on ${providerSourceLabel(link.providerId)}`}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent/8 px-2 py-1 font-medium text-muted hover:bg-accent/15 hover:text-accent"
                >
                  {climbLabel}
                  <ProviderLogo provider={link.providerId} size={14} />
                  <span aria-hidden="true" className="text-dim">
                    ↗
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
