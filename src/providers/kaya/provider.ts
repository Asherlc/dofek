import type { ImportProvider } from "../types.ts";

export const KAYA_PROVIDER_ID = "kaya-export";
export const KAYA_PROVIDER_NAME = "Kaya";

export class KayaProvider implements ImportProvider {
  readonly id = KAYA_PROVIDER_ID;
  readonly name = KAYA_PROVIDER_NAME;
  readonly importOnly = true as const;

  validate(): string | null {
    return null;
  }
}
