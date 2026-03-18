import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.ts";

describe("createLogger", () => {
  it("creates logger with only console transport when Axiom env vars are missing", () => {
    const logger = createLogger({});

    expect(logger.transports).toHaveLength(1);
    expect(logger.transports[0].constructor.name).toBe("Console");
  });

  it("creates logger with console and Axiom transports when env vars are set", () => {
    const logger = createLogger({
      AXIOM_TOKEN: "test-token",
      AXIOM_DATASET: "test-dataset",
    });

    expect(logger.transports).toHaveLength(2);
    const transportNames = logger.transports.map((t) => t.constructor.name);
    expect(transportNames).toContain("Console");
    expect(transportNames).toContain("WinstonTransport");
  });

  it("does not add Axiom transport when only token is set", () => {
    const logger = createLogger({ AXIOM_TOKEN: "test-token" });

    expect(logger.transports).toHaveLength(1);
  });

  it("does not add Axiom transport when only dataset is set", () => {
    const logger = createLogger({ AXIOM_DATASET: "test-dataset" });

    expect(logger.transports).toHaveLength(1);
  });
});
