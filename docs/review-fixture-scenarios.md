# Review Fixture Scenarios

Web and mobile Storybook are the canonical review environments for isolated UI
states. Each required scenario is tagged with `review-scenario` and a specific
`review-scenario-*` tag, so reviewers can search for the scenario instead of
depending on an ideal populated example.

| Scenario | Web Storybook | Mobile Storybook |
|----------|---------------|------------------|
| Empty data | `Dashboard / DashboardEvidenceOverview / Empty data` in [DashboardEvidenceOverview.stories.tsx](../packages/web/src/components/DashboardEvidenceOverview.stories.tsx) | `State / QueryStatePanel / Empty data` in [QueryStatePanel.stories.tsx](../packages/mobile/components/QueryStatePanel.stories.tsx) |
| Partial data | `State / ProcessingStatusWidget / Partial data` in [ProcessingStatusWidget.stories.tsx](../packages/web/src/components/ProcessingStatusWidget.stories.tsx) | `State / ProcessingStatusWidget / Partial data` in [ProcessingStatusWidget.stories.tsx](../packages/mobile/components/ProcessingStatusWidget.stories.tsx) |
| Conflicting sources | `Activity / ActivitySourceDecisionCard / Conflicting sources` in [ActivitySourceDecisionCard.stories.tsx](../packages/web/src/components/ActivitySourceDecisionCard.stories.tsx) | `Activity / ActivitySourceDecisionCard / Conflicting sources` in [ActivitySourceDecisionCard.stories.tsx](../packages/mobile/app/activity/ActivitySourceDecisionCard.stories.tsx) |
| Stale provider | `Providers / SyncProviderCard / Stale provider` in [SyncProviderCard.stories.tsx](../packages/web/src/components/SyncProviderCard.stories.tsx) | `Providers / ProviderCard / Stale provider` in [index.stories.tsx](../packages/mobile/app/providers/index.stories.tsx) |
| Processing | `State / ProcessingStatusWidget / Processing` in [ProcessingStatusWidget.stories.tsx](../packages/web/src/components/ProcessingStatusWidget.stories.tsx) | `State / ProcessingStatusWidget / Processing` in [ProcessingStatusWidget.stories.tsx](../packages/mobile/components/ProcessingStatusWidget.stories.tsx) |
| Error | `State / QueryStatePanel / Error` in [QueryStatePanel.stories.tsx](../packages/web/src/components/QueryStatePanel.stories.tsx) | `State / QueryStatePanel / Error` in [QueryStatePanel.stories.tsx](../packages/mobile/components/QueryStatePanel.stories.tsx) |

Run `pnpm lint:review-scenarios` to verify that every scenario remains present
on both platforms. The checker reads tags from exported Component Story Format
story objects; unexported strings and metadata do not satisfy the policy. See
[the policy source](../scripts/review-scenario-coverage-policy.ts).

`pnpm seed` remains the canonical populated full-stack review fixture. It
creates realistic data for route and API review, while Storybook isolates
states such as request errors and active processing without making the default
review login unusable. See [the seed source](../scripts/seed-dev-db.ts) and
[scripts documentation](../scripts/README.md).

After the Postgres seed, `pnpm review:seed-clickhouse` supplies the canonical
ClickHouse dependencies used by full-stack review, including deterministic
daily body-weight samples for adaptive TDEE. The seed preserves unrelated
metric-stream rows; see the
[ClickHouse review seed](../scripts/seed-review-clickhouse.ts) and its
[real-engine preservation test](../scripts/seed-review-clickhouse.integration.test.ts).
The default and E2E Compose workflows use the same bounded ClickHouse profile
for this analytics work; see the [testing resource profile](testing.md#isolated-browser-end-to-end-stack)
and the [Compose definitions](../docker-compose.yml).
Adaptive TDEE unavailable states remain explicit, isolated stories on both
platforms:
[web](../packages/web/src/components/AdaptiveTdeeChart.stories.tsx) and
[mobile](../packages/mobile/app/nutrition-analytics.stories.tsx).
