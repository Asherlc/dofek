import { DataQualityCenter } from "../components/DataQualityCenter.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { useTodayQueryDate } from "../hooks/useTodayQueryDate.ts";
import { trpc } from "../lib/trpc.ts";

export function DataQualityPage() {
  const endDate = useTodayQueryDate();
  const dataQualityQuery = trpc.processing.dataQuality.useQuery({ endDate });

  return (
    <PageLayout
      title="Data quality"
      subtitle="See coverage gaps, source overlap, sync freshness, unusual observations, and manual entries"
    >
      {dataQualityQuery.isLoading && !dataQualityQuery.data ? (
        <QueryStatePanel variant="loading" message="Loading data quality." />
      ) : dataQualityQuery.error && !dataQualityQuery.data ? (
        <QueryStatePanel
          error={dataQualityQuery.error}
          title="Data quality is unavailable"
          onRetry={() => void dataQualityQuery.refetch()}
          retrying={dataQualityQuery.isFetching}
        />
      ) : !dataQualityQuery.data ? (
        <QueryStatePanel variant="empty" message="No data quality checks are available yet." />
      ) : (
        <div className="space-y-4">
          <DataQualityCenter data={dataQualityQuery.data} />
          {dataQualityQuery.error ? (
            <QueryStatePanel
              error={dataQualityQuery.error}
              title="Data quality refresh failed"
              onRetry={() => void dataQualityQuery.refetch()}
              retrying={dataQualityQuery.isFetching}
            />
          ) : null}
        </div>
      )}
    </PageLayout>
  );
}
