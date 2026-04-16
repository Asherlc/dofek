# Cypress Agent Instructions

> **Read the [README.md](./README.md) first** for testing strategy and configuration.

## High-Level Mandates
- **Use `cy.login()`**: Never use the UI to log in. Always use the custom command to seed a session.
- **Isolate Tests**: Always call `cy.cleanTestData()` in `afterEach()`.
- **Verify the Canvas**: For charts, verify the `<canvas>` element exists. ECharts doesn't render DOM nodes for data points, so canvas presence is the primary indicator of success.
- **Wait for tRPC**: Always intercept and wait for the relevant tRPC call (e.g., `dailyMetrics.list`) before making assertions on data-dependent UI elements.

## Common Tasks

### Adding a New Test
1. Create a `<feature>.cy.ts` in `cypress/e2e/`.
2. Use `beforeEach(() => { cy.login(); })`.
3. If you need specific data, add a new task to `cypress.config.ts` to seed the database directly.
4. If you seed a table that has a materialized view (e.g., `daily_metrics`), remember to call `cy.task("refreshDailyMetricsView")`.

### Debugging Flaky Tests
1. Run with `cypress open` and use the time-travel debugger.
2. Check the `cypress.config.ts` tasks to ensure they are correctly interacting with the E2E database.
3. Ensure the test user ID (`e2e00000-...`) matches between your spec and the tasks.

## Guardrails
- **Database Scope**: Tasks in `cypress.config.ts` use `E2E_DATABASE_URL`. Ensure this never points to a production database.
- **Fail Fast**: Retries are limited to 1 in CI. If a test fails twice, it's a real issue.
