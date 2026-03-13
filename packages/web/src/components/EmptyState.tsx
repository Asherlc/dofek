interface EmptyStateProps {
  message: string;
  height?: number | string;
}

export function EmptyState({ message, height = 128 }: EmptyStateProps) {
  const style = typeof height === "number" ? { height } : { height };
  return (
    <div className="flex items-center justify-center text-zinc-500 text-sm" style={style}>
      {message}
    </div>
  );
}
