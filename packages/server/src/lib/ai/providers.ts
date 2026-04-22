import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import type { LanguageModel } from "ai";

export interface AiProviderConfig {
  name: string;
  createModel: () => LanguageModel;
}

export const aiProviderEnvVarNames = ["GEMINI_API_KEY", "MISTRAL_API_KEY"] as const;

export function getConfiguredAiProviders(): AiProviderConfig[] {
  const providers: AiProviderConfig[] = [];

  if (process.env.GEMINI_API_KEY) {
    providers.push({
      name: "gemini",
      createModel: () => {
        const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
        return google("gemini-2.5-flash");
      },
    });
  }

  if (process.env.MISTRAL_API_KEY) {
    providers.push({
      name: "mistral",
      createModel: () => {
        const mistral = createMistral({ apiKey: process.env.MISTRAL_API_KEY });
        return mistral("mistral-small-latest");
      },
    });
  }

  return providers;
}
