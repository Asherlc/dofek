import { JournalPanel } from "../components/JournalPanel.tsx";
import { LifeEventsPanel } from "../components/LifeEventsPanel.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { SubjectiveTrackingPanel } from "../components/SubjectiveTrackingPanel.tsx";

export function TrackingPage() {
  return (
    <PageLayout>
      <PageSection title="Journal" subtitle="Daily behavioral self-reports and trends">
        <JournalPanel />
      </PageSection>
      <PageSection title="Life Events" subtitle="Track changes and see their impact">
        <LifeEventsPanel />
      </PageSection>
      <PageSection title="Injuries and Niggles" subtitle="Track injury events and their impact">
        <SubjectiveTrackingPanel />
      </PageSection>
    </PageLayout>
  );
}
