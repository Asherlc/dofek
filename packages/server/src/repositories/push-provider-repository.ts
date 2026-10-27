import { providerLabel } from "@dofek/providers/providers";
import type { Database } from "dofek/db";
import { ensureProvider } from "dofek/db/tokens";

export async function ensurePushProvider({
  database,
  providerId,
  providerName,
  userId,
}: {
  database: Pick<Database, "execute">;
  providerId: string;
  providerName?: string;
  userId: string;
}): Promise<void> {
  await ensureProvider(
    database,
    providerId,
    providerName ?? providerLabel(providerId),
    undefined,
    userId,
  );
}
