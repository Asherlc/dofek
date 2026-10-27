import type { ClimbingCatalogueAdapter } from "@dofek/training/climbing-catalogue";
import type { Database } from "./db/index.ts";
import { loadTokens } from "./db/tokens.ts";
import { createProviderRateLimitFetch } from "./lib/provider-rate-limit-fetch.ts";
import { KayaCatalogueAdapter } from "./providers/kaya/catalogue.ts";
import { MountainProjectCatalogueAdapter } from "./providers/mountain-project-catalogue.ts";
import { OpenBetaCatalogueAdapter } from "./providers/openbeta-catalogue.ts";
import { TheCragCatalogueAdapter } from "./providers/thecrag/catalogue.ts";
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
