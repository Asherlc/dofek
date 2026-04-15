const TEST_USER_ID = "e2e00000-0000-0000-0000-000000000001";
const E2E_PROVIDER_ID = "e2e-test-provider";

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
      return { date: date.toISOString().slice(0, 10), steps: 8000 + index * 200 };
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
    // Intercept the tRPC dailyMetrics.list call so we can wait for it to resolve
    cy.intercept("GET", /trpc\/dailyMetrics\.list/).as("dailyMetricsList");

    cy.visit("/dashboard");

    // Wait for the API response to arrive
    cy.wait("@dailyMetricsList");

    // The "Daily Steps" section heading must be present
    cy.contains("h2", "Daily Steps").should("exist");

    // ECharts renders a <canvas> inside the chart — it must exist (not "No data available")
    cy.contains("h2", "Daily Steps").closest("section").find("canvas").should("exist");

    // The empty-state message must NOT appear inside the steps section
    cy.contains("h2", "Daily Steps")
      .closest("section")
      .should("not.contain.text", "No data available");
  });
});
