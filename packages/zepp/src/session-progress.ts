export interface SessionProgress {
  sampleCount: number;
  observedHzX100: number;
}

export function createSessionProgressHandler({
  updateWatch,
  publishHostStatus,
}: {
  updateWatch: (progress: SessionProgress) => void;
  publishHostStatus: (progress: SessionProgress) => void;
}): (progress: SessionProgress) => void {
  return (progress) => {
    try {
      updateWatch(progress);
    } finally {
      publishHostStatus(progress);
    }
  };
}
