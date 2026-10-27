import {
  type ActivityChartSeries,
  nearestActivityChartSample,
} from "@dofek/training/activity-chart-series";
import { useCallback, useMemo, useState } from "react";
import { type GestureResponderEvent, PanResponder } from "react-native";

const CHART_PADDING_LEFT = 44;

interface ChartScrubOptions {
  plotWidth: number;
  series: ActivityChartSeries;
  onHoverIndex?: (index: number | null) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
}

export function useChartScrub({
  plotWidth,
  series,
  onHoverIndex,
  onScrubStart,
  onScrubEnd,
}: ChartScrubOptions) {
  const [touchIndex, setTouchIndex] = useState<number | null>(null);

  const fromX = useCallback(
    (touchX: number) => {
      const relativeX = touchX - CHART_PADDING_LEFT;
      const normalizedX = Math.max(0, Math.min(1, relativeX / plotWidth));
      const timestamp = series.startedAt + normalizedX * (series.endedAt - series.startedAt);
      return nearestActivityChartSample(series.samples, timestamp)?.index ?? null;
    },
    [plotWidth, series],
  );

  const handleTouch = useCallback(
    (event: GestureResponderEvent) => {
      const index = fromX(event.nativeEvent.locationX);
      setTouchIndex(index);
      onHoverIndex?.(index);
    },
    [fromX, onHoverIndex],
  );

  const handleTouchEnd = useCallback(() => {
    setTouchIndex(null);
    onHoverIndex?.(null);
    onScrubEnd?.();
  }, [onHoverIndex, onScrubEnd]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => series.samples.length > 0,
        onMoveShouldSetPanResponder: (_, gestureState) =>
          series.samples.length > 0 &&
          Math.abs(gestureState.dx) > 10 &&
          Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
        onPanResponderGrant: (event) => {
          onScrubStart?.();
          handleTouch(event);
        },
        onPanResponderMove: (event) => handleTouch(event),
        onPanResponderRelease: handleTouchEnd,
        onPanResponderTerminate: handleTouchEnd,
      }),
    [series, onScrubStart, handleTouch, handleTouchEnd],
  );

  return { touchIndex, panResponder };
}
