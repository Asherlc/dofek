# End-to-End Testing (Cypress)

Automated E2E testing suite for the Dofek web application.

## Structure

- `e2e/`: Test specifications (written in TypeScript).
  - `dashboard.cy.ts`: Verifies the main dashboard, including chart rendering (ECharts canvas) and tRPC data fetching.
  - `login.cy.ts`: Tests authentication redirects and sign-in page visibility.
  - `training.cy.ts`: Tests the training calendar, fitness/fatigue charts, and sub-tab navigation (`/training/endurance`, etc.).
  - `nutrition.cy.ts`: Verifies nutrition macro displays and meal entry rendering.
  - `cycling.cy.ts`: Tests cycling-specific metrics and activity details.
  - `navigation.cy.ts`: Ensures top-level and side-bar navigation works as expected.
- `support/`: Custom commands and global configuration.
  - `commands.ts`: Implements `cy.login()` and `cy.cleanTestData()`.
  - `e2e.ts`: Entry point for support files.

## Testing Strategy

### Authentication & Seeding
Instead of manual UI login, tests use a custom `cy.login()` command for speed and reliability.

1. **Seed**: `cy.login()` calls `cy.task("seedTestUser")` and `cy.task("createSession")`.
2. **Tasks**: These tasks are defined in `cypress.config.ts` and use the `postgres` library to interact directly with the E2E database.
3. **Cookie**: A session cookie is set (`cy.setCookie("session", TEST_SESSION_ID)`) so all subsequent requests to the API are authenticated.
4. **Cleanup**: `cy.cleanTestData()` runs in `afterEach()` to remove test records, ensuring test isolation.

### Data Verification
Tests verify both the UI and the underlying API:
- **UI**: Uses `cy.contains()` to check for headings and `cy.find("canvas")` to confirm that ECharts has rendered correctly.
- **API**: Uses `cy.request()` to hit tRPC endpoints directly (e.g., `training.weeklyVolume`) and asserts on the JSON response structure and types.
- **Interception**: Uses `cy.intercept()` on tRPC calls (matching `POST` due to tRPC method overriding) to wait for data to load before making UI assertions.

## Configuration (`cypress.config.ts`)

- **E2E_DATABASE_URL**: Points to the test database (default: `postgres://health:health@localhost:5436/health`).
- **E2E_SERVER_URL**: Points to the web server (default: `http://localhost:3100`).
- **Retries**: Configured for 1 retry in CI to handle minor flakes without excessive noise.
- **Tasks**:
  - `seedTestUser`: Inserts into `fitness.user_profile`.
  - `createSession`: Inserts into `fitness.session`.
  - `seedDailyMetricsWithSteps`: Inserts test step data and a test provider.
  - `refreshDailyMetricsView`: Refreshes the `v_daily_metrics` materialized view so the dashboard shows the seeded data.

## Running Tests

- **Bring the stack up**: `pnpm e2e:web:up`
- **Open Mode**: `pnpm e2e:web:open` (interactive)
- **Run Mode**: `pnpm e2e:web:run` (CI/headless)
- **Tear the stack down**: `pnpm e2e:web:down`
