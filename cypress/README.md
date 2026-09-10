# End-to-End Testing (Cypress)

Cypress exercises the Dofek web application against the isolated E2E stack.

## Structure

- `e2e/`
  - `cycling.cy.ts`: Covers the cycling page's empty states, section headings, and aerobic-efficiency response.
  - `dark-mode.cy.ts`: Verifies that public and authentication surfaces follow the browser's dark system appearance.
  - `dashboard.cy.ts`: Covers authenticated loading, `/api/auth/me`, and the step health monitor backed by `fitness.v_daily_metrics`.
  - `login.cy.ts`: Covers the sign-in page and unauthenticated dashboard redirect.
  - `navigation.cy.ts`: Smoke-tests the authenticated top-level routes.
  - `nutrition.cy.ts`: Verifies that food entries with null calories render without crashing.
  - `provider-detail.cy.ts`: Verifies that a directly opened unavailable provider blocks actions and links back to settings.
  - `training.cy.ts`: Covers training headings, sub-tabs, routes, and the weekly-volume response.
  - `test-helpers.ts`: Provides the shared local-date formatter used by dashboard and nutrition specs.
- `support/`
  - `commands.ts`: Defines `cy.login()` and `cy.cleanTestData()`.
  - `e2e.ts`: Loads the custom commands for every spec.
- `../cypress.config.ts`: Configures Cypress and database-backed Node tasks.

## Authentication and Isolation

Authenticated specs normally use this lifecycle:

1. `cy.login()` runs `seedTestUser` and `createSession`.
2. The command sets the E2E session cookie.
3. The spec exercises the UI or API.
4. `cy.cleanTestData()` removes the test user's records in `afterEach()`.

The login-page spec intentionally does not create a session.

## Node Tasks

`cypress.config.ts` registers these tasks:

- `seedTestUser`: Inserts the fixed E2E user profile.
- `createSession`: Inserts a session for that user.
- `cleanTestData`: Deletes the user's session, food, daily-metric, activity, settings, provider, and profile records.
- `seedDailyMetricsWithSteps`: Inserts a test provider and daily step rows.
- `runQuery`: Executes trusted, spec-owned SQL for setup or verification that does not have a dedicated task.

Cypress runs `cy.task()` handlers in the Node process rather than in the browser; see the official [task documentation](https://docs.cypress.io/api/commands/task).

## Configuration

- `E2E_DATABASE_URL` defaults to the workspace E2E PostgreSQL service on
  `localhost:5436`; set it explicitly when using a different isolated test
  database.
- `E2E_SERVER_URL` defaults to `http://localhost:3100`.
- Specs match `cypress/e2e/**/*.cy.ts`; `cypress/support/e2e.ts` is the support file.
- Headless runs retry a failed test once; interactive runs do not retry. Cypress documents the two retry modes in its [test retries guide](https://docs.cypress.io/app/guides/test-retries).
- Videos are disabled and the default command timeout is 10 seconds.
- The isolated Compose stack health-gates database, ClickHouse, Redis, Redpanda, migrations, analytics setup, and server startup. Docker documents health-gated dependencies in its [startup-order guide](https://docs.docker.com/compose/how-tos/startup-order/).

## Running Tests

Use the full lifecycle after Dockerfile, migration, analytics-model, or seeded-state changes. It
creates the deterministic review fixture, copies its relational and sensor inputs into ClickHouse,
builds the analytics models, and then runs the browser suite:

```bash
pnpm e2e:web
```

Run the review-stack canonical-ID smoke test against the existing seeded stack:

```bash
pnpm e2e:web:reuse -- --spec cypress/e2e/review-stack.cy.ts
```

This spec intentionally bypasses `cy.login()` and `cy.cleanTestData()` because it
validates the deterministic user and session created by the review seed. The fixed
identifiers live in `support/commands.ts` and the spec verifies that session resolves
to the seeded review user before checking activity routes.

Reuse an existing E2E stack for repeated runs:

```bash
pnpm e2e:web:reuse
pnpm e2e:web:reuse -- --spec cypress/e2e/dashboard.cy.ts
```

For manual control:

```bash
pnpm e2e:web:up
pnpm e2e:web:run
pnpm e2e:web:open
pnpm e2e:web:down
```

See [`docs/testing.md`](../docs/testing.md#web-e2e) for stack reuse, workspace isolation, and CI rationale.
