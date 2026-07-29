import "./commands";

beforeEach(() => {
  // Service-worker-served HTML bypasses Cypress's proxy and test instrumentation:
  // https://github.com/cypress-io/cypress/issues/21213
  cy.intercept("GET", "/sw.js", {
    body: "",
    headers: { "content-type": "application/javascript" },
    statusCode: 200,
  });
});
