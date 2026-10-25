export interface ActivityImageSource {
  activityId: string;
  providerId: string;
  sourceId: string;
  kind: string;
  caption: string | null;
  position: number;
}

export interface ActivityImage {
  id: string;
  url: string;
  width: number;
  height: number;
  mimeType: string;
  sizeBytes: number;
  sources: ActivityImageSource[];
}

export function activityImageCaption(image: Pick<ActivityImage, "sources">): string {
  return image.sources.map((source) => source.caption?.trim()).find(Boolean) ?? "Activity photo";
}

interface ActivityImagesQueryState {
  state: {
    data?: {
      images: ReadonlyArray<Pick<ActivityImage, "id">>;
      acquisition: ReadonlyArray<{ state: string }>;
    };
  };
}

export const ACTIVITY_IMAGES_QUERY_OPTIONS = {
  staleTime: 0,
  gcTime: 0,
  refetchOnMount: "always" as const,
  refetchOnWindowFocus: true,
  meta: { persist: false },
  refetchInterval(query: ActivityImagesQueryState): number | false {
    const data = query.state.data;
    if (
      data?.acquisition.some((work) =>
        ["pending", "processing", "retryable_failure"].includes(work.state),
      )
    ) {
      return 3_000;
    }
    return data?.images.length ? 240_000 : false;
  },
};
