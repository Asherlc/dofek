import { formatHRVMeasurement, formatPercent, formatSpO2Measurement } from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import { activityMetricColors } from "@dofek/scoring/colors";
import { Link } from "@tanstack/react-router";
import {
  LandingPreviewLineChart,
  LandingPreviewScatterPlot,
} from "../components/LandingPreviewCharts.tsx";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";

const FEATURED_PROVIDERS = [
  { id: "apple_health", label: "Apple Health", ext: "png" },
  { id: "whoop", label: "WHOOP", ext: "png" },
  { id: "garmin", label: "Garmin", ext: "svg" },
  { id: "oura", label: "Oura", ext: "png" },
  { id: "strava", label: "Strava", ext: "svg" },
  { id: "fitbit", label: "Fitbit", ext: "svg" },
  { id: "peloton", label: "Peloton", ext: "svg" },
  { id: "polar", label: "Polar", ext: "png" },
  { id: "withings", label: "Withings", ext: "png" },
  { id: "eight-sleep", label: "Eight Sleep", ext: "svg" },
  { id: "wahoo", label: "Wahoo", ext: "png" },
  { id: "zwift", label: "Zwift", ext: "png" },
  { id: "trainerroad", label: "TrainerRoad", ext: "svg" },
  { id: "suunto", label: "Suunto", ext: "png" },
  { id: "coros", label: "COROS", ext: "png" },
  { id: "concept2", label: "Concept2", ext: "png" },
  { id: "ride-with-gps", label: "Ride with GPS", ext: "png" },
  { id: "komoot", label: "Komoot", ext: "svg" },
  { id: "fatsecret", label: "fatsecret", ext: "png" },
  { id: "strong-csv", label: "Strong", ext: "png" },
  { id: "cronometer-csv", label: "Cronometer", ext: "png" },
  { id: "ultrahuman", label: "Ultrahuman", ext: "png" },
  { id: "xert", label: "Xert", ext: "png" },
  { id: "cycling_analytics", label: "Cycling Analytics", ext: "png" },
  { id: "decathlon", label: "Decathlon", ext: "png" },
  { id: "mapmyfitness", label: "MapMyFitness", ext: "png" },
  { id: "wger", label: "wger", ext: "png" },
] as const;

type FeaturedProvider = (typeof FEATURED_PROVIDERS)[number];

const HERO_PROOF_POINTS = ["Connect sources", "Compare trends", "Keep history"] as const;
const GET_STARTED_SEARCH = { returnTo: "/onboarding" };

const ANALYSIS_CARDS = [
  {
    title: "Late dinners show up next to less consistent sleep",
    detail: "Compare meal times with sleep without switching apps.",
    value: "r = -0.58",
    tone: "30-day correlation",
  },
  {
    title: "Training load vs sleep",
    detail: "See hard weeks beside sleep, recovery, and resting heart rate.",
    value: "30 days",
    tone: "Window",
  },
  {
    title: "Resting heart rate is up",
    detail: "A 4-day rise stays visible across daily records.",
    value: "+7 bpm",
    tone: "4 days",
  },
] as const;

const PILLARS = [
  {
    title: "Bring records together",
    description: "Keep sleep, training, meals, body metrics, and recovery in one place.",
    icon: NetworkIcon,
  },
  {
    title: "Compare what changed",
    description: "Check trends, correlations, and differences between sources.",
    icon: BarIcon,
  },
  {
    title: "Keep the backstory",
    description: "Carry your history forward as devices, apps, and routines change.",
    icon: ArchiveIcon,
  },
] as const;

const INSPECTION_POINTS = [
  "Compare the same signal across sources",
  "Track sleep, training, nutrition, body, and recovery",
  "Check correlations with source context",
  "Log food from Slack",
  "Use the same record on web and iPhone",
] as const;

const MOBILE_APP_POINTS = [
  "Pair a WHOOP strap from iPhone",
  "Capture strap data directly",
  "Use one record on mobile and web",
] as const;

