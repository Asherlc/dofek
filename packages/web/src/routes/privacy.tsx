import { createFileRoute } from "@tanstack/react-router";

function PrivacyPage() {
  return (
    <div className="min-h-screen bg-page text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold text-foreground mb-2">Privacy Policy</h1>
        <p className="text-subtle text-sm mb-10">Last updated: July 29, 2026</p>

        <div className="space-y-8 text-sm leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">1. Introduction</h2>
            <p>
              Dofek, operated by Asher Cohen ("we", "our", "the platform"), is a fitness and health data aggregation platform.
              This policy describes how we collect, use, store, and protect your personal and health
              data when you use our service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">MCP and AI Clients</h2>
            <p>
              When you authorize an AI client through Dofek OAuth, Dofek returns only the results
              of tools that authorized client requests for your account. The AI client may process
              those results under its own terms and privacy policy. You can revoke access through
              the client or by contacting <a href="/support" className="text-accent underline">Dofek support</a>.
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
                <strong className="text-foreground">Sleep data</strong> — sleep stages, duration,
                and recovery metrics
              </li>
              <li>
                <strong className="text-foreground">Nutrition data</strong> — food entries, calorie
                and macro/micronutrient breakdowns, supplements
              </li>
              <li>
                <strong className="text-foreground">Health metrics</strong> — heart rate
                variability, resting heart rate, blood pressure, blood glucose, temperature, and
                clinical lab results
              </li>
              <li>
                <strong className="text-foreground">Journal entries</strong> — self-reported mood,
                energy, and wellness notes from connected providers
              </li>
              <li>
                <strong className="text-foreground">Authentication credentials</strong> — OAuth
                tokens and API keys required to access your connected provider accounts
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
              We do not sell your health data or use it for advertising. We disclose data only to
              service providers needed to operate Dofek, such as infrastructure, observability,
              product analytics, email, and payment processors, or when required by law. Those
              providers process data under their own applicable terms and retention obligations.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              4. Data Storage and Security
            </h2>
            <ul className="list-disc pl-6 space-y-1.5">
              <li>Account data and most health records are stored in PostgreSQL (TimescaleDB)</li>
              <li>
                High-volume sensor records and derived analytics are stored in ClickHouse; Redpanda
                buffers sensor events during ingestion
              </li>
              <li>
                Cloudflare R2 stores durable sensor archives and files uploaded or generated for
                imports and exports
              </li>
              <li>Redis holds short-lived job-processing and cache data</li>
              <li>The application is served over HTTPS with TLS encryption in transit</li>
              <li>
                Access to the platform requires authentication — unauthenticated users cannot access
                any health data
              </li>
              <li>
                API keys and OAuth tokens are stored encrypted and are never exposed to the frontend
              </li>
              <li>Environment secrets are managed via Infisical and injected at runtime</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">5. Third-Party Services</h2>
            <p>
              Dofek connects to third-party fitness platforms (including but not limited to Garmin,
              Wahoo, WHOOP, Polar, Peloton, Withings, RideWithGPS, and fatsecret) through their
              APIs. Some integrations use official OAuth APIs, while others use unofficial or
              reverse-engineered APIs to access your data on your behalf. When you authorize a
              connection, we access only the data you consent to sharing.
            </p>
            <div className="mt-4 p-4 card">
              <h3 className="text-sm font-semibold text-foreground mb-2">Garmin Connect</h3>
              <p>
                When you connect your Garmin account, your activity, sleep, daily health, and body
                composition data is transferred from Garmin to Dofek. By connecting your Garmin
                account, you expressly consent to this data transfer. Garmin data powers Dofek.
                Garmin data is not sold and is disclosed only to the service providers described
                above or when required by law. For details on how Garmin handles your data, see the{" "}
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
              Your data is retained while your account is active. Settings provides a two-step
              account deletion flow. Confirmation immediately blocks new account writes, revokes the
              session, and starts a durable deletion request. Dofek deletes active application data
              as the workflow advances and verifies its active application stores after the
              seven-day replay window has elapsed. Logs, processor records, and backups then age
              through a separate retention window. Final retained-data verification is due no later
              than 30 days after the request. A missed deadline does not cancel the request;
              deletion continues automatically, support is alerted, and the public status page shows
              retry or support guidance.
            </p>
            <p className="mt-3">
              To prevent a later database restore from forgetting a deletion request, Dofek retains
              an immutable encrypted deletion-ledger record indefinitely. That narrow record
              contains a random deletion-request identifier and timestamp, a keyed pseudonymous
              account digest, a key identifier, and the encrypted status capability. It does not
              contain a raw account or provider identifier, email address, health data, or provider
              credential. Cloudflare documents that its{" "}
              <a
                href="https://developers.cloudflare.com/r2/buckets/bucket-locks/"
                className="text-accent underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                R2 bucket locks
              </a>{" "}
              can retain protected objects indefinitely.
            </p>
            <p className="mt-3">
              Dofek clears its application caches and deletes nutrition samples that the Dofek app
              wrote to HealthKit. HealthKit and Core Motion source records remain controlled by iOS,
              and users manage those records through Apple&apos;s settings and Health app. Apple
              documents that an app can delete only HealthKit objects it previously saved in the{" "}
              <a
                href="https://developer.apple.com/documentation/healthkit/hkhealthstore/delete(_:withcompletion:)-17hzm"
                className="text-accent underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                HealthKit deletion API
              </a>
              .
            </p>
            <p className="mt-3">
              Payment providers may retain legally required transaction, fraud-prevention, and
              compliance records beyond Dofek&apos;s 30-day application-data window. See the{" "}
              <a
                href="https://stripe.com/legal/privacy-center"
                className="text-accent underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Stripe Privacy Center
              </a>{" "}
              for Stripe&apos;s retention disclosures.
            </p>
            <p className="mt-3">
              <a href="/account-deletion" className="text-accent underline">
                Track an account deletion request
              </a>
              .
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
              <li>Disconnect any third-party provider without deleting its imported data</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              8. Changes to This Policy
            </h2>
            <p>
              We may update this privacy policy from time to time. Changes will be posted on this
              page with an updated revision date. Continued use of the platform after changes
              constitutes acceptance of the revised policy.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">9. Contact</h2>
            <p>
              For questions about this privacy policy, account deletion, or to exercise your data
              rights,{" "}
              <a href="mailto:asherlc@asherlc.com" className="text-accent underline">
                contact the Dofek administrator
              </a>
              .
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
