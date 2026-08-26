import { PageLayout } from "../components/PageLayout.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { SupportPanel } from "../components/SupportPanel.tsx";
import { useAuth } from "../lib/auth-context.tsx";

export function SupportPage() {
  const { user } = useAuth();

  return (
    <PageLayout title="Help & Support" subtitle="Reach the team for help with your account">
      <PageSection title="Contact Support" subtitle="Send us a message and we'll reply by email">
        {user ? (
          <SupportPanel />
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-muted">
              Sign in or create an account to send a secure support request. This protects your
              health information and lets our team reply with the relevant account context.
            </p>
            <a
              href="/login?returnTo=%2Fsupport"
              className="inline-flex rounded bg-accent px-4 py-2 font-medium text-on-accent transition-colors hover:bg-accent/90"
            >
              Sign in to contact support
            </a>
          </div>
        )}
      </PageSection>
    </PageLayout>
  );
}
