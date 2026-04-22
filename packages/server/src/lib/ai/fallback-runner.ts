import { type AiProviderConfig, aiProviderEnvVarNames } from "./providers.ts";
import { isRetryableProviderError } from "./retryable-errors.ts";

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
  noProviderEnvVarNames = aiProviderEnvVarNames,
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
