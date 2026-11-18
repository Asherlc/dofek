# Provider sync reliability

TheCrag exhausted its account-wide weekly budget while Dofek polled every 30 minutes. The provider configuration specifies daily polling. The upstream access denial is shared by several different account states and currently produces a reconnect prompt.

Reuse the shared BullMQ scheduler, provider queue configuration, and Redis cooldown store. A shared regular schedule continues to serve realtime and frequent providers using the existing interval override and 30-minute default. Daily providers run every 24 hours. On-demand and push-only connections have no automatic polls. Web, iOS, and MCP use the same cadence to evaluate freshness. Manual sync remains available to eligible providers.

Give daily dispatch its own BullMQ queue. Workers from older releases subscribe only to the regular queue during rollout and rollback.

Use the shared HTTP classification and cooldown to honor provider retry guidance for confirmed throttling and explicit HTTP 503 deferrals. Preserve account scoping for account-specific limits and distinguish outages from throttling in status. Let provider adapters supply documented reset information when required. Keep the regular retry policy for outages without explicit retry guidance.

Preserve the longest active cooldown across concurrent writes and apply the longest applicable delay when a sync reports multiple deferrable errors. Preserve distinct retry requests and their processing state within each account.

Use a shared access-denied outcome for theCrag’s ambiguous logbook response, with a link to theCrag API Keys on web, iOS, and MCP. Keep the connection and cursor. Explicit credential rejection still prompts reconnection. Group repeated scheduled failures in Sentry by provider and category. Record provider failure categories on the existing sync error counter using fixed labels.

The provider configuration and the limits of the upstream signal are documented in the [provider guide](../../adding-a-provider.md) and the [theCrag API guide](https://www.thecrag.com/en/article/logbookreadapi#token-budget-rate-limiting). The scheduler and retry paths build on [BullMQ job schedulers](https://docs.bullmq.io/guide/job-schedulers) and [HTTP Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3).
