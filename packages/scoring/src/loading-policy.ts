interface LoadingPolicyInput {
  data: unknown;
  isLoading: boolean;
  isFetching?: boolean;
}

function hasExistingData(data: unknown): boolean {
  if (Array.isArray(data)) return data.length > 0;
  return data != null;
}

export function shouldShowBlockingLoading({
  data,
  isLoading,
  isFetching = false,
}: LoadingPolicyInput): boolean {
  return (isLoading || isFetching) && !hasExistingData(data);
}
