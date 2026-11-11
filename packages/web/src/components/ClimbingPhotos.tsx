import { ACTIVITY_IMAGES_QUERY_OPTIONS } from "@dofek/training/activity-images";
import { trpc } from "../lib/trpc.ts";
import { ActivityPhotos } from "./ActivityPhotos.tsx";

export function ClimbingPhotos({ id }: { id: string }) {
  const query = trpc.climbing.images.useQuery({ id }, ACTIVITY_IMAGES_QUERY_OPTIONS);
  const acquisition = query.data?.acquisition;
  const pending = acquisition?.some((work) =>
    ["pending", "processing", "retryable_failure"].includes(work.state),
  );
  const acquisitionError = acquisition?.some((work) => work.state === "terminal_failure")
    ? new Error("An ascent photo could not be downloaded. Refresh photos to check its status.")
    : null;
  const discoveryError = query.data?.coverage.some((source) =>
    ["partial", "failed"].includes(source.coverage),
  )
    ? new Error("KAYA returned incomplete photo information. Sync KAYA to check again.")
    : null;
  return (
    <ActivityPhotos
      images={query.data?.images ?? []}
      loading={query.isLoading}
      pendingMessage={pending ? "Ascent photos are being downloaded…" : undefined}
      error={query.error ?? acquisitionError ?? discoveryError}
      onRetry={() => {
        void query.refetch();
      }}
      retrying={query.isFetching}
    />
  );
}
