import { createFileRoute } from "@tanstack/react-router";
import { PageSection } from "../../components/PageSection.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { SupplementDoseEventsPanel } from "../../components/SupplementDoseEventsPanel.tsx";
import { SupplementSafetyReviewPanel } from "../../components/SupplementSafetyReviewPanel.tsx";
import { SupplementStackPanel } from "../../components/SupplementStackPanel.tsx";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/nutrition/supplements")({
  component: NutritionSupplementsPage,
});

function NutritionSupplementsPage() {
  const safetyReview = trpc.nutritionAnalytics.micronutrientAdequacyV2.useQuery({ days: 30 });

  return (
    <div className="space-y-8">
      <PageSection
        title="Supplement Stack"
        subtitle="Synced supplement definitions and nutrient details"
      >
        <SupplementStackPanel />
      </PageSection>
      <PageSection
        title="Safety Context"
        subtitle="U.S. Food and Drug Administration (FDA) label references, bounded National Institutes of Health (NIH) adult upper limits, and medication-review guidance"
      >
        {safetyReview.isLoading && <QueryStatePanel variant="loading" height={72} />}
        {safetyReview.isError && <QueryStatePanel error={safetyReview.error} height={72} />}
        {safetyReview.data && <SupplementSafetyReviewPanel review={safetyReview.data} />}
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
