interface QueryStatePanelProps {
  error: unknown;
  height?: number;
}

function getQueryErrorMessage(error: unknown, fallback = "Failed to load data."): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return fallback;
}

export function QueryStatePanel({ error, height = 180 }: QueryStatePanelProps) {
  const message = getQueryErrorMessage(error);

  return (
    <div className="query-error-panel" style={{ minHeight: height }}>
      <p>{message}</p>
    </div>
  );
}
