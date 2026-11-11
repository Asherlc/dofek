import { afterAll } from "vitest";
import { startEarlyMsw } from "./early-msw-lifecycle.ts";
import { startHttpTransportDiagnostics } from "./http-transport-diagnostics.ts";

// Install interception before test modules can construct clients that retain fetch.
// Fixtures select handlers and policy; setup is the sole listen/close owner.
afterAll(startHttpTransportDiagnostics());
afterAll(startEarlyMsw());
