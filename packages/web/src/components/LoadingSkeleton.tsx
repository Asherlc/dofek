interface LoadingSkeletonProps {
  height?: number | string;
  className?: string;
}

export function LoadingSkeleton({ height = 200, className = "" }: LoadingSkeletonProps) {
  const style = typeof height === "number" ? { height } : { height };
  return (
    <div
      className={`flex items-center justify-center rounded-lg bg-zinc-800/50 animate-pulse ${className}`}
      style={style}
    />
  );
}

export function ChartLoadingSkeleton({ height = 200 }: { height?: number }) {
  return (
    <div className="flex items-center justify-center" style={{ height }}>
      <div className="w-5 h-5 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
    </div>
  );
}
