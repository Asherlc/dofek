import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) {
        setDebouncedValue(value);
      }
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debouncedValue;
}
