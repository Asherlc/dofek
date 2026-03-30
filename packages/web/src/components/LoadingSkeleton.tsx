export function ChartLoadingSkeleton({ height = 200 }: { height?: number }) {
  return (
    <div className="flex items-center justify-center" style={{ height }}>
      <div className="w-5 h-5 border-2 border-border-strong border-t-muted rounded-full animate-spin" />
    </div>
  );
}
