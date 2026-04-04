import { activityMetricColors, statusColors } from "@dofek/scoring/colors";
import { Link } from "@tanstack/react-router";

/* ── Provider logos for the integration grid ── */
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

/* ── Feature data ── */
const FEATURES = [
  {
    title: "Unified Dashboard",
    subtitle: "Every metric, every device, one screen",
    description:
      "See resting heart rate from your WHOOP next to sleep data from Oura, training load from Garmin, and nutrition from FatSecret. No more switching between five apps to understand how you feel.",
    icon: DashboardIcon,
    color: "#2d7a56",
  },
  {
    title: "Sleep Analysis",
    subtitle: "Understand what actually affects your rest",
    description:
      "Deep and REM breakdowns, sleep stage hypnograms, consistency scoring, and sleep need calculations. Compare data across WHOOP, Oura, Apple Watch, Garmin, and Eight Sleep to see which device tells the real story.",
    icon: SleepIcon,
    color: "#7c5cbf",
  },
  {
    title: "Training Intelligence",
    subtitle: "Train smarter with real data",
    description:
      "Performance Management Charts, critical power curves, training monotony and strain analysis, HR zone distribution, and 80/20 polarization tracking. See exactly when to push and when to rest.",
    icon: TrainingIcon,
    color: "#d97706",
  },
  {
    title: "Nutrition Tracking",
    subtitle: "Macro and micronutrient insights",
    description:
      "Per-food-item granularity with full micronutrient breakdowns. Auto-meal detection, caloric balance charts, adaptive TDEE estimation, and supplement tracking with automated daily entry.",
    icon: NutritionIcon,
    color: "#059669",
  },
  {
    title: "Recovery and Readiness",
    subtitle: "Know when you're ready to perform",
    description:
      "HRV baseline tracking with trend analysis, recovery scoring that combines sleep quality with physiological signals, stress monitoring, and readiness scores that tell you if today is a push day or a rest day.",
    icon: RecoveryIcon,
    color: statusColors.danger,
  },
  {
    title: "AI-Powered Insights",
    subtitle: "Discover patterns you'd never find manually",
    description:
      "Automatic correlation discovery across all your health data. Anomaly detection that flags unusual readings. ML-powered predictions for recovery and performance. Your personal health researcher, running 24/7.",
    icon: InsightsIcon,
    color: "#0284c7",
  },
] as const;

/* ── Stats ── */
const STATS = [
  { value: "30+", label: "Data providers" },
  { value: "7", label: "Reverse-engineered APIs" },
  { value: "100%", label: "Open source" },
  { value: "0", label: "Data sold to third parties" },
];

/* ── Component ── */

export function LandingPage() {
  return (
    <div className="min-h-screen bg-page text-foreground">
      <LandingNav />
      <HeroSection />
      <ProviderGrid />
      <StatsBar />
      <FeaturesSection />
      <ComparisonSection />
      <PrivacySection />
      <FinalCta />
      <Footer />
    </div>
  );
}

/* ── Navigation ── */

function LandingNav() {
  return (
    <nav className="sticky top-0 z-50 border-b border-border bg-page/80 backdrop-blur-lg">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img src="/icon.svg" alt="Dofek logo" width={28} height={28} className="rounded-md" />
          <span className="text-lg font-semibold tracking-tight">Dofek</span>
        </div>
        <div className="flex items-center gap-4">
          <a
            href="#features"
            className="hidden sm:inline text-sm text-muted hover:text-foreground transition-colors"
          >
            Features
          </a>
          <a
            href="#integrations"
            className="hidden sm:inline text-sm text-muted hover:text-foreground transition-colors"
          >
            Integrations
          </a>
          <a
            href="#privacy"
            className="hidden sm:inline text-sm text-muted hover:text-foreground transition-colors"
          >
            Privacy
          </a>
          <Link
            to="/login"
            className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors"
          >
            Sign in
          </Link>
        </div>
      </div>
    </nav>
  );
}

