import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import { z } from "zod";
import { logger } from "../logger.ts";

const metadataAssetSchema = z.object({
  hash: z.string(),
  key: z.string(),
  contentType: z.string(),
  fileExtension: z.string(),
});

const metadataSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  runtimeVersion: z.string(),
  platform: z.string(),
  launchAsset: z.object({
    hash: z.string(),
    key: z.string(),
    contentType: z.string(),
  }),
  assets: z.array(metadataAssetSchema),
});

type Metadata = z.infer<typeof metadataSchema>;

interface MetadataCache {
  metadata: Metadata | null;
  mtimeMs: number;
}

export function createUpdatesRouter(deps: { updatesDir: string; publicUrl: string }): Router {
  const router = Router();
  let cache: MetadataCache | null = null;

  async function loadMetadata(): Promise<Metadata | null> {
    const metadataPath = join(deps.updatesDir, "current", "metadata.json");

    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(metadataPath);
    } catch {
      cache = null;
      return null;
    }

    if (cache && cache.mtimeMs === fileStat.mtimeMs) {
      return cache.metadata;
    }

    const raw = await readFile(metadataPath, "utf-8");
    const parsed = metadataSchema.safeParse(JSON.parse(raw));

    if (!parsed.success) {
      logger.error(`[updates] Invalid metadata.json: ${parsed.error.message}`);
      cache = null;
      return null;
    }

    cache = { metadata: parsed.data, mtimeMs: fileStat.mtimeMs };
    return parsed.data;
  }

  router.get("/manifest", async (_req, res) => {
    const protocolVersion = _req.headers["expo-protocol-version"];
    if (protocolVersion !== "1") {
      res.status(400).json({ error: "Missing or unsupported expo-protocol-version" });
      return;
    }

    const platform = _req.headers["expo-platform"];
    const runtimeVersion = _req.headers["expo-runtime-version"];

    const metadata = await loadMetadata();

    if (!metadata) {
      res.set("expo-protocol-version", "1");
      res.status(204).end();
      return;
    }

    if (typeof runtimeVersion !== "string" || metadata.runtimeVersion !== runtimeVersion) {
      logger.info(
        `[updates] Runtime version mismatch: client=${String(runtimeVersion)} server=${metadata.runtimeVersion}`,
      );
      res.set("expo-protocol-version", "1");
      res.status(204).end();
      return;
    }

    if (typeof platform !== "string" || metadata.platform !== platform) {
      logger.info(
        `[updates] Platform mismatch: client=${String(platform)} server=${metadata.platform}`,
      );
      res.set("expo-protocol-version", "1");
      res.status(204).end();
      return;
    }

    const baseUrl = deps.publicUrl.replace(/\/$/, "");

    const manifest = {
      id: metadata.id,
      createdAt: metadata.createdAt,
      runtimeVersion: metadata.runtimeVersion,
      launchAsset: {
        hash: metadata.launchAsset.hash,
        key: metadata.launchAsset.key,
        contentType: metadata.launchAsset.contentType,
        url: `${baseUrl}/updates/bundles/${metadata.launchAsset.key}`,
      },
      assets: metadata.assets.map((asset) => ({
        hash: asset.hash,
        key: asset.key,
        contentType: asset.contentType,
        fileExtension: asset.fileExtension,
        url: `${baseUrl}/updates/assets/${asset.key}`,
      })),
      metadata: {},
      extra: {},
    };

    const boundary = "expo-manifest-boundary";
    const manifestJson = JSON.stringify(manifest);
    const body = [
      `--${boundary}\r\n`,
      'content-disposition: form-data; name="manifest"\r\n',
      "content-type: application/json\r\n",
      "\r\n",
      `${manifestJson}\r\n`,
      `--${boundary}--\r\n`,
    ].join("");

    res.set("expo-protocol-version", "1");
    res.set("content-type", `multipart/mixed; boundary=${boundary}`);
    res.send(body);
  });

  return router;
}
