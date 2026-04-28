import { daysBefore, type SeedRandom, type Sql, timestampAt, USER_ID } from "./helpers.ts";

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
    const [{ id: foodEntryId }] = await sql<FoodEntryRow[]>`
      INSERT INTO fitness.food_entry (
        provider_id, user_id, external_id, date, food_name, source_name, logged_at, confirmed
      ) VALUES (
        'apple_health', ${USER_ID}, ${`seed-daily-nutrition-${daysAgo}`}, ${date},
        NULL, 'Seed daily total', ${timestampAt(date, 12, 0)}, true
      )
      ON CONFLICT (user_id, provider_id, external_id) DO UPDATE
        SET date = EXCLUDED.date,
            food_name = EXCLUDED.food_name,
            source_name = EXCLUDED.source_name,
            logged_at = EXCLUDED.logged_at,
            confirmed = EXCLUDED.confirmed
      RETURNING id
    `;

    await sql`DELETE FROM fitness.food_entry_nutrient WHERE food_entry_id = ${foodEntryId}`;
    await sql`
      INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
      SELECT ${foodEntryId}, nutrient_id, amount
      FROM (VALUES
        ('calories', ${calories}::real),
        ('protein', ${random.int(135, 185)}::real),
        ('carbohydrate', ${trainingDay ? random.int(250, 380) : random.int(160, 260)}::real),
        ('fat', ${random.int(62, 98)}::real),
        ('saturated_fat', ${random.int(16, 28)}::real),
        ('cholesterol', ${random.int(120, 260)}::real),
        ('sodium', ${random.int(1_800, 3_100)}::real),
        ('potassium', ${random.int(2_800, 4_500)}::real),
        ('fiber', ${random.int(24, 46)}::real),
        ('sugar', ${random.int(35, 85)}::real),
        ('vitamin_c', ${random.int(60, 150)}::real),
        ('vitamin_d', ${random.int(12, 42)}::real),
        ('calcium', ${random.int(720, 1_250)}::real),
        ('iron', ${random.float(9, 18, 1)}::real),
        ('magnesium', ${random.int(280, 520)}::real),
        ('zinc', ${random.float(9, 17, 1)}::real),
        ('omega_3', ${random.int(850, 1_800)}::real),
        ('water', ${random.int(2_200, 3_800)}::real)
      ) AS nutrient_values(nutrient_id, amount)
    `;
  }
}

async function seedFoodEntries(sql: Sql, random: SeedRandom, today: Date): Promise<void> {
  const meals = [
    [
      "breakfast",
      "Greek yogurt bowl",
      "Greek yogurt, berries, oats, and walnuts",
      "cheese_milk_and_dairy",
    ],
    ["lunch", "Chicken rice bowl", "Chicken breast, rice, black beans, salsa, and avocado", "meat"],
    [
      "dinner",
      "Salmon plate",
      "Salmon, roasted potatoes, greens, and olive oil",
      "fish_and_seafood",
    ],
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

      await sql`DELETE FROM fitness.food_entry_nutrient WHERE food_entry_id = ${foodEntryId}`;
      await sql`
        INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
        SELECT ${foodEntryId}, nutrient_id, amount
        FROM (VALUES
          ('calories', ${calories + random.int(-35, 35)}::real),
          ('protein', ${meal === "breakfast" ? 38 : meal === "lunch" ? 54 : 48}::real),
          ('carbohydrate', ${meal === "breakfast" ? 58 : meal === "lunch" ? 92 : 74}::real),
          ('fat', ${meal === "breakfast" ? 15 : meal === "lunch" ? 24 : 36}::real),
          ('saturated_fat', ${meal === "dinner" ? 8 : 4}::real),
          ('sodium', ${random.int(420, 920)}::real),
          ('potassium', ${random.int(650, 1_250)}::real),
          ('fiber', ${meal === "breakfast" ? 9 : 12}::real),
          ('sugar', ${meal === "breakfast" ? 24 : 9}::real),
          ('vitamin_c', ${random.int(18, 75)}::real),
          ('vitamin_d', ${meal === "dinner" ? 18 : 4}::real),
          ('calcium', ${random.int(180, 420)}::real),
          ('iron', ${random.float(2.4, 5.2, 1)}::real),
          ('magnesium', ${random.int(85, 180)}::real),
          ('zinc', ${random.float(2.1, 5.4, 1)}::real),
          ('omega_3', ${meal === "dinner" ? 1_200 : 260}::real)
        ) AS nutrient_values(nutrient_id, amount)
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

    await sql`DELETE FROM fitness.supplement_nutrient WHERE supplement_id = ${supplementId}`;
    await sql`
      INSERT INTO fitness.supplement_nutrient (supplement_id, nutrient_id, amount)
      SELECT ${supplementId}, nutrient_id, amount
      FROM (VALUES
        ('vitamin_d', ${vitaminDMcg}::real),
        ('calcium', ${calciumMg}::real),
        ('magnesium', ${magnesiumMg}::real),
        ('zinc', ${zincMg}::real),
        ('omega_3', ${omega3Mg}::real)
      ) AS nutrient_values(nutrient_id, amount)
      WHERE amount > 0
    `;
  }
}
