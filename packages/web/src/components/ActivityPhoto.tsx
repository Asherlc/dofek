import { type ActivityImage, activityImageCaption } from "@dofek/training/activity-images";
import { useState } from "react";
import { captureException } from "../lib/telemetry.ts";

export function ActivityPhoto({
  image,
  className = "aspect-square",
  fit = "cover",
}: {
  image: ActivityImage;
  className?: string;
  fit?: "cover" | "contain";
}) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = failedUrl === image.url;
  const loading = !failed && loadedUrl !== image.url;

  return (
    <div
      className={`relative overflow-hidden rounded-lg bg-surface-secondary ${className}`}
      aria-busy={loading}
    >
      {failed ? (
        <p
          role="alert"
          className="flex h-full min-h-24 items-center justify-center p-4 text-center text-xs text-muted"
        >
          This photo could not load. Refresh photos to try again.
        </p>
      ) : (
        <>
          <img
            src={image.url}
            alt={activityImageCaption(image)}
            width={image.width}
            height={image.height}
            className={`block h-full w-full ${fit === "contain" ? "object-contain" : "object-cover"}`}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={() => setLoadedUrl(image.url)}
            onError={() => {
              setFailedUrl(image.url);
              captureException(new Error("Activity photo failed to load."), {
                source: "activity-photo",
                imageId: image.id,
              });
            }}
          />
          {loading ? (
            <span role="status" className="sr-only">
              Loading photo…
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}
