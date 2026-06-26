import { PageLayout } from "../components/PageLayout.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { SupportPanel } from "../components/SupportPanel.tsx";

export function SupportPage() {
  return (
    <PageLayout title="Help & Support" subtitle="Reach the team for help with your account">
      <PageSection title="Contact Support" subtitle="Send us a message and we'll reply by email">
        <SupportPanel />
      </PageSection>
    </PageLayout>
  );
}
