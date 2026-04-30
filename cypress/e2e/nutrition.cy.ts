import { formatLocalDate } from "./test-helpers";

const TEST_USER_ID = "e2e00000-0000-0000-0000-000000000001";

describe("Nutrition page", () => {
  beforeEach(() => {
    cy.login();
    // Ensure dofek provider exists for test food entries
    cy.task("runQuery", {
      query: `INSERT INTO fitness.provider (id, name, user_id)
              VALUES ('dofek', 'Dofek App', '${TEST_USER_ID}')
              ON CONFLICT (id) DO NOTHING`,
    });
  });

  afterEach(() => {
    cy.task("runQuery", {
      query: `DELETE FROM fitness.food_entry WHERE user_id = '${TEST_USER_ID}'`,
    });
    cy.task("runQuery", {
      query: `DELETE FROM fitness.provider WHERE id = 'dofek' AND user_id = '${TEST_USER_ID}'`,
    });
    cy.cleanTestData();
  });

  it("renders food entries that have null calories without crashing", () => {
    const today = formatLocalDate(new Date());

    // Insert food entries with nutrition rows (one with calories, one without)
    cy.task("runQuery", {
      query: `
        WITH fe1 AS (
          INSERT INTO fitness.food_entry (user_id, provider_id, date, food_name, meal)
          VALUES ('${TEST_USER_ID}', 'dofek', '${today}', 'Chicken breast', 'lunch')
          RETURNING id
        ),
        fe2 AS (
          INSERT INTO fitness.food_entry (user_id, provider_id, date, food_name, meal)
          VALUES ('${TEST_USER_ID}', 'dofek', '${today}', 'Mystery food', 'dinner')
          RETURNING id
        )
        INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
        VALUES
          ((SELECT id FROM fe1), 'calories', 350),
          ((SELECT id FROM fe1), 'protein', 40)
      `,
    });

    cy.visit("/nutrition");

    // Page should render both entries without a Zod parse error
    cy.contains("Chicken breast").should("be.visible");
    cy.contains("Mystery food").should("be.visible");

    // The entry with calories should show its value
    cy.contains("350 kcal").should("be.visible");
  });
});