/* ── Hero ── */

function HeroSection() {
  return (
    <section className="relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div className="absolute -top-40 -right-40 w-[600px] h-[600px] rounded-full bg-accent/5 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-[500px] h-[500px] rounded-full bg-accent-secondary/5 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-6xl px-4 sm:px-6 pt-16 sm:pt-24 pb-16">
        <div className="text-center max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent/10 border border-accent/20 text-accent text-xs font-medium mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            Open source health data platform
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.1] mb-6">
            All your health data.{" "}
            <span className="bg-gradient-to-r from-accent to-accent-secondary bg-clip-text text-transparent">
              One clear picture.
            </span>
          </h1>

          <p className="text-lg sm:text-xl text-muted max-w-2xl mx-auto mb-8 leading-relaxed">
            Dofek connects to 30+ health and fitness platforms, pulling every metric into a single
            dashboard with AI-powered insights. No more app-switching. No more scattered data.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              to="/login"
              className="w-full sm:w-auto px-8 py-3.5 rounded-xl bg-accent text-white font-semibold text-base hover:bg-accent/90 transition-all hover:shadow-lg hover:shadow-accent/20 press"
            >
              Get started
            </Link>
            <a
              href="https://github.com/Asherlc/dofek"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full sm:w-auto px-8 py-3.5 rounded-xl bg-surface-solid border border-border-strong text-foreground font-semibold text-base hover:bg-surface-hover transition-all press flex items-center justify-center gap-2"
            >
              <GitHubIcon />
              View on GitHub
            </a>
          </div>
        </div>

        {/* Dashboard mockup */}
        <div className="mt-16 relative">
          <div className="absolute inset-0 bg-gradient-to-t from-page via-transparent to-transparent z-10 pointer-events-none" />
          <DashboardMockup />
        </div>
      </div>
    </section>
  );
}

/* ── Dashboard Mockup (CSS illustration) ── */

