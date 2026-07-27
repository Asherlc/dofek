# Cypress Agent Instructions

> Read the [README.md](./README.md) first for the current spec, helper, task, and command inventory.

## Test Lifecycle

- Use `cy.login()` for authenticated specs; exercise the UI login flow only when authentication behavior is the subject of the test.
- Call `cy.cleanTestData()` in `afterEach()` for every spec that creates the E2E user or user-owned records.
- Keep the fixed user and session identifiers centralized in `support/commands.ts`. Specs that seed SQL must use the same user ID.
- Wait for an observable UI state. Use `cy.intercept()` and an alias when an assertion specifically depends on a request completing.
- Assert user-visible behavior or API contracts. Assert a chart canvas only when rendering a populated chart is the behavior under test; use the product's empty-state text for empty datasets.

## Adding or Updating a Spec

1. Create or update a focused `cypress/e2e/<feature>.cy.ts` spec.
2. Reuse `cy.login()`, `cy.cleanTestData()`, and `formatLocalDate()` where applicable.
3. Prefer a named task in `cypress.config.ts` for setup shared by multiple specs.
4. Use `runQuery` only for trusted, spec-owned SQL when a dedicated shared task would add no value.
5. Validate the smallest affected spec with `pnpm e2e:web:reuse -- --spec <path>`; use `pnpm e2e:web` when the stack must be rebuilt or reset.

Cypress documents Node-side task execution and its serializable argument/result boundary in the official [`cy.task()` reference](https://docs.cypress.io/api/commands/task).

## Current Helpers and Tasks

- Commands: `cy.login()`, `cy.cleanTestData()`.
- Shared spec helper: `formatLocalDate()` in `e2e/test-helpers.ts`.
- Node tasks: `seedTestUser`, `createSession`, `cleanTestData`, `seedDailyMetricsWithSteps`, and `runQuery`.

Keep this inventory and the README synchronized with `support/commands.ts`, `e2e/`, and `cypress.config.ts`.

## Guardrails

- Database tasks must use `E2E_DATABASE_URL`; never point it at production.
- Do not pass user-controlled or application-derived text to `runQuery`.
- Keep retries at one in headless mode and zero in interactive mode; fix deterministic failures instead of masking them with retries.
- Run Compose through the repository's `pnpm` scripts so workspace project isolation is preserved.
