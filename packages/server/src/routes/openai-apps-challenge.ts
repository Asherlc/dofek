import { Router } from "express";

/** Serve OpenAI Apps' domain-verification token at its required well-known path. */
export function createOpenAiAppsChallengeRouter(token: string): Router {
  const router = Router();

  router.get("/openai-apps-challenge", (_req, res) => {
    res.type("text/plain").send(token);
  });

  return router;
}
