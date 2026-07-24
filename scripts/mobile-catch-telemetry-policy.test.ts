import { describe, expect, it } from "vitest";
import {
  findHandledMobileErrorViolations,
  scanMobileProductionFiles,
} from "./mobile-catch-telemetry-policy.ts";

describe("findHandledMobileErrorViolations", () => {
  it.each([
    [
      "logs and consumes a catch clause",
      `
        try {
          await connect();
        } catch (error) {
          console.error(error);
        }
      `,
    ],
    [
      "aggregates and consumes a catch clause",
      `
        try {
          await sync();
        } catch (error) {
          errors.push(String(error));
        }
      `,
    ],
    [
      "returns fallback data from a catch clause",
      `
        try {
          return await response.json();
        } catch {
          return null;
        }
      `,
    ],
    [
      "updates UI state from a Promise catch",
      `
        loadProviders().catch((error) => {
          setError(String(error));
        });
      `,
    ],
  ])("rejects a handler that %s", (_description, sourceText) => {
    expect(findHandledMobileErrorViolations("fixture.ts", sourceText)).toHaveLength(1);
  });

  it.each([
    [
      "reports the original error through the canonical helper",
      `
        try {
          await connect();
        } catch (error) {
          captureException(error, { source: "connect" });
          setError(String(error));
        }
      `,
    ],
    [
      "rethrows the original error",
      `
        try {
          await connect();
        } catch (error) {
          throw error;
        }
      `,
    ],
    [
      "models user cancellation and rethrows unexpected errors",
      `
        try {
          return await signIn();
        } catch (error) {
          if (isUserCancellation(error)) {
            return { status: "cancelled" };
          }
          throw error;
        }
      `,
    ],
    [
      "returns the explicit optional-haptic unavailable result",
      `
        type OptionalHapticResult =
          | { status: "performed" }
          | { status: "unavailable"; cause: unknown };

        async function performOptionalHaptic(
          operation: () => Promise<void>,
        ): Promise<OptionalHapticResult> {
          try {
            await operation();
            return { status: "performed" };
          } catch (cause: unknown) {
            return { status: "unavailable", cause };
          }
        }
      `,
    ],
  ])("accepts a handler that %s", (_description, sourceText) => {
    expect(findHandledMobileErrorViolations("fixture.ts", sourceText)).toEqual([]);
  });

  it("does not accept an exemption based only on haptic-looking names or comments", () => {
    const sourceText = `
      async function runHaptic() {
        try {
          await vibrate();
        } catch (error) {
          // Optional haptic is unavailable.
          return { status: "ignored", cause: error };
        }
      }
    `;

    expect(findHandledMobileErrorViolations("fixture.ts", sourceText)).toHaveLength(1);
  });
});

describe("scanMobileProductionFiles", () => {
  it("reports no caught-and-consumed unexpected errors in production mobile sources", () => {
    expect(scanMobileProductionFiles("packages/mobile")).toEqual([]);
  });
});
