import { createFileRoute } from "@tanstack/react-router";

export function TermsPage() {
  return (
    <div className="min-h-screen bg-page text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold text-foreground mb-2">Terms of Service</h1>
        <p className="text-subtle text-sm mb-10">Last updated: March 17, 2026</p>

        <div className="space-y-8 text-sm leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">1. Acceptance of Terms</h2>
            <p>
              By accessing or using Dofek ("the platform", "we", "our"), you agree to be bound by
              these Terms of Service. If you do not agree to these terms, do not use the platform.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              2. Description of Service
            </h2>
            <p>
              Dofek is a personal fitness and health data aggregation platform. It connects to
              third-party fitness and health services to collect, store, and display your data in a
              unified dashboard. The platform provides analytics, trends, and insights based on your
              aggregated data.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">3. User Accounts</h2>
            <ul className="list-disc pl-6 space-y-1.5">
              <li>You must authenticate to use the platform</li>
              <li>
                You are responsible for maintaining the security of your account and any connected
                third-party provider credentials
              </li>
              <li>
                You must not share your account or allow unauthorized access to the platform through
                your account
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              4. Third-Party Integrations
            </h2>
            <p>
              Dofek connects to third-party services (including but not limited to Garmin, Wahoo,
              WHOOP, Oura, Polar, Strava, Peloton, Withings, Fitbit, and others) through their
              official APIs. By connecting a provider:
            </p>
            <ul className="list-disc pl-6 space-y-1.5 mt-2">
              <li>
                You authorize Dofek to access and store the data permitted by the scopes you approve
              </li>
              <li>
                You acknowledge that your use of those services is subject to their own terms of
                service and privacy policies
              </li>
              <li>
                You may disconnect any provider at any time, which stops future data syncing from
                that provider
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">5. Acceptable Use</h2>
            <p>You agree not to:</p>
            <ul className="list-disc pl-6 space-y-1.5 mt-2">
              <li>Use the platform for any unlawful purpose</li>
              <li>
                Attempt to gain unauthorized access to the platform, other accounts, or connected
                systems
              </li>
              <li>
                Interfere with or disrupt the platform or the servers and networks connected to it
              </li>
              <li>Reverse engineer, decompile, or disassemble the platform</li>
              <li>
                Use the platform to collect or store data about other people without their consent
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">6. Data and Privacy</h2>
            <p>
              Your use of the platform is also governed by our{" "}
              <a href="/privacy" className="text-accent hover:text-accent-secondary underline">
                Privacy Policy
              </a>
              , which describes how we collect, use, and protect your data. By using the platform,
              you consent to the data practices described in the Privacy Policy.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">7. Data Accuracy</h2>
            <p>
              Dofek aggregates and displays data from third-party sources. We do not guarantee the
              accuracy, completeness, or reliability of any data synced from external providers. The
              platform is not a medical device and should not be used as a substitute for
              professional medical advice, diagnosis, or treatment.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              8. Disclaimer of Warranties
            </h2>
            <p>
              The platform is provided "as is" and "as available" without warranties of any kind,
              whether express or implied, including but not limited to implied warranties of
              merchantability, fitness for a particular purpose, and non-infringement. We do not
              warrant that the platform will be uninterrupted, error-free, or free of harmful
              components.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              9. Limitation of Liability
            </h2>
            <p>
              To the fullest extent permitted by law, Dofek and its operators shall not be liable
              for any indirect, incidental, special, consequential, or punitive damages, or any loss
              of data, use, or profits, arising out of or related to your use of the platform.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">10. Termination</h2>
            <p>
              We reserve the right to suspend or terminate your access to the platform at any time,
              with or without cause. Upon termination, your right to use the platform ceases
              immediately. You may request deletion of your data as described in our Privacy Policy.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">11. Changes to Terms</h2>
            <p>
              We may update these terms from time to time. Changes will be posted on this page with
              an updated revision date. Continued use of the platform after changes constitutes
              acceptance of the revised terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">12. Contact</h2>
            <p>For questions about these terms, contact the administrator of this instance.</p>
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

export const Route = createFileRoute("/terms")({
  component: TermsPage,
});
