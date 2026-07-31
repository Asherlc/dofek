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
    [
      "hides a throw in an unreachable branch",
      `
        try {
          await sync();
        } catch (error) {
          if (false) {
            throw error;
          }
          console.error(error);
        }
      `,
    ],
    [
      "hides captureException in an unreachable nested function",
      `
        try {
          await sync();
        } catch (error) {
          function reportLater() {
            captureException(error);
          }
          console.error(error);
        }
      `,
    ],
  ])("rejects a handler that %s", (_description, sourceText) => {
    expect(findHandledMobileErrorViolations("fixture.ts", sourceText)).toHaveLength(1);
  });

  it.each([
    [
      "reports through a canonical workout-route helper",
      `
        try {
          await pushRoutes();
        } catch (error) {
          handleWorkoutRouteError(error, {
            errors,
            errorLabel: "Push workout routes",
            source: "health-kit-workout-route-push",
          });
        }
      `,
    ],
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
      "rethrows errors outside an explicit expected-error classifier",
      `
        try {
          return await readHealthData();
        } catch (error) {
          if (!isAuthorizationNotDetermined(error)) {
            throw error;
          }
          return [];
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

  it("does not accept a same-named optional haptic result alias as an exemption", () => {
    const sourceText = `
      type OptionalHapticResult = { status: "ignored"; cause: unknown };

      async function performOptionalHaptic(): Promise<OptionalHapticResult> {
        try {
          await vibrate();
          return { status: "ignored", cause: null };
        } catch (cause) {
          return { status: "unavailable", cause };
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
