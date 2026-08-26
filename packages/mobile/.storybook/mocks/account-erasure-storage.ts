interface Preparation {
  cleanupOwnerNonce?: string;
  expiresAt: string;
  ownerUserId: string;
  preparationToken: string;
}

let preparation: Preparation | null = null;

function scenario(): string | undefined {
  return globalThis.__dofekStorybookAccountErasureScenario;
}

declare global {
  var __dofekStorybookAccountErasureScenario: string | undefined;
}

export async function clearMobileAccountErasurePreparation(): Promise<void> {
  preparation = null;
}

export async function loadMobileAccountErasurePreparation(): Promise<Preparation | null> {
  return preparation;
}

export async function markMobileAccountErasureConfirmationAttempted(cleanupOwnerNonce: string) {
  if (!preparation) throw new Error("Account deletion was not prepared.");
  preparation = { ...preparation, cleanupOwnerNonce };
  return preparation;
}

export async function saveMobileAccountErasurePreparation(next: Preparation): Promise<void> {
  preparation = next;
}

export async function saveMobileAccountErasureStatusCapability(): Promise<void> {
  if (scenario() === "accepted") {
    throw new Error("Local status storage is unavailable.");
  }
}
