import { JournalPanel } from "../components/JournalPanel.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { SubjectiveTrackingPanel } from "../components/SubjectiveTrackingPanel.tsx";

export function TrackingPage() {
  return (
    <PageLayout>
      <PageSection title="Journal" subtitle="See how your journal entries change over time">
        <JournalPanel />
      </PageSection>
      <PageSection title="Injuries and Niggles" subtitle="Track injury events and their impact">
        <SubjectiveTrackingPanel />
      </PageSection>
    </PageLayout>
  );
}
