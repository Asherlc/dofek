import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { activity } from "./activity.ts";
import { provider } from "./reference.ts";

describe("activity absence attribution", () => {
  it("resolves the confirming-provider relationship independently of the record provider", () => {
    const references = getTableConfig(activity).foreignKeys.map((key) => key.reference());
    const absenceReference = references.find((reference) =>
      reference.columns.includes(activity.absenceProviderId),
    );

    expect(absenceReference?.foreignTable).toBe(provider);
    expect(absenceReference?.foreignColumns).toEqual([provider.id]);
    expect(activity.absenceProviderId.notNull).toBe(false);
  });
});
