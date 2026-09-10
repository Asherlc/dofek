import { PageLayout } from "../components/PageLayout.tsx";
import { SupportPanel } from "../components/SupportPanel.tsx";
import { useAuth } from "../lib/auth-context.tsx";

export function SupportPage() {
  const { user } = useAuth();

  return (
    <PageLayout title="Contact support" subtitle="We'll reply by email">
      <div className="card p-6">
        {user ? (
          <SupportPanel />
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-muted">
              Sign in or create an account to send a secure support request. This protects your
              health information and lets our team reply with the relevant account context.
            </p>
            <a
              href="/login?returnTo=/support"
              className="inline-flex rounded bg-accent px-4 py-2 font-medium text-on-accent transition-colors hover:bg-accent/90"
            >
              Sign in to contact support
            </a>
          </div>
        )}
      </div>
    </PageLayout>
  );
}
