import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

interface Mixin {
  _performSideEffectsForTransition(
    current: string,
    next: string,
    signal: string,
    event: object,
  ): void;
}

async function main() {
  const { storybookReactNativeWeb } = await import("@storybook/react-native-web-vite/vite-plugin");
  const { build } = await import("vite");
  const mobileRoot = fileURLToPath(new URL("..", import.meta.url));
  const require = createRequire(import.meta.url);
  const svgRoot = dirname(require.resolve("react-native-svg/package.json"));

  // Link the actual distributed and source browser entries. Keep the framework's
  // platform resolution, but require every imported export to exist.
  for (const entry of ["lib/module/index.js", "src/index.ts"]) {
    await build({
      configFile: false,
      root: mobileRoot,
      logLevel: "error",
      plugins: [
        ...storybookReactNativeWeb(),
        {
          name: "strict-svg-platform-link",
          enforce: "post",
          config: () => ({
            build: { rolldownOptions: { shimMissingExports: false } },
            // Use the same asset registry as the mobile Storybook browser.
            resolve: {
              alias: [
                {
                  find: /^(react-native\/asset-registry|@react-native\/assets-registry\/registry)$/,
                  replacement: require.resolve(
                    "react-native-web/dist/modules/AssetRegistry/index.js",
                  ),
                },
              ],
            },
          }),
        },
      ],
      build: {
        write: false,
        lib: { entry: resolve(svgRoot, entry), formats: ["es"] },
      },
    });
  }

  for (const platform of ["android", "ios", "web"]) {
    for (const disabled of [false, true]) {
      let lookups = 0;
      let sounds = 0;
      let presses = 0;
      const modules = new Map<string, { exports: unknown }>();
      function loadModule(path: string): unknown {
        const candidates =
          platform === "web"
            ? [`${path}.web.js`, `${path}.js`]
            : [`${path}.native.js`, `${path}.js`];
        const resolved = candidates.find((candidate) => existsSync(candidate));
        assert.ok(resolved, `Missing SVG module ${path}`);
        const cached = modules.get(resolved);
        if (cached) return cached.exports;
        const module = { exports: {} };
        modules.set(resolved, module);
        const localRequire = (specifier: string): unknown => {
          if (specifier === "react-native") {
            return {
              Platform: { OS: platform },
              TurboModuleRegistry: {
                getEnforcing(name: string) {
                  lookups += 1;
                  assert.equal(platform, "android", "Only Android has the sound module");
                  assert.equal(name, "RNSVGSoundModule");
                  return { playTouchSound: () => (sounds += 1) };
                },
              },
            };
          }
          assert.ok(specifier.startsWith("."), `Unexpected dependency ${specifier}`);
          return loadModule(resolve(dirname(resolved), specifier));
        };
        runInNewContext(readFileSync(resolved, "utf8"), {
          module,
          exports: module.exports,
          require: localRequire,
          clearTimeout,
        });
        return module.exports;
      }
      const loaded = loadModule(resolve(svgRoot, "lib/commonjs/lib/SvgTouchableMixin"));
      assert.ok(
        isMixinInstallerModule(loaded),
        "SVG must export its press state machine installer",
      );
      assert.equal(lookups, 0, `${platform}: importing SVG must not load the Android module`);
      const instance = {
        props: { touchSoundDisabled: disabled, onPress: () => (presses += 1) },
      };
      loaded.default(instance);
      assert.ok(isMixin(instance), "SVG must install its press state machine");
      instance._performSideEffectsForTransition(
        "RESPONDER_ACTIVE_PRESS_IN",
        "NOT_RESPONDER",
        "RESPONDER_RELEASE",
        {},
      );
      const expectedSounds = platform === "android" && !disabled ? 1 : 0;
      assert.equal(lookups, expectedSounds, `${platform}, disabled=${disabled}: native lookup`);
      assert.equal(sounds, expectedSounds, `${platform}, disabled=${disabled}: touch sound`);
      assert.equal(presses, 1, `${platform}, disabled=${disabled}: onPress remains intact`);
    }
  }

  console.log("SVG browser linking and Android/iOS/web press regressions passed.");
}

function isMixinInstallerModule(value: unknown): value is { default: (target: object) => void } {
  return (
    typeof value === "object" &&
    value !== null &&
    "default" in value &&
    typeof value.default === "function"
  );
}

function isMixin(value: object): value is Mixin {
  return (
    "_performSideEffectsForTransition" in value &&
    typeof value._performSideEffectsForTransition === "function"
  );
}

void main();
