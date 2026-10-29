/** Expected key relocation performed by xprem's app-scoping bucket migration. */
export class OtaMigrationLayout {
  readonly movedPaths: string[];
  readonly unchangedPaths: string[];
  readonly #expectedPaths: Set<string>;

  constructor(paths: readonly string[], appId: string) {
    if (!appId || appId.includes("/") || /[\r\n\0]/.test(appId))
      throw new Error("Invalid Expo app ID");
    for (const path of paths) {
      if (
        !path ||
        path.startsWith("/") ||
        path.split("/").some((part) => part === ".." || part === ".") ||
        path.includes("\0")
      ) {
        throw new Error("Unsafe OTA object path");
      }
    }
    const triples = new Set(
      paths
        .filter((path) => /^[^/]+\/[^/]+\/[^/]+\/(?:\.check|update-metadata\.json)$/.test(path))
        .map((path) => path.split("/").slice(0, 3).join("/")),
    );
    if (triples.size === 0) throw new Error("Snapshot contains no legacy update markers");
    this.movedPaths = paths.filter((path) => triples.has(path.split("/").slice(0, 3).join("/")));
    const moved = new Set(this.movedPaths);
    this.unchangedPaths = paths.filter((path) => path !== ".migrationhistory" && !moved.has(path));
    this.#expectedPaths = new Set([
      ...this.movedPaths.map((path) => `${appId}/${path}`),
      ...this.unchangedPaths,
      ".migrationhistory",
    ]);
  }

  assertMigratedPaths(paths: readonly string[]): void {
    const actual = new Set(paths);
    if (
      actual.size !== this.#expectedPaths.size ||
      [...this.#expectedPaths].some((path) => !actual.has(path))
    ) {
      throw new Error("Migrated OTA object set differs from the snapshot's expected layout");
    }
  }
}
