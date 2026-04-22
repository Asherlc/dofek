export function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("rate limit") ||
      message.includes("quota") ||
      message.includes("429") ||
      message.includes("too many requests") ||
      message.includes("resource_exhausted") ||
      message.includes("high demand")
    );
  }
  return false;
}
