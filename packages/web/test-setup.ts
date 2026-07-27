import "@testing-library/jest-dom/vitest";
import { installTestWebAccountStateLocks } from "./src/lib/web-account-state-lock.test-helpers.ts";

if (typeof navigator !== "undefined") {
  installTestWebAccountStateLocks();
}
