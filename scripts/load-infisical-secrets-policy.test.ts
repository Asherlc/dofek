import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const actionPath = path.resolve(".github/actions/load-infisical-secrets/action.yml");

describe("load-infisical-secrets action", () => {
  it("masks each fetched secret before writing it to GITHUB_ENV", () => {
    const action = readFileSync(actionPath, "utf8");
    const maskLoop = 'while IFS= read -r mask_line || [ -n "$mask_line" ]; do';
    const maskCommand = 'echo "::add-mask::$mask_line"';
    const fetchCommand = 'if ! value="$(infisical secrets get';
    const environmentWriteBranch = "if printf '%s' \"$value\" | grep -q $'\\n'; then";
    const successMaskCall = 'mask_value "$value"';
    const firstEnvironmentWrite = action.indexOf('>> "$GITHUB_ENV"');

    expect(action).toContain(maskLoop);
    expect(action).toContain(maskCommand);
    expect(action.indexOf(successMaskCall)).toBeGreaterThan(action.indexOf(fetchCommand));
    expect(action.indexOf(successMaskCall)).toBeLessThan(action.indexOf(environmentWriteBranch));
    expect(firstEnvironmentWrite).toBeGreaterThan(action.indexOf(successMaskCall));
  });
});
