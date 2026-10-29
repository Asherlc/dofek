import { describe, expect, it } from "vitest";
import { OtaMigrationLayout } from "./ota-migration-layout.ts";

const appId = "example-app";
const paths = [
  "main/runtime/123/.check",
  "main/runtime/123/update-metadata.json",
  "main/runtime/123/assets/bundle",
  "orphan/file",
  ".migrationhistory",
];

describe("OTA app-scoped migration layout", () => {
  it("maps every confirmed update asset and leaves unrelated keys in place", () => {
    const layout = new OtaMigrationLayout(paths, appId);
    expect(layout.movedPaths).toEqual(paths.slice(0, 3));
    expect(layout.unchangedPaths).toEqual(["orphan/file"]);
    expect(() =>
      layout.assertMigratedPaths([
        ...paths.slice(0, 3).map((path) => `${appId}/${path}`),
        "orphan/file",
        ".migrationhistory",
      ]),
    ).not.toThrow();
  });
  it.each(["missing", "left behind", "unexpected"])(
    "rejects %s objects after migration",
    (scenario) => {
      const layout = new OtaMigrationLayout(paths, appId);
      const actual = [
        ...paths.slice(0, 3).map((path) => `${appId}/${path}`),
        "orphan/file",
        ".migrationhistory",
      ];
      if (scenario === "missing") actual.pop();
      if (scenario === "left behind") actual.push(paths[0] ?? "");
      if (scenario === "unexpected") actual.push("other/unknown");
      expect(() => layout.assertMigratedPaths(actual)).toThrow("object set");
    },
  );
  it("rejects a source with no legacy update markers", () => {
    expect(() => new OtaMigrationLayout(["orphan/file"], appId)).toThrow("legacy update");
  });
});
