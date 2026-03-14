const TEST_USER_ID = "e2e00000-0000-0000-0000-000000000001";
const TEST_SESSION_ID = "e2e-test-session-token-cypress";

declare global {
  namespace Cypress {
    interface Chainable {
      /** Seed a test user and set a valid session cookie so subsequent requests are authenticated. */
      login(): Chainable<void>;
      /** Remove test user and session data from the database. */
      cleanTestData(): Chainable<void>;
    }
  }
}

Cypress.Commands.add("login", () => {
  cy.task("seedTestUser", {
    userId: TEST_USER_ID,
    name: "E2E Test User",
    email: "e2e@test.local",
  });
  cy.task("createSession", {
    sessionId: TEST_SESSION_ID,
    userId: TEST_USER_ID,
  });
  cy.setCookie("session", TEST_SESSION_ID, { path: "/" });
});

Cypress.Commands.add("cleanTestData", () => {
  cy.task("cleanTestData", { userId: TEST_USER_ID });
});
