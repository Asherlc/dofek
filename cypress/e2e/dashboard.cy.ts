import { z } from "zod";
import { TEST_USER_ID } from "../support/test-user";
import { formatLocalDate } from "./test-helpers";

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
    cy.intercept("POST", "**/api/trpc/*processing.alerts*").as("processingAlerts");
    cy.visit("/dashboard");
    cy.wait("@processingAlerts").then(({ response }) => {
      expect(response?.statusCode).to.eq(200);
      expect(JSON.stringify(response?.body)).not.to.include("Invalid UUID");
    });
    cy.url().should("include", "/dashboard");
    // The dashboard should render without redirecting to login
    cy.contains("Sign in to Dofek").should("not.exist");
  });

  it("shows the user identity via /api/auth/me", () => {
    cy.request({ url: "/api/auth/me", failOnStatusCode: false }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body).to.have.property("name", "E2E Test User");
      expect(res.body).to.have.property("email", "e2e@test.local");
    });
  });
});

describe("Dashboard – Daily Steps health monitor", () => {
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
  });

  afterEach(() => {
    cy.cleanTestData();
  });

  it("renders the Steps health metric when step data is present", () => {
    const startDateValue = new Date();
    startDateValue.setDate(startDateValue.getDate() - 6);
    const startDate = formatLocalDate(startDateValue);
    const endDate = formatLocalDate(new Date());

    cy.task("runQuery", {
      query: `
        SELECT steps
        FROM fitness.v_daily_metrics
        WHERE user_id = '${TEST_USER_ID}'
          AND date BETWEEN '${startDate}' AND '${endDate}'
        ORDER BY date ASC
      `,
    }).then((res) => {
      const rows = z.array(dailyMetricsRowSchema).parse(res);
      expect(rows.some((row) => (row.steps ?? 0) > 0)).to.eq(true);
    });

    cy.visit("/dashboard");

    // Steps now surface in the dashboard health monitor rather than a standalone chart.
    cy.contains("Health monitor").should("be.visible");
    cy.contains("span", "Steps")
      .parents(".card")
      .first()
      .should("be.visible")
      .and("contain.text", "9,200");
  });
});
