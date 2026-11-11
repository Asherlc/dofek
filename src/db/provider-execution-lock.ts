export function providerExecutionLockName(userId: string, providerId: string): string {
  return `provider-sync:${userId}:${providerId}`;
}
