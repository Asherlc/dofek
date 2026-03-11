import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { publicProcedure, router } from "../../shared/trpc.js";

// Config file lives at project root (alongside supplements.config.ts)
const CONFIG_PATH = resolve(import.meta.dirname, "../../../../supplements.json");

const supplementSchema = z.object({
  name: z.string().min(1).max(200),
  amount: z.number().positive().optional(),
  unit: z.string().max(10).optional(),
  form: z.string().optional(),
  description: z.string().optional(),
  meal: z.enum(["breakfast", "lunch", "dinner", "snack", "other"]).optional(),
  calories: z.number().optional(),
  proteinG: z.number().optional(),
  carbsG: z.number().optional(),
  fatG: z.number().optional(),
  saturatedFatG: z.number().optional(),
  polyunsaturatedFatG: z.number().optional(),
  monounsaturatedFatG: z.number().optional(),
  transFatG: z.number().optional(),
  cholesterolMg: z.number().optional(),
  sodiumMg: z.number().optional(),
  potassiumMg: z.number().optional(),
  fiberG: z.number().optional(),
  sugarG: z.number().optional(),
  vitaminAMcg: z.number().optional(),
  vitaminCMg: z.number().optional(),
  vitaminDMcg: z.number().optional(),
  vitaminEMg: z.number().optional(),
  vitaminKMcg: z.number().optional(),
  vitaminB1Mg: z.number().optional(),
  vitaminB2Mg: z.number().optional(),
  vitaminB3Mg: z.number().optional(),
  vitaminB5Mg: z.number().optional(),
  vitaminB6Mg: z.number().optional(),
  vitaminB7Mcg: z.number().optional(),
  vitaminB9Mcg: z.number().optional(),
  vitaminB12Mcg: z.number().optional(),
  calciumMg: z.number().optional(),
  ironMg: z.number().optional(),
  magnesiumMg: z.number().optional(),
  zincMg: z.number().optional(),
  seleniumMcg: z.number().optional(),
  copperMg: z.number().optional(),
  manganeseMg: z.number().optional(),
  chromiumMcg: z.number().optional(),
  iodineMcg: z.number().optional(),
  omega3Mg: z.number().optional(),
  omega6Mg: z.number().optional(),
});

export type Supplement = z.infer<typeof supplementSchema>;

async function readConfig(): Promise<Supplement[]> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return z.array(supplementSchema).parse(parsed.supplements ?? parsed);
  } catch {
    return [];
  }
}

async function writeConfig(supplements: Supplement[]): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify({ supplements }, null, 2) + "\n");
}

export const supplementsRouter = router({
  list: publicProcedure.query(async () => {
    return readConfig();
  }),

  save: publicProcedure
    .input(z.object({ supplements: z.array(supplementSchema) }))
    .mutation(async ({ input }) => {
      await writeConfig(input.supplements);
      return { success: true, count: input.supplements.length };
    }),
});
