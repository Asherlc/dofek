import type { SyncRequestQueryResolver } from "../lib/sync-request-query.ts";
import { registerSyncRequestQueryResolver } from "../lib/sync-request-query.ts";
import type { Provider } from "../providers/types.ts";

export async function registerProviderSyncRequestResolver(provider: Provider): Promise<void> {
  let resolver: SyncRequestQueryResolver | null = null;
  switch (provider.id) {
    case "garmin":
      resolver = (await import("../providers/garmin/sync-request-query.ts"))
        .resolveGarminSyncRequestQuery;
      break;
    case "whoop":
      resolver = (await import("../providers/whoop/sync-request-query.ts"))
        .resolveWhoopSyncRequestQuery;
      break;
  }
  if (resolver) {
    registerSyncRequestQueryResolver(provider.id, resolver);
  }
}
