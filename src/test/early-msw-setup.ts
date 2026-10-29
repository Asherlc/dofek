import { afterAll } from "vitest";
import { startEarlyMsw } from "./early-msw-lifecycle.ts";

// Install interception before test modules can construct clients that retain fetch.
// Individual test files own their handlers and unhandled-request policy.
afterAll(startEarlyMsw());
