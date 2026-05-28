import { activityMetricColors } from "@dofek/scoring/colors";
import { Link } from "@tanstack/react-router";
import { trpc } from "../lib/trpc.ts";

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
  { id: "fatsecret", label: "FatSecret", ext: "png" },
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

  return <LandingPageView usableProviders={usableProviders.data ?? []} />;
}

export function LandingPageView({ usableProviders }: { usableProviders: LandingPageProvider[] }) {
  const usableProviderIds = new Set(usableProviders.map((provider) => provider.id));
  const featuredProviders = FEATURED_PROVIDERS.filter((provider) =>
    usableProviderIds.has(provider.id),
  );

  return (
    <div className="min-h-screen bg-[#f7faf7] text-foreground">
      <LandingNav />
      <main>
        <HeroSection />
        <ProviderStrip providers={featuredProviders} />
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
    <nav className="sticky top-0 z-50 border-b border-[#dce8df] bg-white/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="Dofek logo" width={30} height={30} className="rounded-lg" />
          <span className="text-xl font-semibold tracking-tight">Dofek</span>
        </div>
        <div className="flex items-center gap-5">
          <a
            href="#features"
            className="hidden text-sm font-medium text-[#244b38] transition-colors hover:text-foreground sm:inline"
          >
            Product
          </a>
          <a
            href="#integrations"
            className="hidden text-sm font-medium text-[#244b38] transition-colors hover:text-foreground sm:inline"
          >
            Sources
          </a>
          <a
            href="#pricing"
            className="hidden text-sm font-medium text-[#244b38] transition-colors hover:text-foreground sm:inline"
          >
            Pricing
          </a>
          <Link
            to="/login"
            className="hidden text-sm font-medium text-foreground transition-colors hover:text-accent sm:inline"
          >
            Sign in
          </Link>
          <Link
            to="/login"
            className="rounded-lg bg-[#005244] px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-[#005244]/15 transition-colors hover:bg-[#013f35]"
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
    <section className="overflow-hidden border-b border-[#dce8df] bg-white">
      <div className="mx-auto grid min-h-[615px] max-w-7xl items-center gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[0.85fr_1.15fr] lg:py-12">
        <div className="max-w-2xl">
          <div className="mb-7 inline-flex items-center gap-3 rounded-full border border-[#c8dcd0] px-4 py-2 text-sm font-medium text-[#005244]">
            <span>Sources</span>
            <span className="h-1 w-1 rounded-full bg-[#007d68]" />
            <span>Trends</span>
            <span className="h-1 w-1 rounded-full bg-[#007d68]" />
            <span>History</span>
          </div>
          <h1 className="font-serif text-5xl font-semibold leading-[1.03] tracking-normal text-[#062f29] sm:text-6xl lg:text-[4.35rem]">
            Your health data, in one place.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-[#2d4f45]">
            Connect the apps and devices you use. Dofek keeps sleep, training, nutrition, body, and
            recovery records together so you can compare them over time.
          </p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link
              to="/login"
              className="inline-flex items-center justify-center rounded-lg bg-[#005244] px-8 py-4 text-base font-semibold text-white shadow-lg shadow-[#005244]/15 transition-colors hover:bg-[#013f35]"
            >
              Get started
            </Link>
          </div>
          <div className="mt-8 flex flex-col gap-3 text-sm text-[#45645b] sm:flex-row sm:gap-6">
            {HERO_PROOF_POINTS.map((point) => (
              <div key={point} className="flex items-center gap-2">
                <CheckCircleIcon />
                <span>{point}</span>
              </div>
            ))}
          </div>
        </div>
        <div id="demo" className="scroll-mt-24">
          <DashboardPreview />
        </div>
      </div>
    </section>
  );
}

function DashboardPreview() {
  return (
    <div className="rounded-2xl border border-[#d7e5dc] bg-white shadow-2xl shadow-[#005244]/10">
      <div className="grid grid-cols-[144px_1fr] overflow-hidden rounded-2xl max-[760px]:grid-cols-1">
        <aside className="border-r border-[#edf3ef] bg-[#f8fbf9] p-4 max-[760px]:hidden">
          <div className="mb-5 flex items-center gap-2">
            <img src="/icon.svg" alt="" width={22} height={22} className="rounded-md" />
            <span className="text-sm font-semibold text-[#062f29]">Dofek</span>
          </div>
          {["Overview", "Training", "Activities", "Sleep", "Nutrition", "Body"].map(
            (item, index) => (
              <div
                key={item}
                className={`mb-1 rounded-md px-3 py-2 text-xs ${
                  index === 0 ? "bg-[#eaf2ee] font-semibold text-[#062f29]" : "text-[#4d695f]"
                }`}
              >
                {item}
              </div>
            ),
          )}
        </aside>
        <div className="p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-[#062f29]">Overview</div>
              <div className="text-xs text-[#6b8178]">Apr 28 - May 27</div>
            </div>
            <div className="rounded-md border border-[#dce8df] px-3 py-1 text-xs text-[#2d4f45]">
              30 days
            </div>
          </div>
          <DailySummaryPreview />
          <div className="grid gap-3 lg:grid-cols-2">
            <CorrelationPanel />
            <TrendPanel />
            <ComparisonPanel />
            <SourcePanel />
          </div>
          <HealthMonitorPreview />
        </div>
      </div>
    </div>
  );
}

function DailySummaryPreview() {
  const rings = [
    { label: "Recovery", value: "--", caption: "No data", tone: "#6b8a72" },
    { label: "Strain", value: "0.0", caption: "Light", tone: "#55725c" },
    { label: "Sleep", value: "--", caption: "No data", tone: "#6b8a72" },
  ] as const;

  return (
    <div className="mb-3 rounded-xl border border-[#dce8df] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#45645b]">
            Daily summary
          </div>
          <div className="mt-1 text-sm font-semibold text-[#062f29]">
            Today&apos;s recovery picture
          </div>
        </div>
        <div className="text-xs text-[#6b8178]">2026-05-27</div>
      </div>
      <div className="mt-5 flex flex-wrap items-start justify-center gap-6">
        {rings.map((ring) => (
          <div key={ring.label} className="flex w-24 flex-col items-center text-center">
            <div
              className="grid h-20 w-20 place-items-center rounded-full border-[7px] bg-[#f8fbf9]"
              style={{ borderColor: "#e3f0ea", color: ring.tone }}
            >
              <div>
                <div className="font-mono text-xl font-bold leading-none">{ring.value}</div>
                <div className="mt-1 text-[9px] font-bold uppercase tracking-widest">
                  {ring.label}
                </div>
              </div>
            </div>
            <div className="mt-2 text-[11px] font-medium text-[#6b8a72]">{ring.caption}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CorrelationPanel() {
  return (
    <div className="rounded-xl border border-[#dce8df] bg-white p-3.5">
      <div className="text-xs font-semibold uppercase tracking-[0.08em] text-[#45645b]">
        Key correlation
      </div>
      <div className="mt-1 text-sm text-[#2d4f45]">Sleep consistency + Heart Rate Variability</div>
      <div className="mt-3 grid grid-cols-[0.55fr_1fr] items-end gap-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#45645b]">
            Correlation
          </div>
          <div className="mt-1 text-3xl font-bold text-[#005244]">0.72</div>
          <div className="mt-1 text-xs font-medium text-[#007d68]">Strong positive</div>
          <div className="text-xs text-[#6b8178]">30-day signal</div>
        </div>
        <ScatterPlot />
      </div>
    </div>
  );
}

function TrendPanel() {
  return (
    <div className="rounded-xl border border-[#dce8df] bg-white p-3.5">
      <div className="text-xs font-semibold uppercase tracking-[0.08em] text-[#45645b]">
        Recent trend
      </div>
      <div className="mt-1 text-sm text-[#2d4f45]">Resting heart rate</div>
      <div className="mt-3 grid grid-cols-[0.45fr_1fr] items-end gap-3">
        <div>
          <div className="text-3xl font-bold" style={{ color: activityMetricColors.heartRate }}>
            52
          </div>
          <div className="text-xs text-[#6b8178]">beats/min average</div>
        </div>
        <LineChart color={activityMetricColors.heartRate} />
      </div>
    </div>
  );
}

function ComparisonPanel() {
  return (
    <div className="rounded-xl border border-[#dce8df] bg-white p-3.5">
      <div className="text-xs font-semibold uppercase tracking-[0.08em] text-[#45645b]">
        Training load compared with sleep consistency
      </div>
      <div className="mt-1 text-sm text-[#2d4f45]">Review load beside sleep and recovery.</div>
      <div className="mt-3">
        <ScatterPlot descending={true} />
      </div>
    </div>
  );
}

function SourcePanel() {
  const sourceRows = [
    { name: "Strong", status: "Connected" },
    { name: "Cronometer", status: "Connected" },
  ] as const;

  return (
    <div className="rounded-xl border border-[#dce8df] bg-white p-3.5">
      <div className="text-xs font-semibold uppercase tracking-[0.08em] text-[#45645b]">
        Compare sources
      </div>
      <div className="mt-1 text-sm text-[#2d4f45]">Connected source coverage</div>
      <div className="mt-3 space-y-2.5">
        {sourceRows.map((source) => (
          <div key={source.name} className="grid grid-cols-[80px_1fr] items-center gap-2">
            <div className="text-xs font-medium text-[#062f29]">{source.name}</div>
            <div className="text-xs text-[#45645b]">{source.status}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HealthMonitorPreview() {
  const metrics = [
    { label: "Heart Rate Variability", value: "68 ms" },
    { label: "Resting Heart Rate", value: "-" },
    { label: "Blood Oxygen", value: "98%" },
    { label: "Steps", value: "7,640" },
    { label: "Active Energy", value: "407 calories" },
    { label: "Skin Temperature", value: "36.2 Celsius" },
  ] as const;

  return (
    <div className="mt-3 rounded-xl border border-[#dce8df] bg-white p-3.5">
      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[#45645b]">
        Health monitor
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {metrics.map((metric) => (
          <div key={metric.label} className="rounded-lg border border-[#dce8df] bg-[#fbfdfb] p-2.5">
            <div className="truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-[#45645b]">
              {metric.label}
            </div>
            <div className="mt-1 text-sm font-bold text-[#062f29]">{metric.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScatterPlot({ descending = false }: { descending?: boolean }) {
  const points = descending
    ? [
        [8, 18],
        [18, 26],
        [28, 30],
        [38, 35],
        [50, 42],
        [62, 46],
        [74, 54],
        [88, 60],
        [20, 44],
        [42, 50],
        [66, 34],
        [80, 40],
      ]
    : [
        [8, 58],
        [16, 50],
        [24, 47],
        [34, 42],
        [42, 38],
        [54, 30],
        [66, 28],
        [76, 22],
        [88, 18],
        [26, 30],
        [48, 24],
        [70, 40],
      ];

  return (
    <svg viewBox="0 0 120 72" className="h-24 w-full" role="img" aria-hidden="true">
      <path d="M4 64H116" stroke="#dce8df" strokeWidth="1" />
      <path d="M4 8V64" stroke="#dce8df" strokeWidth="1" />
      <path d={descending ? "M8 18 L112 58" : "M8 60 L112 14"} stroke="#79bcb0" strokeWidth="1.5" />
      {points.map(([xPosition, yPosition]) => (
        <circle
          key={`${xPosition}-${yPosition}`}
          cx={xPosition}
          cy={yPosition}
          r="2"
          fill="#00a08a"
          opacity="0.75"
        />
      ))}
    </svg>
  );
}

function LineChart({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 160 72" className="h-24 w-full" role="img" aria-hidden="true">
      <path
        d="M0 18 C18 20 28 38 44 34 C62 30 72 48 90 44 C110 40 122 56 160 52"
        fill="none"
        stroke={color}
        strokeWidth="2"
      />
      <path
        d="M0 18 C18 20 28 38 44 34 C62 30 72 48 90 44 C110 40 122 56 160 52 L160 72 L0 72Z"
        fill={color}
        opacity="0.08"
      />
    </svg>
  );
}

function ProviderStrip({ providers }: { providers: FeaturedProvider[] }) {
  return (
    <section id="integrations" className="border-b border-[#dce8df] bg-[#fbfdfb] py-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 sm:px-6">
        <div className="text-sm font-semibold text-[#062f29]">Supported sources</div>
        {providers.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {providers.map(({ id, label, ext }) => (
              <div
                key={id}
                className="flex items-center gap-3 rounded-lg border border-[#dce8df] bg-white px-3 py-3"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-white">
                  <img src={`/logos/${id}.${ext}`} alt={label} className="h-7 w-7 object-contain" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[#062f29]">{label}</div>
                  <div className="text-xs text-[#007d68]">Supported</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-[#dce8df] bg-white p-5 text-sm text-[#45645b]">
            No supported sources are currently available.
          </div>
        )}
      </div>
    </section>
  );
}

function PillarsSection() {
  return (
    <section id="features" className="bg-[#fbfdfb] py-16 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <h2 className="font-serif text-4xl font-semibold tracking-normal text-[#062f29]">
            Built for scattered health data.
          </h2>
          <p className="mt-4 text-lg leading-8 text-[#45645b]">
            Not a coach. A clearer way to look at the records you already have.
          </p>
        </div>
        <div className="mt-12 grid gap-0 border-y border-[#dce8df] lg:grid-cols-3">
          {PILLARS.map(({ title, description, icon: Icon }) => (
            <div
              key={title}
              className="border-[#dce8df] py-9 lg:border-r lg:px-8 first:lg:pl-0 last:lg:border-r-0"
            >
              <Icon />
              <h3 className="mt-6 text-xl font-semibold text-[#062f29]">{title}</h3>
              <p className="mt-3 max-w-sm text-sm leading-6 text-[#45645b]">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function InspectionSection() {
  return (
    <section className="bg-[#fbfdfb] py-16 sm:py-20">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.85fr_1.15fr]">
        <div>
          <h2 className="font-serif text-4xl font-semibold tracking-normal text-[#062f29]">
            What you can check
          </h2>
          <p className="mt-4 text-lg leading-8 text-[#45645b]">
            Look across sources without losing where each record came from.
          </p>
          <div className="mt-8 grid gap-3">
            {INSPECTION_POINTS.map((point) => (
              <div
                key={point}
                className="flex items-center gap-3 rounded-lg border border-[#dce8df] bg-white p-4 text-sm font-medium text-[#244b38]"
              >
                <CheckCircleIcon />
                {point}
              </div>
            ))}
          </div>
        </div>
        <div className="grid gap-3">
          {ANALYSIS_CARDS.map((card) => (
            <div key={card.title} className="rounded-xl border border-[#dce8df] bg-white p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.08em] text-[#007d68]">
                    Example
                  </div>
                  <h3 className="mt-2 text-lg font-semibold text-[#062f29]">{card.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-[#45645b]">{card.detail}</p>
                </div>
                <div className="rounded-lg bg-[#eef7f2] px-4 py-3 text-left sm:text-right">
                  <div className="text-xl font-bold text-[#005244]">{card.value}</div>
                  <div className="text-xs text-[#45645b]">{card.tone}</div>
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
    <section className="border-y border-[#dce8df] bg-white py-16 sm:py-20">
      <div className="mx-auto grid max-w-7xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-[0.92fr_1.08fr]">
        <div>
          <div className="mb-5 inline-flex rounded-full border border-[#c8dcd0] px-4 py-2 text-sm font-semibold text-[#005244]">
            iPhone app included
          </div>
          <h2 className="font-serif text-4xl font-semibold tracking-normal text-[#062f29]">
            Capture WHOOP strap data from iPhone.
          </h2>
          <p className="mt-5 max-w-xl text-lg leading-8 text-[#45645b]">
            Pair a WHOOP strap over Bluetooth and send the data to Dofek. Direct capture does not
            require routing through a WHOOP membership.
          </p>
          <div className="mt-8 grid gap-3">
            {MOBILE_APP_POINTS.map((point) => (
              <div
                key={point}
                className="flex items-center gap-3 rounded-lg border border-[#dce8df] bg-[#fbfdfb] p-4 text-sm font-medium text-[#244b38]"
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
      <div className="absolute left-4 top-8 h-[78%] w-[56%] rounded-[2rem] bg-[#e7f2ed]" />
      <div className="relative ml-auto w-full max-w-[330px] rounded-[2.4rem] border border-[#cbded4] bg-[#062f29] p-2 shadow-2xl shadow-[#005244]/20">
        <div className="overflow-hidden rounded-[1.9rem] bg-[#f7faf7]">
          <div className="flex items-center justify-between bg-[#062f29] px-5 py-4 text-white">
            <div className="text-xs font-semibold">9:41</div>
            <div className="h-5 w-24 rounded-full bg-[#021d19]" />
            <div className="text-xs font-semibold">100%</div>
          </div>
          <div className="space-y-4 p-5">
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.14em] text-[#007d68]">
                Dofek mobile
              </div>
              <div className="mt-1 text-2xl font-semibold text-[#062f29]">WHOOP direct</div>
            </div>

            <div className="rounded-2xl border border-[#cfe2d8] bg-white p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold text-[#45645b]">Strap connection</div>
                  <div className="mt-1 text-lg font-bold text-[#062f29]">Connected</div>
                </div>
                <div className="rounded-full bg-[#e7f6ef] px-3 py-1 text-xs font-bold text-[#007d68]">
                  Live
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2">
                {[
                  ["Bluetooth", "On"],
                  ["Samples", "Buffered"],
                  ["Sync", "Dofek"],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-[#f4faf6] p-2">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#6b8178]">
                      {label}
                    </div>
                    <div className="mt-1 text-xs font-bold text-[#062f29]">{value}</div>
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
                  className="flex items-center justify-between rounded-xl border border-[#dce8df] bg-white p-3"
                >
                  <div className="text-sm font-semibold text-[#062f29]">{label}</div>
                  <div className="text-xs font-medium text-[#45645b]">{value}</div>
                </div>
              ))}
            </div>

            <div className="rounded-xl bg-[#eaf2ee] p-3 text-sm font-medium leading-6 text-[#244b38]">
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
      <path d="M0 60H260" stroke="#dce8df" strokeWidth="1" />
      <path d="M0 38H260" stroke="#dce8df" strokeWidth="1" />
      <path d="M0 16H260" stroke="#dce8df" strokeWidth="1" />
      <path
        d="M2 48 C18 20 30 20 44 46 S72 72 88 38 118 8 134 36 162 66 178 34 210 10 226 36 246 54 258 24"
        fill="none"
        stroke="#007d68"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M2 36 C22 58 40 58 58 32 S94 6 112 32 148 64 166 40 198 20 216 40 244 60 258 42"
        fill="none"
        stroke="#79bcb0"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.85"
      />
    </svg>
  );
}

function TrustSection() {
  return (
    <section id="trust" className="border-y border-[#dce8df] bg-white py-16 sm:py-20">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.85fr_1.15fr]">
        <div>
          <h2 className="font-serif text-4xl font-semibold tracking-normal text-[#062f29]">
            Your data stays yours
          </h2>
          <p className="mt-4 text-lg leading-8 text-[#45645b]">
            Export it, delete it, and keep it out of third-party data sales.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {TRUST_POINTS.map((point) => (
            <div
              key={point}
              className="rounded-lg border border-[#dce8df] bg-[#fbfdfb] p-4 text-sm leading-6 text-[#45645b]"
            >
              <span className="mr-2 font-semibold text-[#007d68]">✓</span>
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
    <section id="pricing" className="bg-[#fbfdfb] py-16 sm:py-20">
      <div className="mx-auto max-w-4xl px-4 sm:px-6">
        <div className="text-center">
          <h2 className="font-serif text-4xl font-semibold tracking-normal text-[#062f29]">
            One managed plan
          </h2>
          <p className="mt-4 text-lg text-[#45645b]">
            One subscription for the dashboard, iPhone app, and data controls.
          </p>
        </div>
        <div className="mt-10 rounded-2xl border border-[#b9d8c7] bg-white p-6 shadow-xl shadow-[#005244]/5 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 className="text-2xl font-semibold text-[#062f29]">Dofek Managed</h3>
              <p className="mt-2 text-sm text-[#45645b]">
                For people who want their records in one place.
              </p>
            </div>
            <div className="text-left sm:text-right">
              <div className="text-3xl font-bold text-[#005244]">One plan</div>
              <div className="text-sm text-[#45645b]">Core dashboard included</div>
            </div>
          </div>
          <ul className="mt-8 grid gap-3 sm:grid-cols-2">
            {PLAN_POINTS.map((point) => (
              <li key={point} className="text-sm leading-6 text-[#45645b]">
                <span className="mr-2 font-semibold text-[#007d68]">✓</span>
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
    <section className="border-t border-[#dce8df] bg-white py-16 sm:py-20">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <h2 className="font-serif text-4xl font-semibold tracking-normal text-[#062f29]">
          Ready to bring it together?
        </h2>
        <p className="mt-4 text-lg text-[#45645b]">
          Connect your sources and keep your health history in one place.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/login"
            className="inline-flex w-full items-center justify-center rounded-lg bg-[#005244] px-8 py-4 text-base font-semibold text-white transition-colors hover:bg-[#013f35] sm:w-auto"
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
    <footer className="border-t border-[#dce8df] bg-[#fbfdfb] py-8">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 sm:flex-row sm:px-6">
        <div className="flex items-center gap-2">
          <img src="/icon.svg" alt="" width={20} height={20} className="rounded" />
          <span className="text-sm text-[#45645b]">Dofek - health data dashboard</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-[#6b8178]">
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
      <circle cx="8" cy="8" r="6.5" stroke="#007d68" />
      <path
        d="M5 8.1 7.1 10 11 6"
        stroke="#007d68"
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
      <circle cx="10" cy="19" r="4" stroke="#005244" strokeWidth="2" />
      <circle cx="27" cy="10" r="4" stroke="#005244" strokeWidth="2" />
      <circle cx="28" cy="28" r="4" stroke="#005244" strokeWidth="2" />
      <path d="M14 17 23 12M14 21l10 5" stroke="#005244" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function BarIcon() {
  return (
    <svg width="38" height="38" viewBox="0 0 38 38" fill="none" aria-hidden="true">
      <rect x="8" y="21" width="5" height="9" rx="1.5" fill="#005244" />
      <rect x="17" y="14" width="5" height="16" rx="1.5" fill="#007d68" />
      <rect x="26" y="8" width="5" height="22" rx="1.5" fill="#79bcb0" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg width="38" height="38" viewBox="0 0 38 38" fill="none" aria-hidden="true">
      <ellipse cx="19" cy="10" rx="12" ry="5" stroke="#005244" strokeWidth="2" />
      <path d="M7 10v16c0 2.8 5.4 5 12 5s12-2.2 12-5V10" stroke="#005244" strokeWidth="2" />
      <path d="M7 18c0 2.8 5.4 5 12 5s12-2.2 12-5" stroke="#005244" strokeWidth="2" />
    </svg>
  );
}
