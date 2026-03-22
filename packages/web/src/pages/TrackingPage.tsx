import { LifeEventsPanel } from "../components/LifeEventsPanel.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { PageSection } from "../components/PageSection.tsx";

export function TrackingPage() {
  return (
    <PageLayout>
      <PageSection title="Life Events" subtitle="Track changes and see their impact">
        <LifeEventsPanel />
      </PageSection>
    </PageLayout>
  );
}
