import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Resolve the dependency used by Metro's file matching.
const mobileRequire = createRequire(new URL("../packages/mobile/package.json", import.meta.url));
const nativeRequire = createRequire(mobileRequire.resolve("react-native/package.json"));
const pluginRequire = createRequire(
  nativeRequire.resolve("@react-native/community-cli-plugin/package.json"),
);
const metroRequire = createRequire(pluginRequire.resolve("metro/package.json"));
const fileMapRequire = createRequire(metroRequire.resolve("metro-file-map/package.json"));
const micromatchRequire = createRequire(fileMapRequire.resolve("micromatch/package.json"));

interface AstNode {
  type: string;
  value?: string;
  nodes?: AstNode[];
}
interface DepthOptions {
  maxDepth?: number;
}
const braces: {
  parse(input: string, options?: DepthOptions): AstNode;
  compile(input: string | AstNode, options?: DepthOptions): string;
  expand(input: string | AstNode, options?: DepthOptions): string[];
  stringify(input: string | AstNode, options?: DepthOptions): string;
} = micromatchRequire("braces");

assert.equal(braces.compile("src/{web,mobile}/*.ts"), "src/(web|mobile)/*.ts");
assert.deepEqual(braces.expand("a{1..3}"), ["a1", "a2", "a3"]);
assert.doesNotThrow(() => braces.parse(`${"{".repeat(100)}a,b${"}".repeat(100)}`));

// Both parser input and directly supplied ASTs must be bounded.
// https://github.com/micromatch/braces/pull/72
for (const [open, close] of [
  ["{", "}"],
  ["(", ")"],
] as const) {
  const input = `${open.repeat(4000)}a,b${close.repeat(4000)}`;
  for (const options of [undefined, { maxDepth: 10000 }, { maxDepth: Number.POSITIVE_INFINITY }]) {
    for (const operation of [braces.parse, braces.compile, braces.expand, braces.stringify]) {
      assert.throws(() => operation(input, options), /exceeds max depth/);
    }
  }
}
assert.throws(() => braces.parse("{{a,b},c}", { maxDepth: 1 }), /exceeds max depth/);
assert.doesNotThrow(() => braces.parse("{{a,b},c}", { maxDepth: 2 }));

for (const operation of [braces.compile, braces.expand, braces.stringify]) {
  let ast: AstNode = { type: "text", value: "a" };
  for (let depth = 0; depth < 101; depth++) ast = { type: "brace", nodes: [ast] };
  assert.throws(() => operation({ type: "root", nodes: [ast] }), /exceeds max depth/);
}
console.log("braces nesting security regressions passed.");
