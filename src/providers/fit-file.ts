import type { ImportProvider } from "./types.ts";

export const FIT_FILE_PROVIDER_ID = "fit-file";

export class FitFileProvider implements ImportProvider {
  readonly id = FIT_FILE_PROVIDER_ID;
  readonly name = "FIT File";
  readonly importOnly = true as const;

  validate(): string | null {
    return null;
  }
}
