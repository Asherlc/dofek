interface SessionProgress {
  sampleCount: number;
  observedHzX100: number;
}

export function createSessionProgressHandler({
  updateWatch,
  publishHostStatus,
}: {
  updateWatch: (progress: SessionProgress) => void;
  publishHostStatus: () => void;
}): (progress: SessionProgress) => void {
  return (progress) => {
    updateWatch(progress);
    publishHostStatus();
  };
}
