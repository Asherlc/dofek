import { z } from "zod";
import { formatLocalDate } from "./test-helpers";

const TEST_USER_ID = "e2e00000-0000-0000-0000-000000000001";
const E2E_PROVIDER_ID = "e2e-test-provider";
const dailyMetricsRowSchema = z.object({ steps: z.number().nullable() });

describe("Dashboard", () => {
  beforeEach(() => {
    cy.login();
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  it("loads the dashboard when authenticated", () => {
    cy.visit("/dashboard");
    cy.url().should("include", "/dashboard");
    // The dashboard should render without redirecting to login
    cy.contains("Sign in to view your health data").should("not.exist");
  });

  it("shows the user identity via /api/auth/me", () => {
    cy.request({ url: "/api/auth/me", failOnStatusCode: false }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body).to.have.property("name", "E2E Test User");
      expect(res.body).to.have.property("email", "e2e@test.local");
    });
  });
});

describe("Dashboard – Daily Steps chart", () => {
  beforeEach(() => {
    cy.login();

    // Build 7 days of step data ending today
    const today = new Date();
    const rows = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (6 - index));
      return { date: formatLocalDate(date), steps: 8000 + index * 200 };
    });

    cy.task("seedDailyMetricsWithSteps", {
      userId: TEST_USER_ID,
      providerId: E2E_PROVIDER_ID,
      rows,
    });

    cy.task("refreshDailyMetricsView");
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  it("renders the Daily Steps chart when step data is present", () => {
    const endDate = formatLocalDate(new Date());

    cy.task("runQuery", {
      query: `
        SELECT steps
        FROM fitness.v_daily_metrics
        WHERE user_id = '${TEST_USER_ID}'
          AND date <= '${endDate}'
        ORDER BY date ASC
      `,
    }).then((res) => {
      const rows = z.array(dailyMetricsRowSchema).parse(res);
      expect(rows.some((row) => (row.steps ?? 0) > 0)).to.eq(true);
    });

    cy.visit("/dashboard");

    // The "Daily Steps" section heading must be present
    cy.contains("h2", "Daily Steps").should("exist");

    // The seeded data should prevent the section from falling back to its empty state.
    cy.contains("h2", "Daily Steps")
      .closest("section")
      .should("not.contain.text", "No data available");
  });
});
