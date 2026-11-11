import { providerSourceLabel } from "@dofek/providers/providers";
import { type ActivityImage, activityImageCaption } from "@dofek/training/activity-images";
import { type ReactNode, useEffect, useState } from "react";
import { ActivityPhoto } from "./ActivityPhoto.tsx";
import { ModalDialog, ModalDialogTitle } from "./ModalDialog.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

export function ActivityPhotos({
  images,
  loading,
  error,
  onRetry,
  retrying = false,
  pendingMessage,
  heading,
}: {
  images: readonly ActivityImage[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  retrying?: boolean;
  pendingMessage?: string;
  heading?: ReactNode;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const firstImage = images[0];
  const selected = images.find((image) => image.id === selectedId);
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selectedId, selected]);
  if (!images.length && !loading && !error && !pendingMessage) return <>{heading}</>;

  const refresh = (
    <button
      type="button"
      onClick={() => {
        setRefreshVersion((version) => version + 1);
        onRetry();
      }}
      disabled={retrying}
      className="min-h-9 rounded px-2 text-xs text-muted hover:text-foreground disabled:opacity-50"
    >
      {retrying ? "Refreshing photos…" : "Refresh photos"}
    </button>
  );
  const thumbnails = (viewer = false) => (
    <div
      className={
        viewer
          ? "mt-3 flex gap-2 overflow-x-auto p-1"
          : "mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
      }
    >
      {images.map((image) => (
        <button
          key={image.id}
          type="button"
          aria-label={`Enlarge ${activityImageCaption(image)}`}
          onClick={() => setSelectedId(image.id)}
          className={`${viewer ? "w-16 shrink-0" : "min-w-0"} rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent`}
        >
          <ActivityPhoto image={image} retryVersion={refreshVersion} />
        </button>
      ))}
    </div>
  );

  return (
    <section
      className={heading ? "space-y-3" : "card p-4 sm:p-5"}
      aria-label={heading ? "Activity summary" : "Photos"}
    >
      {heading ? (
        <div className="flex items-center gap-4 sm:gap-6">
          {firstImage ? (
            <button
              type="button"
              aria-label={`View ${images.length} ${images.length === 1 ? "photo" : "photos"}`}
              onClick={() => setSelectedId(firstImage.id)}
              className="relative w-24 shrink-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent sm:w-28"
            >
              <ActivityPhoto
                image={firstImage}
                retryVersion={refreshVersion}
                recoveryMessage="Open photo to refresh."
              />
              {images.length > 1 ? (
                <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white">
                  {images.length}
                </span>
              ) : null}
            </button>
          ) : null}
          <div className="min-w-0 flex-1">{heading}</div>
        </div>
      ) : (
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Photos</h2>
          {refresh}
        </div>
      )}
      {pendingMessage ? (
        <p role="status" className="text-sm text-muted">
          {pendingMessage}
        </p>
      ) : null}
      {error ? <QueryStatePanel error={error} contextLabel="Photos" height={72} /> : null}
      {heading && error ? refresh : null}
      {loading && !images.length && !error ? (
        <QueryStatePanel variant="loading" contextLabel="Photos" height={120} />
      ) : null}
      {!heading && images.length ? thumbnails() : null}
      {selected ? (
        <ModalDialog
          open
          onClose={() => setSelectedId(null)}
          closeOnInteractOutside
          contentClassName="w-[min(96vw,80rem)] rounded-xl border border-border bg-surface-solid p-4 shadow-xl"
        >
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <ModalDialogTitle className="text-base font-semibold">
                {activityImageCaption(selected)}
              </ModalDialogTitle>
              <p className="mt-1 text-xs text-muted">
                {[
                  ...new Set(
                    selected.sources.map((source) => providerSourceLabel(source.providerId)),
                  ),
                ].join(" · ")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="min-h-11 rounded px-3 text-sm hover:bg-surface-hover"
            >
              Close photo
            </button>
          </div>
          {heading && error ? (
            <QueryStatePanel error={error} contextLabel="Photos" height={72} />
          ) : null}
          <ActivityPhoto
            key={selected.id}
            image={selected}
            retryVersion={refreshVersion}
            fit="contain"
            className="h-[70dvh] w-full"
          />
          {heading ? (
            <div className="flex items-center justify-between gap-3">
              {images.length > 1 ? thumbnails(true) : null}
              {refresh}
            </div>
          ) : null}
        </ModalDialog>
      ) : null}
    </section>
  );
}
