import { useCallback, useRef, useState } from "react";
import { type GestureResponderEvent, PanResponder } from "react-native";

const CHART_PADDING_LEFT = 44;

interface ChartScrubOptions {
  plotWidth: number;
  totalPoints: number;
  onHoverIndex?: (index: number | null) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
}

export function useChartScrub({
  plotWidth,
  totalPoints,
  onHoverIndex,
  onScrubStart,
  onScrubEnd,
}: ChartScrubOptions) {
  const [touchIndex, setTouchIndex] = useState<number | null>(null);

  const fromX = useCallback(
    (touchX: number) => {
      const relativeX = touchX - CHART_PADDING_LEFT;
      const normalizedX = Math.max(0, Math.min(1, relativeX / plotWidth));
      return Math.round(normalizedX * Math.max(totalPoints - 1, 1));
    },
    [plotWidth, totalPoints],
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

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !!onHoverIndex,
      onMoveShouldSetPanResponder: (_, gestureState) =>
        !!onHoverIndex &&
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
  ).current;

  return { touchIndex, panResponder };
}
