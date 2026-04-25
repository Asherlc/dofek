import { USER_ID, daysBefore, timestampAt, type SeedRandom, type Sql } from "./helpers.ts";

interface FoodEntryRow {
  id: string;
}

interface SupplementRow {
  id: string;
}

export async function seedNutrition(sql: Sql, random: SeedRandom): Promise<void> {
  const today = new Date();
  await seedDailyNutrition(sql, random, today);
  await seedFoodEntries(sql, random, today);
  await seedSupplements(sql);
  console.log("Seeded: 90 days of nutrition, meal entries, and supplements");
}

async function seedDailyNutrition(sql: Sql, random: SeedRandom, today: Date): Promise<void> {
  for (let daysAgo = 0; daysAgo < 90; daysAgo++) {
    const date = daysBefore(today, daysAgo);
    const trainingDay = daysAgo % 7 !== 0;
    const calories = trainingDay ? random.int(2_250, 2_850) : random.int(1_950, 2_350);
    await sql`
      INSERT INTO fitness.nutrition_daily (
        date, provider_id, user_id, calories, protein_g, carbs_g, fat_g,
        saturated_fat_g, cholesterol_mg, sodium_mg, potassium_mg, fiber_g,
        sugar_g, vitamin_c_mg, vitamin_d_mcg, calcium_mg, iron_mg,
        magnesium_mg, zinc_mg, omega3_mg, water_ml
      ) VALUES (
        ${date}, 'apple_health', ${USER_ID}, ${calories}, ${random.int(135, 185)},
        ${trainingDay ? random.int(250, 380) : random.int(160, 260)}, ${random.int(62, 98)},
        ${random.int(16, 28)}, ${random.int(120, 260)}, ${random.int(1_800, 3_100)},
        ${random.int(2_800, 4_500)}, ${random.int(24, 46)}, ${random.int(35, 85)},
        ${random.int(60, 150)}, ${random.int(12, 42)}, ${random.int(720, 1_250)},
        ${random.float(9, 18, 1)}, ${random.int(280, 520)}, ${random.float(9, 17, 1)},
        ${random.int(850, 1_800)}, ${random.int(2_200, 3_800)}
      ) ON CONFLICT DO NOTHING
    `;
  }
}

async function seedFoodEntries(sql: Sql, random: SeedRandom, today: Date): Promise<void> {
  const meals = [
    ["breakfast", "Greek yogurt bowl", "Greek yogurt, berries, oats, and walnuts", "cheese_milk_and_dairy"],
    ["lunch", "Chicken rice bowl", "Chicken breast, rice, black beans, salsa, and avocado", "meat"],
    ["dinner", "Salmon plate", "Salmon, roasted potatoes, greens, and olive oil", "fish_and_seafood"],
  ] as const;

  for (let daysAgo = 0; daysAgo < 8; daysAgo++) {
    const date = daysBefore(today, daysAgo);
    for (const [mealIndex, [meal, foodName, foodDescription, category]] of meals.entries()) {
      const calories = meal === "breakfast" ? 520 : meal === "lunch" ? 760 : 840;
      const [{ id: foodEntryId }] = await sql<FoodEntryRow[]>`
        INSERT INTO fitness.food_entry (
          provider_id, user_id, external_id, date, meal, food_name, food_description,
          category, number_of_units, logged_at, serving_unit, serving_weight_grams, confirmed
        ) VALUES (
          'manual_review', ${USER_ID}, ${`seed-food-${daysAgo}-${meal}`}, ${date}, ${meal},
          ${foodName}, ${foodDescription}, ${category}, 1, ${timestampAt(date, 8 + mealIndex * 5, 10)},
          'serving', ${meal === "breakfast" ? 340 : 480}, true
        ) RETURNING id
      `;

      await sql`
        INSERT INTO fitness.food_entry_nutrition (
          food_entry_id, calories, protein_g, carbs_g, fat_g, saturated_fat_g,
          sodium_mg, potassium_mg, fiber_g, sugar_g, vitamin_c_mg, vitamin_d_mcg,
          calcium_mg, iron_mg, magnesium_mg, zinc_mg, omega3_mg
        ) VALUES (
          ${foodEntryId}, ${calories + random.int(-35, 35)},
          ${meal === "breakfast" ? 38 : meal === "lunch" ? 54 : 48},
          ${meal === "breakfast" ? 58 : meal === "lunch" ? 92 : 74},
          ${meal === "breakfast" ? 15 : meal === "lunch" ? 24 : 36},
          ${meal === "dinner" ? 8 : 4}, ${random.int(420, 920)}, ${random.int(650, 1_250)},
          ${meal === "breakfast" ? 9 : 12}, ${meal === "breakfast" ? 24 : 9},
          ${random.int(18, 75)}, ${meal === "dinner" ? 18 : 4}, ${random.int(180, 420)},
          ${random.float(2.4, 5.2, 1)}, ${random.int(85, 180)}, ${random.float(2.1, 5.4, 1)},
          ${meal === "dinner" ? 1_200 : 260}
        )
      `;
    }
  }
}

async function seedSupplements(sql: Sql): Promise<void> {
  const supplements = [
    ["Vitamin D3", 2_000, "IU", "softgel", "breakfast", 0, 50, 0, 0, 0, 50],
    ["Magnesium Glycinate", 300, "mg", "capsule", "dinner", 1, 0, 0, 300, 0, 0],
    ["Creatine Monohydrate", 5, "g", "powder", "breakfast", 2, 0, 0, 0, 0, 0],
    ["Omega-3", 1_200, "mg", "softgel", "lunch", 3, 0, 0, 0, 0, 1_200],
  ] as const;

  for (const [
    name,
    amount,
    unit,
    form,
    meal,
    sortOrder,
    vitaminDMcg,
    calciumMg,
    magnesiumMg,
    zincMg,
    omega3Mg,
  ] of supplements) {
    const [{ id: supplementId }] = await sql<SupplementRow[]>`
      INSERT INTO fitness.supplement (
        user_id, name, amount, unit, form, description, meal, sort_order
      ) VALUES (
        ${USER_ID}, ${name}, ${amount}, ${unit}, ${form}, 'Review seed supplement',
        ${meal}, ${sortOrder}
      )
      ON CONFLICT (user_id, name) DO UPDATE
        SET amount = EXCLUDED.amount,
            unit = EXCLUDED.unit,
            form = EXCLUDED.form,
            description = EXCLUDED.description,
            meal = EXCLUDED.meal,
            sort_order = EXCLUDED.sort_order,
            updated_at = NOW()
      RETURNING id
    `;

    await sql`
      INSERT INTO fitness.supplement_nutrition (
        supplement_id, vitamin_d_mcg, calcium_mg, magnesium_mg, zinc_mg, omega3_mg
      ) VALUES (
        ${supplementId}, ${vitaminDMcg}, ${calciumMg}, ${magnesiumMg}, ${zincMg}, ${omega3Mg}
      )
      ON CONFLICT (supplement_id) DO UPDATE
        SET vitamin_d_mcg = EXCLUDED.vitamin_d_mcg,
            calcium_mg = EXCLUDED.calcium_mg,
            magnesium_mg = EXCLUDED.magnesium_mg,
            zinc_mg = EXCLUDED.zinc_mg,
            omega3_mg = EXCLUDED.omega3_mg,
            updated_at = NOW()
    `;
  }
}
