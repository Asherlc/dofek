import { createFileRoute } from "@tanstack/react-router";
import { PageSection } from "../../components/PageSection.tsx";
import { SupplementDoseEventsPanel } from "../../components/SupplementDoseEventsPanel.tsx";
import { SupplementStackPanel } from "../../components/SupplementStackPanel.tsx";

export const Route = createFileRoute("/nutrition/supplements")({
  component: NutritionSupplementsPage,
});

function NutritionSupplementsPage() {
  return (
    <div className="space-y-8">
      <PageSection
        title="Supplement Stack"
        subtitle="Define your schedule; nutrients count only when you record a dose as taken"
      >
        <SupplementStackPanel />
      </PageSection>
      <PageSection
        title="Recent Doses"
        subtitle="Planned, taken, skipped, and unknown dose-event history"
      >
        <SupplementDoseEventsPanel />
      </PageSection>
    </div>
  );
}
