import { UnitConverter } from "@dofek/format/units";
import {
  activityPreviewPoints,
  defaultActivityMetricSources,
} from "@dofek/training/fixtures/activity-metric-sources";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import {
  ModalDialog,
  ModalDialogDescription,
  ModalDialogTitle,
} from "../../../components/ModalDialog.tsx";
import { ProviderLogo } from "../../../components/ProviderLogo.tsx";
import { ElevationChart } from "./ActivityDetailCharts.tsx";

type Treatment = "icons" | "pills";
type Route = "health" | "cloud" | "bluetooth";
interface PreviewSource {
  id: string;
  name: string;
  provider: string;
  route: Route;
  attribution: string;
}

const elevationSources: PreviewSource[] = [
  {
    id: "watch",
    name: "Asher’s Apple Watch",
    provider: "apple-watch",
    route: "health",
    attribution: "via Apple Health",
  },
  {
    id: "garmin",
    name: "Garmin Edge 1050",
    provider: "garmin",
    route: "cloud",
    attribution: "via Garmin Connect",
  },
];
const heartRateSources: PreviewSource[] = [
  { id: "cloud", name: "WHOOP", provider: "whoop", route: "cloud", attribution: "via WHOOP Cloud" },
  {
    id: "bluetooth",
    name: "WHOOP",
    provider: "whoop",
    route: "bluetooth",
    attribution: "via Bluetooth",
  },
];
const routeLabels: Record<Route, string> = {
  health: "Health",
  cloud: "Cloud",
  bluetooth: "Bluetooth",
};
const points = activityPreviewPoints(defaultActivityMetricSources);
const units = new UnitConverter("imperial");

function RouteIcon({ route }: { route: Route }) {
  if (route === "health") return <ProviderLogo provider="apple_health" size={14} />;
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {route === "cloud" ? (
        <path d="M6 19a4.5 4.5 0 0 1-.6-9A6.5 6.5 0 0 1 18 8.5 5.25 5.25 0 0 1 18.5 19H6Z" />
      ) : (
        <path d="m7 7 10 10-5 4V3l5 4L7 17" />
      )}
    </svg>
  );
}

function SourceBadge({ source, treatment }: { source: PreviewSource; treatment: Treatment }) {
  return (
    <span
      className={
        treatment === "pills"
          ? "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface-hover px-2 py-1 text-[10px] font-medium text-muted"
          : "inline-flex shrink-0 items-center justify-center text-muted"
      }
      title={source.attribution}
      aria-hidden="true"
    >
      <RouteIcon route={source.route} />
      {treatment === "pills" && routeLabels[source.route]}
    </span>
  );
}

function SourcePickerPreview({
  treatment,
  metric,
  sources,
  initialId,
}: {
  treatment: Treatment;
  metric: string;
  sources: PreviewSource[];
  initialId: string;
}) {
  const [selectedId, setSelectedId] = useState(initialId);
  const [open, setOpen] = useState(false);
  const selected = sources.find((source) => source.id === selectedId) ?? sources[0];
  if (!selected) return null;

  return (
    <>
      <button
        type="button"
        aria-label={`${metric} source: ${selected.name}, ${selected.attribution}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-border bg-transparent px-3 py-2 text-xs text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <ProviderLogo provider={selected.provider} size={19} />
        <span className="min-w-0 truncate font-medium">{selected.name}</span>
        <SourceBadge source={selected} treatment={treatment} />
        <span className="ml-1 text-[10px] text-muted" aria-hidden="true">
          ▾
        </span>
      </button>
      <ModalDialog
        open={open}
        onClose={() => setOpen(false)}
        closeOnInteractOutside
        contentClassName="w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-border bg-surface p-5 text-foreground shadow-2xl"
      >
        <ModalDialogTitle className="text-base font-semibold">{metric} source</ModalDialogTitle>
        <ModalDialogDescription className="mt-1 text-xs text-muted">
          Choose a recording for this chart.
        </ModalDialogDescription>
        <fieldset className="mt-4 space-y-1">
          <legend className="sr-only">Available recordings</legend>
          {sources.map((source) => (
            <label
              key={source.id}
              className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg px-2 py-3 hover:bg-surface-hover"
            >
              <ProviderLogo provider={source.provider} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{source.name}</span>
                <span className="block text-xs text-muted">{source.attribution}</span>
              </span>
              <input
                type="radio"
                name={`${treatment}-${metric}-${initialId}`}
                checked={source.id === selectedId}
                onChange={() => {
                  setSelectedId(source.id);
                  setOpen(false);
                }}
                className="accent-accent"
              />
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="mt-3 min-h-11 w-full rounded-lg border border-border text-sm text-muted hover:bg-surface-hover"
        >
          Cancel
        </button>
      </ModalDialog>
    </>
  );
}

function AttributionComparison() {
  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
      <div className="mx-auto max-w-5xl">
        <p className="text-xs uppercase tracking-widest text-muted">Design preview</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          A quieter way to show the source
        </h1>
        <p className="mt-2 max-w-xl text-sm text-muted">
          Same recordings, two treatments. Open any control to see its full attribution.
        </p>
        <div className="mt-8 grid gap-8 md:grid-cols-2">
          {(["icons", "pills"] as const).map((treatment) => (
            <section
              key={treatment}
              aria-label={treatment === "icons" ? "Icon badges" : "Labeled pills"}
            >
              <h2 className="text-sm font-semibold">
                {treatment === "icons" ? "A · Icon badges" : "B · Labeled pills"}
              </h2>
              <p className="mt-1 text-xs text-muted">
                {treatment === "icons" ? "Smallest footprint" : "A little more explanation"}
              </p>
              <div className="mt-4 rounded-2xl border border-border bg-surface p-4">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
                  Elevation profile
                </h3>
                <SourcePickerPreview
                  treatment={treatment}
                  metric="Elevation"
                  sources={elevationSources}
                  initialId="watch"
                />
                <div className="mt-4">
                  <ElevationChart points={points} loading={false} units={units} />
                </div>
              </div>
              <div className="mt-5 space-y-3">
                <h3 className="text-xs font-medium text-muted">Heart rate examples</h3>
                <div className="flex flex-wrap gap-2">
                  {heartRateSources.map((source) => (
                    <SourcePickerPreview
                      key={source.id}
                      treatment={treatment}
                      metric="Heart rate"
                      sources={heartRateSources}
                      initialId={source.id}
                    />
                  ))}
                </div>
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}

const meta = {
  title: "Activity/Source attribution",
  component: AttributionComparison,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AttributionComparison>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Comparison: Story = {};
