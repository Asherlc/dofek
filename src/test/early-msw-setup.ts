import { afterAll } from "vitest";
import { startEarlyMsw } from "./early-msw-lifecycle.ts";

// Install interception before test modules can construct clients that retain fetch.
// Fixtures select handlers and policy; setup is the sole listen/close owner.
afterAll(startEarlyMsw());
