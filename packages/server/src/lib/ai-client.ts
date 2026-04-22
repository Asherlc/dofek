import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import type { LanguageModel } from "ai";

export interface AiProviderConfig {
  name: string;
  createModel: () => LanguageModel;
}

const defaultProviderEnvVarNames = ["GEMINI_API_KEY", "MISTRAL_API_KEY"] as const;

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

export function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("rate limit") ||
      message.includes("quota") ||
      message.includes("429") ||
      message.includes("too many requests") ||
      message.includes("resource_exhausted") ||
      message.includes("high demand")
    );
  }
  return false;
}

interface RunWithProviderFallbackOptions<TOutput> {
  providers: AiProviderConfig[];
  runForProvider: (provider: AiProviderConfig) => Promise<TOutput>;
  noProviderEnvVarNames?: readonly string[];
}

interface RunWithProviderFallbackResult<TOutput> {
  output: TOutput;
  provider: string;
}

export async function runWithProviderFallback<TOutput>({
  providers,
  runForProvider,
  noProviderEnvVarNames = defaultProviderEnvVarNames,
}: RunWithProviderFallbackOptions<TOutput>): Promise<RunWithProviderFallbackResult<TOutput>> {
  if (providers.length === 0) {
    throw new Error(
      `No AI providers configured. Set at least one of: ${noProviderEnvVarNames.join(", ")}`,
    );
  }

  let lastError: unknown;

  for (const provider of providers) {
    try {
      const output = await runForProvider(provider);
      return {
        output,
        provider: provider.name,
      };
    } catch (error) {
      lastError = error;
      if (isRetryableProviderError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `All AI providers rate-limited. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
