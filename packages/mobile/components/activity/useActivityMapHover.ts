import { nearestActivityChartSample } from "@dofek/training/activity-chart-series";
import { useCallback, useMemo, useState } from "react";

interface MapSample {
  recordedAt: string;
  lat: number | null;
  lng: number | null;
}

export function useActivityMapHover(points: readonly MapSample[]) {
  const [hoveredPosition, setHoveredPosition] = useState<{ lat: number; lng: number } | null>(null);
  const samples = useMemo(
    () => points.map((point) => ({ timestamp: Date.parse(point.recordedAt), point })),
    [points],
  );
  const handleHoverIndex = useCallback(
    (index: number | null) => {
      const point = index === null ? undefined : points[index];
      setHoveredPosition(
        point?.lat != null && point.lng != null ? { lat: point.lat, lng: point.lng } : null,
      );
    },
    [points],
  );
  const handleHoverTime = useCallback(
    (timestamp: number | null) => {
      const start = Math.min(...samples.map((sample) => sample.timestamp));
      const end = Math.max(...samples.map((sample) => sample.timestamp));
      const point =
        timestamp !== null && timestamp >= start && timestamp <= end
          ? nearestActivityChartSample(samples, timestamp)?.point
          : undefined;
      setHoveredPosition(
        point?.lat != null && point.lng != null ? { lat: point.lat, lng: point.lng } : null,
      );
    },
    [samples],
  );
  return { hoveredPosition, handleHoverIndex, handleHoverTime };
}
