import type { Database } from "dofek/db";
import {
  type CreateFoodEntryInput as CreateFoodEntryInputData,
  FoodEntryCreateRepository,
  type QuickAddInput as QuickAddInputData,
} from "./food-entry-create-repository.ts";
import {
  DailyNutritionSummary as DailyNutritionSummaryModel,
  FoodEntry as FoodEntryModel,
  type FoodEntryRow as FoodEntryRowData,
  foodEntryRowSchema as foodEntrySchema,
} from "./food-entry-models.ts";
import {
  FoodEntryUpdateRepository,
  type UpdateFoodEntryInput as UpdateFoodEntryInputData,
} from "./food-entry-update-repository.ts";
import { FoodReadRepository } from "./food-read-repository.ts";

export const DailyNutritionSummary = DailyNutritionSummaryModel;
export type DailyNutritionSummary = DailyNutritionSummaryModel;
export const FoodEntry = FoodEntryModel;
export type FoodEntry = FoodEntryModel;
export type FoodEntryRow = FoodEntryRowData;
export const foodEntryRowSchema = foodEntrySchema;
export type CreateFoodEntryInput = CreateFoodEntryInputData;
export type QuickAddInput = QuickAddInputData;
export type UpdateFoodEntryInput = UpdateFoodEntryInputData;

/**
 * Compatibility surface for food reads and user-owned mutations.
 *
 * Focused collaborators own the query and mutation responsibilities while
 * existing consumers retain the established repository API.
 */
export class FoodRepository extends FoodReadRepository {
  readonly #createRepository: FoodEntryCreateRepository;
  readonly #updateRepository: FoodEntryUpdateRepository;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    super(db, userId, timezone);
    this.#createRepository = new FoodEntryCreateRepository(db, userId, timezone);
    this.#updateRepository = new FoodEntryUpdateRepository(db, userId, timezone);
  }

  async ensureDofekProvider(): Promise<void> {
    await this.#createRepository.ensureDofekProvider();
  }

  async create(
    input: CreateFoodEntryInput,
  ): Promise<FoodEntryRow & { nutrients: Record<string, number> }> {
    return this.#createRepository.create(input);
  }

  async update(input: UpdateFoodEntryInput): Promise<FoodEntryRow | null> {
    return this.#updateRepository.update(input);
  }

  async delete(id: string): Promise<{ success: boolean }> {
    return this.#updateRepository.delete(id);
  }

  async quickAdd(
    input: QuickAddInput,
  ): Promise<(FoodEntryRow & { nutrients: Record<string, number> }) | undefined> {
    return this.#createRepository.quickAdd(input);
  }
}
