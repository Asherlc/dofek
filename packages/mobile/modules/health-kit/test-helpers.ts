import type { queryAnchoredSamples } from "./index";

type AnchoredQueryResult = Awaited<ReturnType<typeof queryAnchoredSamples>>;

export function createEmptyAnchoredQueryResult(): AnchoredQueryResult {
  return {
    queryId: null,
    samples: [],
    deletedUUIDs: [],
  };
}