function DashboardMockup() {
  return (
    <div className="mx-auto max-w-5xl rounded-2xl border border-border-strong bg-surface-solid shadow-2xl shadow-accent/5 overflow-hidden">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-surface-solid">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-400/60" />
          <div className="w-3 h-3 rounded-full bg-yellow-400/60" />
          <div className="w-3 h-3 rounded-full bg-green-400/60" />
        </div>
        <div className="flex-1 flex justify-center">
          <div className="px-4 py-1 rounded-md bg-page text-xs text-muted">dofek.fit/dashboard</div>
        </div>
      </div>

      {/* Mock dashboard content */}
      <div className="p-4 sm:p-6 bg-page space-y-4">
        {/* Top row: health status bar */}
        <div className="flex gap-3 overflow-hidden">
          {[
            {
              label: "Resting HR",
              value: "52",
              unit: "bpm",
              color: activityMetricColors.heartRate,
            },
            { label: "HRV", value: "68", unit: "ms", color: "#7c5cbf" },
            { label: "Sleep", value: "7h 42m", unit: "", color: "#4338ca" },
            { label: "Steps", value: "8,432", unit: "", color: "#059669" },
            { label: "Recovery", value: "82%", unit: "", color: "#2d7a56" },
          ].map((metric) => (
            <div key={metric.label} className="flex-1 min-w-0 card p-3">
              <div className="text-[10px] text-muted truncate">{metric.label}</div>
              <div className="text-lg font-bold mt-0.5" style={{ color: metric.color }}>
                {metric.value}
                <span className="text-xs font-normal text-muted ml-0.5">{metric.unit}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Charts row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <MockChart title="Sleep Analysis" color="#7c5cbf" type="bar" />
          <MockChart title="Heart Rate Variability" color="#2d7a56" type="line" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <MockChart title="Training Load" color="#d97706" type="area" />
          <MockChart title="Nutrition" color="#059669" type="stacked" />
          <MockChart title="Body Composition" color="#0284c7" type="line" />
        </div>
      </div>
    </div>
  );
}

function MockChart({
  title,
  color,
  type,
}: {
  title: string;
  color: string;
  type: "bar" | "line" | "area" | "stacked";
}) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-muted mb-3">{title}</div>
      <div className="h-24 flex items-end gap-[3px]">
        {type === "bar" &&
          [65, 80, 45, 70, 90, 55, 75, 85, 60, 72, 88, 50, 78, 82].map((height) => (
            <div
              key={`bar-${height}`}
              className="flex-1 rounded-t transition-all"
              style={{
                height: `${height}%`,
                backgroundColor: color,
                opacity: 0.3 + (height / 100) * 0.7,
              }}
            />
          ))}
        {type === "line" && (
          <svg
            viewBox="0 0 200 80"
            className="w-full h-full"
            preserveAspectRatio="none"
            role="img"
            aria-hidden="true"
          >
            <path
              d="M0,60 C20,40 40,50 60,35 C80,20 100,45 120,30 C140,15 160,40 180,25 L200,20"
              fill="none"
              stroke={color}
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path
              d="M0,60 C20,40 40,50 60,35 C80,20 100,45 120,30 C140,15 160,40 180,25 L200,20 L200,80 L0,80Z"
              fill={color}
              opacity="0.08"
            />
          </svg>
        )}
        {type === "area" && (
          <svg
            viewBox="0 0 200 80"
            className="w-full h-full"
            preserveAspectRatio="none"
            role="img"
            aria-hidden="true"
          >
            <path
              d="M0,70 C30,60 50,40 80,45 C110,50 130,20 160,30 C180,35 190,15 200,10 L200,80 L0,80Z"
              fill={color}
              opacity="0.15"
            />
            <path
              d="M0,70 C30,60 50,40 80,45 C110,50 130,20 160,30 C180,35 190,15 200,10"
              fill="none"
              stroke={color}
              strokeWidth="2"
            />
          </svg>
        )}
        {type === "stacked" && (
          <svg
            viewBox="0 0 200 80"
            className="w-full h-full"
            preserveAspectRatio="none"
            role="img"
            aria-hidden="true"
          >
            {[40, 55, 60, 45, 70, 50, 65, 56, 75, 61, 46, 68].map((height, position) => {
              const barWidth = 200 / 12 - 2;
              const xPosition = position * (200 / 12) + 1;
              const proteinHeight = height * 0.4 * 0.8;
              const carbHeight = height * 0.35 * 0.8;
              const fatHeight = height * 0.25 * 0.8;
              return (
                <g key={`stk-${height}`}>
                  <rect
                    x={xPosition}
                    y={80 - proteinHeight}
                    width={barWidth}
                    height={proteinHeight}
                    fill="#059669"
                    opacity="0.7"
                  />
                  <rect
                    x={xPosition}
                    y={80 - proteinHeight - carbHeight}
                    width={barWidth}
                    height={carbHeight}
                    fill="#d97706"
                    opacity="0.7"
                  />
                  <rect
                    x={xPosition}
                    y={80 - proteinHeight - carbHeight - fatHeight}
                    width={barWidth}
                    height={fatHeight}
                    fill="#0284c7"
                    opacity="0.7"
                  />
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}

/* ── Provider Grid ── */

function ProviderGrid() {
  return (
    <section id="integrations" className="py-16 sm:py-24 border-t border-border">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="text-center mb-12">
          <h2 className="text-sm font-semibold text-accent uppercase tracking-wider mb-3">
            Integrations
          </h2>
          <p className="text-2xl sm:text-3xl font-bold">Connects to everything you already use</p>
          <p className="text-muted mt-3 max-w-xl mx-auto">
            30+ providers including 7 reverse-engineered APIs for platforms that don't offer
            developer access. If a device tracks health data, Dofek probably supports it.
          </p>
        </div>

        <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-9 gap-4 sm:gap-6">
          {FEATURED_PROVIDERS.map(({ id, label, ext }) => (
            <div
              key={id}
              className="flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-surface-hover transition-colors group"
            >
              <div className="w-10 h-10 sm:w-12 sm:h-12 flex items-center justify-center rounded-xl bg-white shadow-sm border border-border group-hover:shadow-md transition-shadow">
                <img
                  src={`/logos/${id}.${ext}`}
                  alt={label}
                  className="w-6 h-6 sm:w-8 sm:h-8 object-contain"
                />
              </div>
              <span className="text-[10px] sm:text-xs text-muted text-center leading-tight">
                {label}
              </span>
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-dim mt-8">
          Plus file imports for Apple Health XML, Strong CSV, and Cronometer CSV
        </p>
      </div>
    </section>
  );
}

/* ── Stats Bar ── */

function StatsBar() {
  return (
    <section className="py-12 bg-accent/5 border-y border-border">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 grid grid-cols-2 sm:grid-cols-4 gap-8">
        {STATS.map(({ value, label }) => (
          <div key={label} className="text-center">
            <div className="text-3xl sm:text-4xl font-extrabold text-accent">{value}</div>
            <div className="text-sm text-muted mt-1">{label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── Features Section ── */

function FeaturesSection() {
  return (
    <section id="features" className="py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="text-center mb-16">
          <h2 className="text-sm font-semibold text-accent uppercase tracking-wider mb-3">
            Features
          </h2>
          <p className="text-2xl sm:text-3xl font-bold">
            Everything you need to understand your health
          </p>
          <p className="text-muted mt-3 max-w-xl mx-auto">
            From daily metrics to long-term trends, Dofek gives you the complete picture that no
            single device or app can provide on its own.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {FEATURES.map(({ title, subtitle, description, icon: Icon, color }) => (
            <div key={title} className="card p-6 hover:shadow-lg transition-shadow group">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center mb-4 transition-transform group-hover:scale-110"
                style={{ backgroundColor: `${color}15` }}
              >
                <Icon color={color} />
              </div>
              <h3 className="text-lg font-semibold mb-1">{title}</h3>
              <p className="text-sm text-accent-secondary font-medium mb-2">{subtitle}</p>
              <p className="text-sm text-muted leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Comparison Section ── */

function ComparisonSection() {
  return (
    <section className="py-16 sm:py-24 bg-accent/5 border-y border-border">
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <div className="text-center mb-12">
          <h2 className="text-sm font-semibold text-accent uppercase tracking-wider mb-3">
            Why Dofek?
          </h2>
          <p className="text-2xl sm:text-3xl font-bold">One platform instead of many</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          {/* Without Dofek */}
          <div className="card p-6 border-red-200/50 bg-red-50/30">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-6 h-6 rounded-full bg-red-100 flex items-center justify-center text-red-500 text-sm">
                &times;
              </div>
              <h3 className="font-semibold text-red-900/80">Without Dofek</h3>
            </div>
            <ul className="space-y-3 text-sm text-red-900/60">
              {[
                "Check WHOOP for recovery, Garmin for training, Oura for sleep, FatSecret for nutrition",
                "No way to correlate data across devices",
                "Each app shows only its own limited view",
                "Your data is siloed across 5+ company clouds",
                "Paying for multiple premium subscriptions",
                "Lose everything if you switch devices",
              ].map((item) => (
                <li key={item} className="flex gap-2">
                  <span className="shrink-0 mt-0.5 text-red-400">&mdash;</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {/* With Dofek */}
          <div className="card p-6 border-accent/30 bg-accent/5">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center text-accent text-sm font-bold">
                &#10003;
              </div>
              <h3 className="font-semibold text-foreground">With Dofek</h3>
            </div>
            <ul className="space-y-3 text-sm text-muted">
              {[
                "One dashboard with every metric from every device",
                "Automatic cross-device correlation and insights",
                "AI-powered anomaly detection and predictions",
                "Self-hosted: your data stays on your server",
                "Free and open source, forever",
                "Switch devices anytime, your data history is preserved",
              ].map((item) => (
                <li key={item} className="flex gap-2">
                  <span className="shrink-0 mt-0.5 text-accent">&#10003;</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Privacy Section ── */

function PrivacySection() {
  return (
    <section id="privacy" className="py-16 sm:py-24">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 text-center">
        <div className="w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto mb-6">
          <ShieldIcon />
        </div>
        <h2 className="text-2xl sm:text-3xl font-bold mb-4">Your data. Your server. Period.</h2>
        <p className="text-muted max-w-2xl mx-auto text-lg leading-relaxed mb-8">
          Dofek is fully self-hosted. Your health data never touches a third-party cloud. Deploy on
          your own server with Docker, encrypted secrets, and full control. No accounts, no
          subscriptions, no data harvesting.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-3xl mx-auto">
          {[
            {
              title: "Self-hosted",
              description:
                "Deploy on your own Hetzner, DigitalOcean, or home server with a single Terraform command",
            },
            {
              title: "Encrypted secrets",
              description:
                "All API credentials are managed via Infisical. No plaintext secrets in the repo, ever",
            },
            {
              title: "Open source",
              description:
                "Every line of code is on GitHub. Audit it, fork it, contribute to it. MIT licensed",
            },
          ].map(({ title, description }) => (
            <div key={title} className="card p-5 text-left">
              <h3 className="font-semibold text-sm mb-2">{title}</h3>
              <p className="text-xs text-muted leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Final CTA ── */

function FinalCta() {
  return (
    <section className="py-16 sm:py-24 bg-accent/5 border-t border-border">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 text-center">
        <h2 className="text-2xl sm:text-3xl font-bold mb-4">Ready to see the full picture?</h2>
        <p className="text-muted mb-8 max-w-lg mx-auto">
          Stop app-switching. Start understanding your health data as a whole.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            to="/login"
            className="w-full sm:w-auto px-8 py-3.5 rounded-xl bg-accent text-white font-semibold text-base hover:bg-accent/90 transition-all hover:shadow-lg hover:shadow-accent/20 press"
          >
            Get started
          </Link>
          <a
            href="https://github.com/Asherlc/dofek"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full sm:w-auto px-8 py-3.5 rounded-xl bg-surface-solid border border-border-strong text-foreground font-semibold text-base hover:bg-surface-hover transition-all press flex items-center justify-center gap-2"
          >
            <GitHubIcon />
            Star on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}

/* ── Footer ── */

function Footer() {
  return (
    <footer className="border-t border-border py-8">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <img src="/icon.svg" alt="" width={20} height={20} className="rounded" />
          <span className="text-sm text-muted">Dofek &mdash; Open source health data platform</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-dim">
          <a
            href="https://github.com/Asherlc/dofek"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            GitHub
          </a>
          <Link to="/privacy" className="hover:text-foreground transition-colors">
            Privacy
          </Link>
          <Link to="/terms" className="hover:text-foreground transition-colors">
            Terms
          </Link>
        </div>
      </div>
    </footer>
  );
}

/* ── Icons ── */

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function DashboardIcon({ color }: { color: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function SleepIcon({ color }: { color: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </svg>
  );
}

function TrainingIcon({ color }: { color: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

function NutritionIcon({ color }: { color: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8h1a4 4 0 010 8h-1" />
      <path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z" />
      <line x1="6" y1="1" x2="6" y2="4" />
      <line x1="10" y1="1" x2="10" y2="4" />
      <line x1="14" y1="1" x2="14" y2="4" />
    </svg>
  );
}

function RecoveryIcon({ color }: { color: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
    </svg>
  );
}

function InsightsIcon({ color }: { color: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#2d7a56"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  );
}
