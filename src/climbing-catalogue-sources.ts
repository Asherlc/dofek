import type { ClimbingCatalogueAdapter } from "@dofek/climbing-catalogue/contracts";
import { KayaCatalogueAdapter } from "@dofek/climbing-catalogue/kaya";
import { MountainProjectCatalogueAdapter } from "@dofek/climbing-catalogue/mountain-project";
import { OpenBetaCatalogueAdapter } from "@dofek/climbing-catalogue/openbeta";
import { TheCragCatalogueAdapter } from "@dofek/climbing-catalogue/thecrag";
import type { Database } from "./db/index.ts";
import { loadTokens } from "./db/tokens.ts";
import { createProviderRateLimitFetch } from "./lib/provider-rate-limit-fetch.ts";
import { createTheCragPublicFetch } from "./providers/thecrag/public-transport.ts";

export function createClimbingCatalogueAdapters(
  userId: string,
  db: Pick<Database, "execute" | "select">,
): ClimbingCatalogueAdapter[] {
  return [
    new KayaCatalogueAdapter(
      createProviderRateLimitFetch("kaya", globalThis.fetch, { userId }),
      async () => (await loadTokens(db, "kaya", userId))?.accessToken ?? null,
    ),
    new MountainProjectCatalogueAdapter(
      createProviderRateLimitFetch("mountain-project", globalThis.fetch, { userId }),
    ),
    new TheCragCatalogueAdapter(
      createProviderRateLimitFetch("thecrag", createTheCragPublicFetch(), { userId }),
    ),
    new OpenBetaCatalogueAdapter(
      createProviderRateLimitFetch("openbeta", globalThis.fetch, { userId }),
    ),
  ];
}
