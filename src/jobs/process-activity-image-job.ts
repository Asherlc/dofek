import { ImageDownloadError } from "../activity-images/download.ts";
import { activityImageAcquisitions } from "../activity-images/metrics.ts";
import type { ActivityImageWork, ProviderImageCandidate } from "../activity-images/types.ts";

export interface ActivityImageJobDependencies {
  load(id: string, userId: string): Promise<ActivityImageWork | null>;
  claim(work: ActivityImageWork): Promise<boolean>;
  acquire(work: ActivityImageWork): Promise<{ stored: boolean }>;
  refresh(work: ActivityImageWork): Promise<ProviderImageCandidate>;
  fail(
    work: ActivityImageWork,
    retryable: boolean,
    code: string,
    delaySeconds: number,
  ): Promise<void>;
}
/** State is durable in Postgres; Redis delivery may be repeated or interrupted. */
export async function processActivityImageJob(
  data: { workId: string; userId: string },
  deps: ActivityImageJobDependencies,
): Promise<void> {
  const work = await deps.load(data.workId, data.userId);
  if (!work || !(await deps.claim(work))) return;
  try {
    let result: { stored: boolean };
    try {
      result = await deps.acquire(work);
    } catch (error) {
      if (
        !(error instanceof ImageDownloadError) ||
        !["image_http_401", "image_http_403", "image_http_404"].includes(error.code)
      )
        throw error;
      const candidate = await deps.refresh(work);
      if (candidate.sourceId !== work.candidate.sourceId)
        throw new ImageDownloadError("image_identity_changed");
      result = await deps.acquire({ ...work, candidate });
    }
    if (!result.stored) await deps.fail(work, false, "superseded", 0);
    activityImageAcquisitions.add(1, {
      provider: work.providerId,
      outcome: result.stored ? "stored" : "superseded",
    });
  } catch (error) {
    const known = error instanceof ImageDownloadError;
    activityImageAcquisitions.add(1, {
      provider: work.providerId,
      outcome: "failed",
      code: known ? error.code : "image_acquisition_failed",
    });
    await deps.fail(
      work,
      known ? error.retryable : true,
      known ? error.code : "image_acquisition_failed",
      Math.max(30 * 2 ** work.attempts, known ? error.retryAfterSeconds : 0),
    );
  }
}
