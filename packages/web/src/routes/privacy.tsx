import { createFileRoute } from "@tanstack/react-router";

function PrivacyPage() {
  return (
    <div className="min-h-screen bg-page text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold text-foreground mb-2">Privacy Policy</h1>
        <p className="text-subtle text-sm mb-10">Last updated: March 12, 2026</p>

        <div className="space-y-8 text-sm leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">1. Introduction</h2>
            <p>
              Dofek ("we", "our", "the platform") is a fitness and health data aggregation platform.
              This policy describes how we collect, use, store, and protect your personal and health
              data when you use our service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">2. Data We Collect</h2>
            <p className="mb-3">
              Dofek integrates with third-party fitness and health services to aggregate your data
              in one place. When you connect a provider, we collect and store:
            </p>
            <ul className="list-disc pl-6 space-y-1.5">
              <li>
                <strong className="text-foreground">Activity data</strong> — workouts, routes, GPS
                tracks, heart rate streams, power, cadence, and other sensor metrics
              </li>
              <li>
                <strong className="text-foreground">Body composition</strong> — weight, body fat
                percentage, and related measurements
              </li>
              <li>
                <strong className="text-foreground">Sleep data</strong> — sleep stages, duration, and
                recovery metrics
              </li>
              <li>
                <strong className="text-foreground">Nutrition data</strong> — food entries, calorie
                and macro/micronutrient breakdowns, supplements
              </li>
              <li>
                <strong className="text-foreground">Health metrics</strong> — heart rate variability,
                resting heart rate, blood pressure, blood glucose, temperature, and clinical lab
                results
              </li>
              <li>
                <strong className="text-foreground">Journal entries</strong> — self-reported mood,
                energy, and wellness notes from connected providers
              </li>
              <li>
                <strong className="text-foreground">Authentication credentials</strong> — OAuth tokens
                and API keys required to access your connected provider accounts
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">3. How We Use Your Data</h2>
            <p>Your data is used solely to:</p>
            <ul className="list-disc pl-6 space-y-1.5 mt-2">
              <li>Display your health and fitness data in a unified dashboard</li>
              <li>Generate insights, trends, and analytics across your connected providers</li>
              <li>Deduplicate overlapping data from multiple sources</li>
              <li>Provide training load, recovery, and performance analysis</li>
            </ul>
            <p className="mt-3">
              We do not sell, share, or distribute your data to any third parties. Your data is
              never used for advertising or marketing purposes.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              4. Data Storage and Security
            </h2>
            <ul className="list-disc pl-6 space-y-1.5">
              <li>
                All data is stored in an encrypted PostgreSQL (TimescaleDB) database on
                infrastructure we control
              </li>
              <li>The application is served over HTTPS with TLS encryption in transit</li>
              <li>
                Access to the platform requires authentication — unauthenticated users cannot access
                any health data
              </li>
              <li>
                API keys and OAuth tokens are stored encrypted and are never exposed to the frontend
              </li>
              <li>Environment secrets are encrypted at rest using SOPS with age encryption</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">5. Third-Party Services</h2>
            <p>
              Dofek connects to third-party fitness platforms (including but not limited to Garmin,
              Wahoo, WHOOP, Polar, Peloton, Withings, RideWithGPS, and FatSecret) through their
              official APIs. When you authorize a connection, we access only the data permitted by
              the scopes you approve. We comply with each provider's API terms of service and data
              usage policies.
            </p>
            <div className="mt-4 p-4 card">
              <h3 className="text-sm font-semibold text-foreground mb-2">Garmin Connect</h3>
              <p>
                When you connect your Garmin account, your activity, sleep, daily health, and body
                composition data is transferred from Garmin to Dofek. By connecting your Garmin
                account, you expressly consent to this data transfer. Your data is used solely to
                power your Dofek dashboard and is never sold or shared with third parties. For
                details on how Garmin handles your data, see the{" "}
                <a
                  href="https://www.garmin.com/privacy/connect"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:text-accent-secondary underline"
                >
                  Garmin Connect Privacy Policy
                </a>
                .
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              6. Data Retention and Deletion
            </h2>
            <p>
              Your data is retained for as long as your account is active. You may disconnect any
              provider at any time, which stops future data syncing from that provider. You may
              request complete deletion of your account and all associated data by contacting us at
              the email below.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">7. Your Rights</h2>
            <p>You have the right to:</p>
            <ul className="list-disc pl-6 space-y-1.5 mt-2">
              <li>Access all data we store about you</li>
              <li>Request correction of inaccurate data</li>
              <li>Request deletion of your data</li>
              <li>Export your data in a portable format</li>
              <li>Disconnect any third-party provider at any time</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">8. Changes to This Policy</h2>
            <p>
              We may update this privacy policy from time to time. Changes will be posted on this
              page with an updated revision date. Continued use of the platform after changes
              constitutes acceptance of the revised policy.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">9. Contact</h2>
            <p>
              For questions about this privacy policy or to exercise your data rights, contact the
              administrator of this instance.
            </p>
          </section>
        </div>

        <div className="mt-16 pt-8 border-t border-border">
          <a href="/" className="text-sm text-subtle hover:text-muted transition-colors">
            &larr; Back to Dofek
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
});