const TRUST_POINTS = [
  "Export your health data",
  "Delete your account and stored data",
  "No health data sold to third parties",
  "Managed by Dofek",
] as const;

const PLAN_POINTS = [
  "Supported sources",
  "Web dashboard and iPhone app",
  "Trends, correlations, and source comparisons",
  "Export and deletion controls",
] as const;

export interface LandingPageProvider {
  id: string;
  name: string;
  authType: string;
  importOnly: boolean;
}

export function LandingPage() {
  const usableProviders = trpc.sync.usableProviders.useQuery();

  return (
    <LandingPageView
      usableProviders={usableProviders.data ?? []}
      usableProvidersError={usableProviders.error}
    />
  );
}

export function LandingPageView({
  usableProviders,
  usableProvidersError,
}: {
  usableProviders: LandingPageProvider[];
  usableProvidersError?: unknown;
}) {
  const usableProviderIds = new Set(usableProviders.map((provider) => provider.id));
  const featuredProviders = FEATURED_PROVIDERS.filter((provider) =>
    usableProviderIds.has(provider.id),
  );

  return (
    <div className="min-h-screen bg-page text-foreground">
      <LandingNav />
      <main>
        <HeroSection />
        <ProviderStrip providers={featuredProviders} error={usableProvidersError} />
        <PillarsSection />
        <InspectionSection />
        <MobileAppSection />
        <TrustSection />
        <PricingSection />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

function LandingNav() {
  return (
    <nav className="sticky top-0 z-50 border-b border-border bg-surface-solid/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="Dofek logo" width={30} height={30} className="rounded-lg" />
          <span className="text-xl font-semibold tracking-tight">Dofek</span>
        </div>
        <div className="flex items-center gap-5">
          <a
            href="#features"
            className="hidden text-sm font-medium text-muted transition-colors hover:text-foreground sm:inline"
          >
            Product
          </a>
          <a
            href="#integrations"
            className="hidden text-sm font-medium text-muted transition-colors hover:text-foreground sm:inline"
          >
            Sources
          </a>
          <a
            href="#pricing"
            className="hidden text-sm font-medium text-muted transition-colors hover:text-foreground sm:inline"
          >
            Pricing
          </a>
          <Link
            to="/login"
            className="text-sm font-medium text-foreground transition-colors hover:text-accent"
          >
            Sign in
          </Link>
          <Link
            to="/login"
            search={GET_STARTED_SEARCH}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent shadow-sm shadow-accent/15 transition-colors hover:bg-accent/85"
          >
            Get started
          </Link>
        </div>
      </div>
    </nav>
  );
}

function HeroSection() {
  return (
    <section className="overflow-hidden border-b border-border bg-surface-solid">
      <div className="mx-auto grid min-h-0 max-w-7xl items-center gap-5 px-4 py-6 sm:gap-8 sm:px-6 sm:py-10 lg:min-h-[615px] lg:grid-cols-[0.85fr_1.15fr] lg:py-12">
        <div className="max-w-2xl lg:col-start-1 lg:row-start-1">
          <div className="mb-4 hidden items-center gap-3 rounded-full border border-border-strong px-4 py-2 text-sm font-medium text-accent sm:inline-flex sm:mb-7">
            <span>Sources</span>
            <span className="h-1 w-1 rounded-full bg-accent-secondary" />
            <span>Trends</span>
            <span className="h-1 w-1 rounded-full bg-accent-secondary" />
            <span>History</span>
          </div>
          <h1 className="font-serif text-4xl font-semibold leading-[1.03] tracking-normal text-foreground sm:text-6xl lg:text-[4.35rem]">
            Your health data, in one place.
          </h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-muted sm:mt-6 sm:text-lg sm:leading-8">
            Connect the apps and devices you use. Dofek keeps sleep, training, nutrition, body, and
            recovery records together so you can compare them over time.
          </p>
          <div className="mt-5 flex flex-col gap-3 sm:mt-7 sm:flex-row sm:items-center">
            <Link
              to="/login"
              search={GET_STARTED_SEARCH}
              className="inline-flex items-center justify-center rounded-lg bg-accent px-8 py-3 text-base font-semibold text-on-accent shadow-lg shadow-accent/15 transition-colors hover:bg-accent/85 sm:py-4"
            >
              Get started
            </Link>
          </div>
        </div>
        <div id="demo" className="scroll-mt-24 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <DashboardPreview />
        </div>
        <div className="flex flex-col gap-3 text-sm text-muted sm:flex-row sm:gap-6 lg:col-start-1 lg:row-start-2 lg:mt-8">
          {HERO_PROOF_POINTS.map((point) => (
            <div key={point} className="flex items-center gap-2">
              <CheckCircleIcon />
              <span>{point}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function DashboardPreview() {
  return (
    <div className="rounded-2xl border border-border-strong bg-surface-solid shadow-2xl shadow-accent/10">
      <div className="grid grid-cols-[144px_1fr] overflow-hidden rounded-2xl max-[760px]:grid-cols-1">
        <aside className="border-r border-border bg-surface p-4 max-[760px]:hidden">
          <div className="mb-5 flex items-center gap-2">
            <img src="/icon.svg" alt="" width={22} height={22} className="rounded-md" />
            <span className="text-sm font-semibold text-foreground">Dofek</span>
          </div>
          {["Overview", "Training", "Activities", "Sleep", "Nutrition", "Body"].map(
            (item, index) => (
              <div
                key={item}
                className={`mb-1 rounded-md px-3 py-2 text-xs ${
                  index === 0 ? "bg-accent/10 font-semibold text-foreground" : "text-subtle"
                }`}
              >
                {item}
              </div>
            ),
          )}
        </aside>
        <div className="p-4">
          <DailySummaryPreview />
          <OverviewPreview />
        </div>
      </div>
    </div>
  );
}

function OverviewPreview() {
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-accent-secondary">
            Illustrative example
          </div>
          <div className="text-sm font-semibold text-foreground">Overview</div>
          <div className="text-xs text-subtle">Apr 28–May 27, 2026</div>
        </div>
        <div className="rounded-md border border-border bg-surface-solid px-3 py-1 text-xs text-muted">
          30 days
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <CorrelationPanel />
        <TrendPanel />
        <ComparisonPanel />
        <HealthMonitorPreview />
      </div>
    </div>
  );
}

function DailySummaryPreview() {
  const rings = [
    {
      label: "Recovery",
      value: formatPercent(0.74),
      caption: "Near baseline",
      tone: "var(--color-accent)",
    },
    { label: "Strain", value: "8.6", caption: "Moderate", tone: "var(--color-muted)" },
    {
      label: "Sleep",
      value: "7h 42m",
      caption: `${formatPercent(0.96)} of need`,
      tone: "var(--color-accent)",
    },
  ] as const;

  return (
    <div className="mb-3 rounded-xl border border-border bg-surface-solid p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted">
            Daily summary
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">
            Today&apos;s recovery picture
          </div>
        </div>
        <div className="text-right text-xs text-subtle">May 27, 2026 · Example data</div>
      </div>
      <div className="mt-5 flex flex-wrap items-start justify-center gap-6">
        {rings.map((ring) => (
          <div key={ring.label} className="flex w-24 flex-col items-center text-center">
            <div
              className="grid h-20 w-20 place-items-center rounded-full border-[7px] bg-surface"
              style={{ borderColor: "var(--color-border-strong)", color: ring.tone }}
            >
              <div>
                <div className="font-mono text-xl font-bold leading-none">{ring.value}</div>
                <div className="mt-1 text-[9px] font-bold uppercase tracking-widest">
                  {ring.label}
                </div>
              </div>
            </div>
            <div className="mt-2 text-[11px] font-medium text-subtle">{ring.caption}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CorrelationPanel() {
  const units = useUnitConverter();
  const hrvMeasurement = formatHRVMeasurement(68);
  const hrvUnit = hrvMeasurement.parts.find((part) => part.type === "unit")?.value;
  if (hrvUnit == null) {
    throw new Error("Heart rate variability formatter did not provide a unit");
  }
  const sleepConsistencyAxis = `Sleep consistency (${units.percentageLabel})`;
  const heartRateVariabilityAxis = `Heart rate variability (${hrvUnit})`;

  return (
    <div className="rounded-xl border border-border bg-surface-solid p-3.5">
      <div className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
        Illustrative relationship
      </div>
      <div className="mt-1 text-sm text-muted">Sleep consistency + Heart Rate Variability</div>
      <div className="mt-3 grid grid-cols-[0.55fr_1fr] items-end gap-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">
            Illustrative sample
          </div>
          <div className="mt-1 text-3xl font-bold text-accent">Example points</div>
          <div className="mt-1 text-xs font-medium text-accent-secondary">
            No measured correlation
          </div>
          <div className="text-xs text-subtle">
            No sample size or confidence interval is shown for this illustration.
          </div>
        </div>
        <LandingPreviewScatterPlot
          accessibleName={`Illustrative scatter plot for demonstration only. X-axis: ${sleepConsistencyAxis}. Y-axis: ${heartRateVariabilityAxis}.`}
          xAxisLabel={sleepConsistencyAxis}
          xTickLabels={["70", "100"]}
          yAxisLabel={heartRateVariabilityAxis}
          yTickLabels={["45", "85"]}
        />
      </div>
      <div className="mt-3 space-y-1 border-t border-border pt-2 text-[10px] leading-4 text-subtle">
        <p>Example source types: sleep + heart rate variability</p>
        <p>Illustrative data only—not a measured Dofek result.</p>
        <p>
          Real relationships can reflect missing observations or other factors; association does not
          establish causation.
        </p>
        <p className="font-semibold text-muted">
          Next: connect sources to compare your own paired records.
        </p>
      </div>
    </div>
  );
}

function TrendPanel() {
  const units = useUnitConverter();
  const averageHeartRate = units.formatHeartRate(52);
  const heartRateUnit = averageHeartRate.parts.find((part) => part.type === "unit")?.value;
  if (heartRateUnit == null) {
    throw new Error("Heart rate formatter did not provide a unit");
  }
  const heartRateAxis = `Resting heart rate (${heartRateUnit})`;

  return (
    <div className="rounded-xl border border-border bg-surface-solid p-3.5">
      <div className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
        Recent trend
      </div>
      <div className="mt-1 text-sm text-muted">Resting heart rate</div>
      <div className="mt-3 grid grid-cols-[0.45fr_1fr] items-end gap-3">
        <div>
          <div className="text-3xl font-bold" style={{ color: activityMetricColors.heartRate }}>
            {formatMeasurementText(averageHeartRate)}
          </div>
          <div className="text-xs text-subtle">average</div>
          <div className="mt-1 text-xs font-medium text-accent-secondary">
            +{formatMeasurementText(units.formatHeartRate(3))} vs prior 7 days
          </div>
          <div className="text-xs text-subtle">7 of 7 nights</div>
        </div>
        <LandingPreviewLineChart
          accessibleName={`Example resting heart rate trend. X-axis: May 21 to May 27, 2026. Y-axis: ${heartRateAxis}.`}
          color={activityMetricColors.heartRate}
          endLabel="May 27"
          startLabel="May 21"
          yAxisLabel={heartRateAxis}
          yTickLabels={["48", "56"]}
        />
      </div>
      <div className="mt-3 space-y-1 border-t border-border pt-2 text-[10px] leading-4 text-subtle">
        <p>Example source: Oura</p>
        <p>Confidence: high coverage; not a diagnosis.</p>
        <p className="font-semibold text-muted">Next: review training and meal timing.</p>
      </div>
    </div>
  );
}

function ComparisonPanel() {
  const units = useUnitConverter();
  const sleepConsistencyAxis = `Sleep consistency (${units.percentageLabel})`;

  return (
    <div className="rounded-xl border border-border bg-surface-solid p-3.5">
      <div className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
        Training load compared with sleep consistency
      </div>
      <div className="mt-1 text-sm text-muted">Harder weeks align with less consistent sleep.</div>
      <div className="mt-3 grid grid-cols-[0.45fr_1fr] items-end gap-3">
        <div>
          <div className="text-2xl font-bold text-accent">r = -0.46</div>
          <div className="mt-1 text-xs font-medium text-accent-secondary">Moderate negative</div>
          <div className="text-xs text-subtle">22 paired days of 30</div>
        </div>
        <LandingPreviewScatterPlot
          accessibleName={`Example training and sleep scatter plot. X-axis: Training load (points). Y-axis: ${sleepConsistencyAxis}.`}
          descending={true}
          xAxisLabel="Training load (points)"
          xTickLabels={["0", "120"]}
          yAxisLabel={sleepConsistencyAxis}
          yTickLabels={["65", "95"]}
        />
      </div>
      <div className="mt-3 space-y-1 border-t border-border pt-2 text-[10px] leading-4 text-subtle">
        <p>Example sources: Garmin load + Oura sleep</p>
        <p>Confidence: low; descriptive only.</p>
        <p className="font-semibold text-muted">
          Next: inspect high-load weeks with lower sleep consistency.
        </p>
      </div>
    </div>
  );
}

function HealthMonitorPreview() {
  const units = useUnitConverter();
  const metrics = [
    { label: "Heart Rate Variability", value: formatHRVMeasurement(68).text },
    { label: "Resting Heart Rate", value: formatMeasurementText(units.formatHeartRate(52)) },
    { label: "Blood Oxygen", value: formatSpO2Measurement(98).text },
    { label: "Steps", value: "7,640" },
    { label: "Respiratory Rate", value: "14 breaths/min" },
    { label: "Skin Temperature", value: units.formatTemperature(36.2).text },
  ] as const;

  return (
    <div className="rounded-xl border border-border bg-surface-solid p-3.5">
      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
        Health monitor
      </div>
      <div className="mt-3">
        {metrics.map((metric) => (
          <div
            key={metric.label}
            className="grid grid-cols-[1fr_auto] items-baseline gap-3 border-t border-border py-1.5 first:border-t-0"
          >
            <div className="truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
              {metric.label}
            </div>
            <div className="text-sm font-bold text-foreground">{metric.value}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 border-t border-border pt-2 text-[10px] text-subtle">
        Example data · 27 of 30 days · Oura + Apple Health
      </div>
    </div>
  );
}

function ProviderStrip({ providers, error }: { providers: FeaturedProvider[]; error?: unknown }) {
  const errorMessage =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : "Supported sources are temporarily unavailable.";

  return (
    <section id="integrations" className="border-b border-border bg-surface/35 py-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 sm:px-6">
        <div className="text-sm font-semibold text-foreground">Supported sources</div>
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          >
            {errorMessage}
          </div>
        ) : null}
        {providers.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {providers.map(({ id, label, ext }) => (
              <div
                key={id}
                className="flex items-center gap-3 rounded-lg border border-border bg-surface-solid px-3 py-3"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-surface-solid">
                  <img src={`/logos/${id}.${ext}`} alt={label} className="h-7 w-7 object-contain" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground">{label}</div>
                  <div className="text-xs text-accent-secondary">Supported</div>
                </div>
              </div>
            ))}
          </div>
        ) : error ? null : (
          <div className="rounded-lg border border-border bg-surface-solid p-5 text-sm text-muted">
            No supported sources are currently available.
          </div>
        )}
      </div>
    </section>
  );
}

function PillarsSection() {
  return (
    <section id="features" className="bg-surface/35 py-16 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <h2 className="font-serif text-4xl font-semibold tracking-normal text-foreground">
            Built for scattered health data.
          </h2>
          <p className="mt-4 text-lg leading-8 text-muted">
            Not a coach. A clearer way to look at the records you already have.
          </p>
        </div>
        <div className="mt-12 grid gap-0 border-y border-border lg:grid-cols-3">
          {PILLARS.map(({ title, description, icon: Icon }) => (
            <div
              key={title}
              className="border-border py-9 lg:border-r lg:px-8 first:lg:pl-0 last:lg:border-r-0"
            >
              <Icon />
              <h3 className="mt-6 text-xl font-semibold text-foreground">{title}</h3>
              <p className="mt-3 max-w-sm text-sm leading-6 text-muted">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function InspectionSection() {
  return (
    <section className="bg-surface/35 py-16 sm:py-20">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.85fr_1.15fr]">
        <div>
          <h2 className="font-serif text-4xl font-semibold tracking-normal text-foreground">
            What you can check
          </h2>
          <p className="mt-4 text-lg leading-8 text-muted">
            Look across sources without losing where each record came from.
          </p>
          <div className="mt-8 grid gap-3">
            {INSPECTION_POINTS.map((point) => (
              <div
                key={point}
                className="flex items-center gap-3 rounded-lg border border-border bg-surface-solid p-4 text-sm font-medium text-muted"
              >
                <CheckCircleIcon />
                {point}
              </div>
            ))}
          </div>
        </div>
        <div className="grid gap-3">
          {ANALYSIS_CARDS.map((card) => (
            <div key={card.title} className="rounded-xl border border-border bg-surface-solid p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.08em] text-accent-secondary">
                    Example
                  </div>
                  <h3 className="mt-2 text-lg font-semibold text-foreground">{card.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted">{card.detail}</p>
                </div>
                <div className="rounded-lg bg-accent/10 px-4 py-3 text-left sm:text-right">
                  <div className="text-xl font-bold text-accent">{card.value}</div>
                  <div className="text-xs text-muted">{card.tone}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function MobileAppSection() {
  return (
    <section className="border-y border-border bg-surface-solid py-16 sm:py-20">
      <div className="mx-auto grid max-w-7xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-[0.92fr_1.08fr]">
        <div>
          <div className="mb-5 inline-flex rounded-full border border-border-strong px-4 py-2 text-sm font-semibold text-accent">
            iPhone app included
          </div>
          <h2 className="font-serif text-4xl font-semibold tracking-normal text-foreground">
            Capture WHOOP strap data from iPhone.
          </h2>
          <p className="mt-5 max-w-xl text-lg leading-8 text-muted">
            Pair a WHOOP strap over Bluetooth and send the data to Dofek. Direct capture does not
            require routing through a WHOOP membership.
          </p>
          <div className="mt-8 grid gap-3">
            {MOBILE_APP_POINTS.map((point) => (
              <div
                key={point}
                className="flex items-center gap-3 rounded-lg border border-border bg-surface/35 p-4 text-sm font-medium text-muted"
              >
                <CheckCircleIcon />
                {point}
              </div>
            ))}
          </div>
        </div>
        <MobileAppMockup />
      </div>
    </section>
  );
}

function MobileAppMockup() {
  return (
    <div className="relative mx-auto w-full max-w-[520px]">
      <div className="absolute left-4 top-8 h-[78%] w-[56%] rounded-[2rem] bg-accent/10" />
      <div className="relative ml-auto w-full max-w-[330px] rounded-[2.4rem] border border-border-strong bg-accent p-2 shadow-2xl shadow-accent/20">
        <div className="overflow-hidden rounded-[1.9rem] bg-page">
          <div className="flex items-center justify-between bg-accent px-5 py-4 text-on-accent">
            <div className="text-xs font-semibold">9:41</div>
            <div className="h-5 w-24 rounded-full bg-black/50" />
            <div className="text-xs font-semibold">100%</div>
          </div>
          <div className="space-y-4 p-5">
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.14em] text-accent-secondary">
                Dofek mobile
              </div>
              <div className="mt-1 text-2xl font-semibold text-foreground">WHOOP direct</div>
            </div>

            <div className="rounded-2xl border border-border-strong bg-surface-solid p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold text-muted">Strap connection</div>
                  <div className="mt-1 text-lg font-bold text-foreground">Connected</div>
                </div>
                <div className="rounded-full bg-accent/10 px-3 py-1 text-xs font-bold text-accent-secondary">
                  Live
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2">
                {[
                  ["Bluetooth", "On"],
                  ["Samples", "Buffered"],
                  ["Sync", "Dofek"],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-surface p-2">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-subtle">
                      {label}
                    </div>
                    <div className="mt-1 text-xs font-bold text-foreground">{value}</div>
                  </div>
                ))}
              </div>
              <MotionStream />
            </div>

            <div className="grid gap-3">
              {[
                ["Motion", "Capturing"],
                ["Background", "Uploading"],
                ["Web", "Ready to compare"],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-center justify-between rounded-xl border border-border bg-surface-solid p-3"
                >
                  <div className="text-sm font-semibold text-foreground">{label}</div>
                  <div className="text-xs font-medium text-muted">{value}</div>
                </div>
              ))}
            </div>

            <div className="rounded-xl bg-accent/10 p-3 text-sm font-medium leading-6 text-muted">
              Direct capture without routing through WHOOP membership.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MotionStream() {
  return (
    <svg viewBox="0 0 260 74" className="mt-5 h-20 w-full" role="img" aria-hidden="true">
      <path d="M0 60H260" stroke="var(--color-border-strong)" strokeWidth="1" />
      <path d="M0 38H260" stroke="var(--color-border-strong)" strokeWidth="1" />
      <path d="M0 16H260" stroke="var(--color-border-strong)" strokeWidth="1" />
      <path
        d="M2 48 C18 20 30 20 44 46 S72 72 88 38 118 8 134 36 162 66 178 34 210 10 226 36 246 54 258 24"
        fill="none"
        stroke="var(--color-accent-secondary)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M2 36 C22 58 40 58 58 32 S94 6 112 32 148 64 166 40 198 20 216 40 244 60 258 42"
        fill="none"
        stroke="var(--color-accent-secondary)"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.85"
      />
    </svg>
  );
}

function TrustSection() {
  return (
    <section id="trust" className="border-y border-border bg-surface-solid py-16 sm:py-20">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.85fr_1.15fr]">
        <div>
          <h2 className="font-serif text-4xl font-semibold tracking-normal text-foreground">
            Your data stays yours
          </h2>
          <p className="mt-4 text-lg leading-8 text-muted">
            Export it, delete it, and keep it out of third-party data sales.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {TRUST_POINTS.map((point) => (
            <div
              key={point}
              className="rounded-lg border border-border bg-surface/35 p-4 text-sm leading-6 text-muted"
            >
              <span className="mr-2 font-semibold text-accent-secondary">✓</span>
              {point}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PricingSection() {
  return (
    <section id="pricing" className="bg-surface/35 py-16 sm:py-20">
      <div className="mx-auto max-w-4xl px-4 sm:px-6">
        <div className="text-center">
          <h2 className="font-serif text-4xl font-semibold tracking-normal text-foreground">
            One managed plan
          </h2>
          <p className="mt-4 text-lg text-muted">
            One subscription for the dashboard, iPhone app, and data controls.
          </p>
        </div>
        <div className="mt-10 rounded-2xl border border-border-strong bg-surface-solid p-6 shadow-xl shadow-accent/5 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 className="text-2xl font-semibold text-foreground">Dofek Managed</h3>
              <p className="mt-2 text-sm text-muted">
                For people who want their records in one place.
              </p>
            </div>
            <div className="text-left sm:text-right">
              <div className="text-3xl font-bold text-accent">One plan</div>
              <div className="text-sm text-muted">Core dashboard included</div>
            </div>
          </div>
          <ul className="mt-8 grid gap-3 sm:grid-cols-2">
            {PLAN_POINTS.map((point) => (
              <li key={point} className="text-sm leading-6 text-muted">
                <span className="mr-2 font-semibold text-accent-secondary">✓</span>
                {point}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="border-t border-border bg-surface-solid py-16 sm:py-20">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <h2 className="font-serif text-4xl font-semibold tracking-normal text-foreground">
          Ready to bring it together?
        </h2>
        <p className="mt-4 text-lg text-muted">
          Connect your sources and keep your health history in one place.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/login"
            search={GET_STARTED_SEARCH}
            className="inline-flex w-full items-center justify-center rounded-lg bg-accent px-8 py-4 text-base font-semibold text-on-accent transition-colors hover:bg-accent/85 sm:w-auto"
          >
            Get started
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border bg-surface/35 py-8">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 sm:flex-row sm:px-6">
        <div className="flex flex-col items-center gap-1 sm:items-start">
          <div className="flex items-center gap-2">
            <img src="/icon.svg" alt="" width={20} height={20} className="rounded" />
            <span className="text-sm text-muted">Dofek - health data dashboard</span>
          </div>
          <a
            href="https://www.fatsecret.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-subtle transition-colors hover:text-foreground"
          >
            Powered by fatsecret Platform API
          </a>
        </div>
        <div className="flex items-center gap-4 text-xs text-subtle">
          <a
            href="https://github.com/Asherlc/dofek"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-foreground"
          >
            GitHub
          </a>
          <a href="#pricing" className="transition-colors hover:text-foreground">
            Pricing
          </a>
          <Link to="/privacy" className="transition-colors hover:text-foreground">
            Privacy
          </Link>
          <Link to="/terms" className="transition-colors hover:text-foreground">
            Terms
          </Link>
        </div>
      </div>
    </footer>
  );
}

function CheckCircleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="var(--color-accent-secondary)" />
      <path
        d="M5 8.1 7.1 10 11 6"
        stroke="var(--color-accent-secondary)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NetworkIcon() {
  return (
    <svg width="38" height="38" viewBox="0 0 38 38" fill="none" aria-hidden="true">
      <circle cx="10" cy="19" r="4" stroke="var(--color-accent)" strokeWidth="2" />
      <circle cx="27" cy="10" r="4" stroke="var(--color-accent)" strokeWidth="2" />
      <circle cx="28" cy="28" r="4" stroke="var(--color-accent)" strokeWidth="2" />
      <path
        d="M14 17 23 12M14 21l10 5"
        stroke="var(--color-accent)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BarIcon() {
  return (
    <svg width="38" height="38" viewBox="0 0 38 38" fill="none" aria-hidden="true">
      <rect x="8" y="21" width="5" height="9" rx="1.5" fill="var(--color-accent)" />
      <rect x="17" y="14" width="5" height="16" rx="1.5" fill="var(--color-accent-secondary)" />
      <rect x="26" y="8" width="5" height="22" rx="1.5" fill="var(--color-accent-secondary)" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg width="38" height="38" viewBox="0 0 38 38" fill="none" aria-hidden="true">
      <ellipse cx="19" cy="10" rx="12" ry="5" stroke="var(--color-accent)" strokeWidth="2" />
      <path
        d="M7 10v16c0 2.8 5.4 5 12 5s12-2.2 12-5V10"
        stroke="var(--color-accent)"
        strokeWidth="2"
      />
      <path d="M7 18c0 2.8 5.4 5 12 5s12-2.2 12-5" stroke="var(--color-accent)" strokeWidth="2" />
    </svg>
  );
}
