import type { RequestHandler } from "express";
import { describe, expect, it, vi } from "vitest";
import { createOpenAiAppsChallengeRouter } from "./openai-apps-challenge.ts";

function getChallengeHandler(token: string): RequestHandler {
  const router = createOpenAiAppsChallengeRouter(token);
  const routeLayer = router.stack.find((layer) => layer.route?.path === "/openai-apps-challenge");
  const handler = routeLayer?.route?.stack[0]?.handle;
  if (!handler) {
    throw new Error("Expected OpenAI Apps challenge route handler");
  }
  return handler;
}

describe("createOpenAiAppsChallengeRouter", () => {
  it("serves only the configured OpenAI domain-verification token as plain text", () => {
    const type = vi.fn().mockReturnThis();
    const send = vi.fn();

    Reflect.apply(getChallengeHandler("challenge-token"), undefined, [{}, { send, type }, vi.fn()]);

    expect(type).toHaveBeenCalledWith("text/plain");
    expect(send).toHaveBeenCalledWith("challenge-token");
  });
});
