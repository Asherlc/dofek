import type { Request, Response } from "express";
import { getMobileAuthExchangeStoreRef } from "./shared.ts";

export async function handleMobileAuthExchange(req: Request, res: Response): Promise<void> {
  const code = typeof req.body.code === "string" ? req.body.code : undefined;
  if (!code) {
    res.status(400).json({ error: "Missing exchange code" });
    return;
  }
  const payload = await getMobileAuthExchangeStoreRef().consume(code);
  if (!payload || payload.kind !== "session") {
    res.status(400).json({ error: "Exchange code is invalid or expired" });
    return;
  }
  res.json({ session: payload.sessionId, isNewUser: payload.isNewUser });
}
