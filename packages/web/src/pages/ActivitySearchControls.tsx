import { useState } from "react";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { trpc } from "../lib/trpc.ts";

type SearchMode = "title" | "location";

export type ActivitySearchSelection =
  | { kind: "title" | "name"; name: string }
  | { kind: "nearby"; latitude: number; longitude: number; label: string };

export function ActivitySearchControls({
  active = true,
  selection,
  onSearch,
}: {
  active?: boolean;
  selection: ActivitySearchSelection | undefined;
  onSearch: (selection: ActivitySearchSelection | undefined) => void;
}) {
  const [mode, setMode] = useState<SearchMode>("title");
  const [draft, setDraft] = useState("");
  const [lookup, setLookup] = useState<string>();
  const name = draft.trim();
  const label = mode === "location" ? "Search activity locations" : "Search activity titles";
  const places = trpc.activityLocation.places.useQuery(
    { query: lookup ?? "" },
    {
      enabled: active && lookup !== undefined,
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
      gcTime: 0,
      meta: { persist: false },
    },
  );

  const clear = () => {
    setDraft("");
    setLookup(undefined);
    onSearch(undefined);
  };
  const changeMode = (next: SearchMode) => {
    if (mode === next) return;
    setMode(next);
    clear();
  };

  if (!active) return null;

  return (
    <div className="space-y-2">
      <fieldset className="inline-flex rounded-md border border-border p-0.5">
        <legend className="sr-only">Search by</legend>
        {(["title", "location"] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={mode === choice}
            onClick={() => changeMode(choice)}
            className="rounded px-3 py-1.5 text-sm text-muted aria-pressed:bg-surface-hover aria-pressed:text-foreground"
          >
            {choice === "title" ? "Title" : "Location"}
          </button>
        ))}
      </fieldset>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setLookup(undefined);
          onSearch(name ? { kind: mode === "location" ? "name" : "title", name } : undefined);
        }}
      >
        <input
          type="search"
          aria-label={label}
          placeholder={label}
          value={draft}
          maxLength={200}
          onChange={(event) => {
            setDraft(event.target.value);
            setLookup(undefined);
          }}
          className="min-w-40 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded-md bg-accent px-3 py-2 text-sm text-on-accent">
          Search
        </button>
        {mode === "location" ? (
          <button
            type="button"
            disabled={!name}
            onClick={() => {
              onSearch({ kind: "name", name });
              setLookup(name);
            }}
            className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
          >
            Look up a place
          </button>
        ) : null}
        {selection ? (
          <button type="button" className="px-2 py-2 text-sm text-muted" onClick={clear}>
            Clear search
          </button>
        ) : null}
      </form>
      {lookup && places.isFetching && !places.data ? (
        <QueryStatePanel variant="loading" contextLabel="Places" height={44} />
      ) : lookup && places.isError ? (
        <QueryStatePanel
          contextLabel="Places"
          error={places.error}
          height={60}
          retryLabel="Retry place lookup"
          onRetry={() => void places.refetch()}
        />
      ) : lookup && places.data?.length === 0 ? (
        <p role="status" className="text-sm text-muted">
          No places found.
        </p>
      ) : lookup && places.data ? (
        <fieldset className="space-y-1">
          <legend className="text-sm text-muted">
            Choose a place to find nearby GPS activities.
          </legend>
          {places.data.map(({ id, label, latitude, longitude }) => (
            <button
              key={id}
              type="button"
              className="block w-full rounded-md border border-border px-3 py-2 text-left text-sm"
              onClick={() => {
                setLookup(undefined);
                onSearch({ kind: "nearby", latitude, longitude, label });
              }}
            >
              {label}
            </button>
          ))}
        </fieldset>
      ) : null}
      {selection?.kind === "nearby" ? (
        <p role="status" className="text-sm text-muted">
          Near {selection.label}
        </p>
      ) : null}
      {(lookup && !!places.data?.length) || selection?.kind === "nearby" ? (
        <p className="text-xs text-muted">
          Place lookup by{" "}
          <a className="underline" href="https://www.geoapify.com/">
            Geoapify
          </a>
          {" · "}
          <a className="underline" href="https://www.openstreetmap.org/copyright">
            © OpenStreetMap contributors
          </a>
        </p>
      ) : null}
    </div>
  );
}
