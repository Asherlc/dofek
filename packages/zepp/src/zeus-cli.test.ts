import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { CommonJsRequire } from "./zeus-cli.ts";
import { runZeusCli } from "./zeus-cli.ts";

const ZEUS_PACKAGE_JSON_PATH =
  "/workspace/packages/zepp/node_modules/@zeppos/zeus-cli/package.json";
const ZEUS_PACKAGE_DIR = path.dirname(ZEUS_PACKAGE_JSON_PATH);
const MODULE_ALIAS_PATH = "/workspace/packages/zepp/node_modules/module-alias/index.js";
const ZEUS_MAIN_PATH = path.join(ZEUS_PACKAGE_DIR, "bin/main.js");

function createFakeRequire(moduleAlias: unknown) {
  const loadedIds: string[] = [];
  const resolveCalls: Array<{ id: string; paths?: string[] }> = [];

  const commonJsRequire = Object.assign(
    (id: string): unknown => {
      loadedIds.push(id);
      if (id === MODULE_ALIAS_PATH) {
        return moduleAlias;
      }
      if (id === ZEUS_MAIN_PATH) {
        return {};
      }
      throw new Error(`Unexpected require: ${id}`);
    },
    {
      resolve: (id: string, options?: { paths?: string[] }): string => {
        resolveCalls.push({ id, paths: options?.paths });
        if (id === "@zeppos/zeus-cli/package.json") {
          return ZEUS_PACKAGE_JSON_PATH;
        }
        if (id === "module-alias") {
          expect(options?.paths).toEqual([ZEUS_PACKAGE_DIR]);
          return MODULE_ALIAS_PATH;
        }
        throw new Error(`Unexpected require.resolve: ${id}`);
      },
    },
  ) satisfies CommonJsRequire;

  return { commonJsRequire, loadedIds, resolveCalls };
}

describe("runZeusCli", () => {
  it("aliases Zeus private modules before loading the CLI", () => {
    const addAlias = vi.fn();
    const moduleAlias = Object.assign(() => undefined, { addAlias });
    const { commonJsRequire, loadedIds, resolveCalls } = createFakeRequire(moduleAlias);

    runZeusCli(commonJsRequire);

    expect(resolveCalls).toEqual([
      { id: "@zeppos/zeus-cli/package.json", paths: undefined },
      { id: "module-alias", paths: [ZEUS_PACKAGE_DIR] },
    ]);
    expect(addAlias).toHaveBeenCalledWith(
      "zeppos-app-utils",
      path.join(ZEUS_PACKAGE_DIR, "private-modules/zeppos-app-utils"),
    );
    expect(loadedIds).toEqual([MODULE_ALIAS_PATH, ZEUS_MAIN_PATH]);
  });

  it("accepts object-shaped module-alias exports", () => {
    const addAlias = vi.fn();
    const { commonJsRequire, loadedIds } = createFakeRequire({ addAlias });

    runZeusCli(commonJsRequire);

    expect(addAlias).toHaveBeenCalledWith(
      "zeppos-app-utils",
      path.join(ZEUS_PACKAGE_DIR, "private-modules/zeppos-app-utils"),
    );
    expect(loadedIds).toEqual([MODULE_ALIAS_PATH, ZEUS_MAIN_PATH]);
  });

  it.each([{}, null, undefined, "module-alias"])(
    "fails before loading Zeus when module-alias exports %s",
    (moduleAlias) => {
      const { commonJsRequire, loadedIds } = createFakeRequire(moduleAlias);

      expect(() => runZeusCli(commonJsRequire)).toThrow(
        "Zeus CLI module-alias dependency is missing addAlias()",
      );
      expect(loadedIds).toEqual([MODULE_ALIAS_PATH]);
    },
  );
});
