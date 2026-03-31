import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as Sentry from "@sentry/node";
import { Router } from "express";
import { z } from "zod";
import { logger as defaultLogger } from "../logger.ts";

interface Logger {
  info(message: string): void;
  error(message: string): void;
}

interface UpdatesStorage {
  downloadBuffer(key: string): Promise<Buffer>;
}

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

const releasePointerSchema = z.object({
  releaseId: z.string().min(1),
});

interface MetadataCache {
  releaseId?: string;
  metadata: Metadata | null;
  mtimeMs?: number;
  fetchedAtMs: number;
}

interface ReleasePointerCache {
  releaseId: string | null;
  fetchedAtMs: number;
}

export function createUpdatesRouter(deps: {
  updatesDir?: string;
  publicUrl: string;
  updatesStorage?: UpdatesStorage;
  updatesPrefix?: string;
  logger?: Logger;
}): Router {
  const router = Router();
  const logger = deps.logger ?? defaultLogger;
  const updatesPrefix = (deps.updatesPrefix ?? "mobile-ota").replace(/^\/+|\/+$/g, "");
  const releasePointerKey = `${updatesPrefix}/current-release.json`;
  let metadataCache: MetadataCache | null = null;
  let releasePointerCache: ReleasePointerCache | null = null;
  const objectStorageCacheTtlMs = 5_000;

  function buildReleaseStorageKey(releaseId: string, filePath: string): string {
    return `${updatesPrefix}/releases/${releaseId}/${filePath}`;
  }

  function isNotFoundError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const parsedError = z
      .object({
        name: z.string().optional(),
        code: z.string().optional(),
        Code: z.string().optional(),
        $metadata: z.object({ httpStatusCode: z.number().optional() }).optional(),
      })
      .safeParse(error);
    if (!parsedError.success) return false;
    const anyError = parsedError.data;
    return (
      anyError.code === "ENOENT" ||
      anyError.code === "NoSuchKey" ||
      anyError.Code === "NoSuchKey" ||
      anyError.name === "NoSuchKey" ||
      anyError.$metadata?.httpStatusCode === 404
    );
  }

  async function loadCurrentReleaseId(): Promise<string | null> {
    if (deps.updatesStorage) {
      if (
        releasePointerCache &&
        Date.now() - releasePointerCache.fetchedAtMs < objectStorageCacheTtlMs
      ) {
        return releasePointerCache.releaseId;
      }

      let pointerBuffer: Buffer;
      try {
        pointerBuffer = await deps.updatesStorage.downloadBuffer(releasePointerKey);
      } catch (error) {
        if (isNotFoundError(error)) {
          releasePointerCache = {
            releaseId: null,
            fetchedAtMs: Date.now(),
          };
          return null;
        }
        Sentry.captureException(error);
        logger.error(
          `[updates] Failed to read release pointer from object storage: ${String(error)}`,
        );
        releasePointerCache = {
          releaseId: null,
          fetchedAtMs: Date.now(),
        };
        return null;
      }

      let pointerJson: unknown;
      try {
        pointerJson = JSON.parse(pointerBuffer.toString("utf-8"));
      } catch (error) {
        Sentry.captureException(error);
        logger.error("[updates] Malformed JSON in current-release.json");
        releasePointerCache = {
          releaseId: null,
          fetchedAtMs: Date.now(),
        };
        return null;
      }

      const parsed = releasePointerSchema.safeParse(pointerJson);
      if (!parsed.success) {
        logger.error(`[updates] Invalid current-release.json: ${parsed.error.message}`);
        releasePointerCache = {
          releaseId: null,
          fetchedAtMs: Date.now(),
        };
        return null;
      }

      releasePointerCache = {
        releaseId: parsed.data.releaseId,
        fetchedAtMs: Date.now(),
      };
      return parsed.data.releaseId;
    }

    return "current";
  }

  async function loadMetadata(releaseId: string): Promise<Metadata | null> {
    if (deps.updatesStorage) {
      if (
        metadataCache &&
        metadataCache.releaseId === releaseId &&
        Date.now() - metadataCache.fetchedAtMs < objectStorageCacheTtlMs
      ) {
        return metadataCache.metadata;
      }

      let metadataBuffer: Buffer;
      try {
        metadataBuffer = await deps.updatesStorage.downloadBuffer(
          buildReleaseStorageKey(releaseId, "metadata.json"),
        );
      } catch (error) {
        if (isNotFoundError(error)) {
          metadataCache = null;
          return null;
        }
        Sentry.captureException(error);
        logger.error(
          `[updates] Failed to read metadata.json from object storage for release ${releaseId}: ${String(error)}`,
        );
        metadataCache = null;
        return null;
      }

      let metadataJson: unknown;
      try {
        metadataJson = JSON.parse(metadataBuffer.toString("utf-8"));
      } catch (error) {
        Sentry.captureException(error);
        logger.error("[updates] Malformed JSON in metadata.json");
        metadataCache = null;
        return null;
      }

      const parsed = metadataSchema.safeParse(metadataJson);
      if (!parsed.success) {
        logger.error(`[updates] Invalid metadata.json: ${parsed.error.message}`);
        metadataCache = null;
        return null;
      }

      metadataCache = {
        releaseId,
        metadata: parsed.data,
        fetchedAtMs: Date.now(),
      };
      return parsed.data;
    }

    const updatesDir = deps.updatesDir;
    if (!updatesDir) {
      metadataCache = null;
      return null;
    }
    if (releaseId !== "current") {
      return null;
    }

    const metadataPath = join(updatesDir, "current", "metadata.json");
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(metadataPath);
    } catch {
      metadataCache = null;
      return null;
    }

    if (metadataCache && metadataCache.mtimeMs === fileStat.mtimeMs) {
      return metadataCache.metadata;
    }

    let raw: string;
    try {
      raw = await readFile(metadataPath, "utf-8");
    } catch (error) {
      if (isNotFoundError(error)) {
        metadataCache = null;
        return null;
      }
      Sentry.captureException(error);
      logger.error(`[updates] Failed to read metadata.json from disk: ${String(error)}`);
      metadataCache = null;
      return null;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      logger.error("[updates] Malformed JSON in metadata.json");
      metadataCache = null;
      return null;
    }

    const parsed = metadataSchema.safeParse(json);

    if (!parsed.success) {
      logger.error(`[updates] Invalid metadata.json: ${parsed.error.message}`);
      metadataCache = null;
      return null;
    }

    metadataCache = {
      metadata: parsed.data,
      mtimeMs: fileStat.mtimeMs,
      fetchedAtMs: Date.now(),
    };
    return parsed.data;
  }

  async function loadFileFromStorage(
    relativePath: string,
    releaseId: string,
  ): Promise<Buffer | null> {
    if (deps.updatesStorage) {
      try {
        return await deps.updatesStorage.downloadBuffer(
          buildReleaseStorageKey(releaseId, relativePath),
        );
      } catch (error) {
        if (isNotFoundError(error)) return null;
        Sentry.captureException(error);
        logger.error(
          `[updates] Failed to read ${relativePath} from object storage for release ${releaseId}: ${String(error)}`,
        );
        return null;
      }
    }

    if (!deps.updatesDir) return null;
    if (releaseId !== "current") return null;
    const fullPath = join(deps.updatesDir, "current", relativePath);
    try {
      return await readFile(fullPath);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      Sentry.captureException(error);
      logger.error(`[updates] Failed to read ${relativePath} from disk: ${String(error)}`);
      return null;
    }
  }

  router.get("/manifest", async (_req, res) => {
    const protocolVersion = _req.headers["expo-protocol-version"];
    if (protocolVersion !== "1") {
      res.status(400).json({ error: "Missing or unsupported expo-protocol-version" });
      return;
    }

    const platform = _req.headers["expo-platform"];
    const runtimeVersion = _req.headers["expo-runtime-version"];

    const releaseId = await loadCurrentReleaseId();
    if (!releaseId) {
      res.set("expo-protocol-version", "1");
      res.status(204).end();
      return;
    }

    const metadata = await loadMetadata(releaseId);

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
    const encodedReleaseId = encodeURIComponent(releaseId);

    const manifest = {
      id: metadata.id,
      createdAt: metadata.createdAt,
      runtimeVersion: metadata.runtimeVersion,
      launchAsset: {
        hash: metadata.launchAsset.hash,
        key: metadata.launchAsset.key,
        contentType: metadata.launchAsset.contentType,
        url: `${baseUrl}/api/updates/releases/${encodedReleaseId}/bundles/${metadata.launchAsset.key}`,
      },
      assets: metadata.assets.map((asset) => ({
        hash: asset.hash,
        key: asset.key,
        contentType: asset.contentType,
        fileExtension: asset.fileExtension,
        url: `${baseUrl}/api/updates/releases/${encodedReleaseId}/assets/${asset.key}`,
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

  async function serveAssetByReleaseId(
    req: import("express").Request,
    res: import("express").Response,
    releaseId: string,
  ) {
    const metadata = await loadMetadata(releaseId);
    if (!metadata) {
      res.status(404).json({ error: "No update metadata found for release" });
      return;
    }

    const assetKey = req.params.key;
    const matchingAsset = metadata.assets.find((asset) => asset.key === assetKey);
    if (!matchingAsset) {
      res.status(404).json({ error: "Asset not found in metadata" });
      return;
    }

    const buffer = await loadFileFromStorage(`assets/${matchingAsset.key}`, releaseId);
    if (!buffer) {
      res.status(404).json({ error: "Asset file not found" });
      return;
    }

    res.set("content-type", matchingAsset.contentType);
    res.set("cache-control", "public, immutable, max-age=31536000");
    res.send(buffer);
  }

  async function serveBundleByReleaseId(
    req: import("express").Request,
    res: import("express").Response,
    releaseId: string,
  ) {
    const metadata = await loadMetadata(releaseId);
    if (!metadata) {
      res.status(404).json({ error: "No update metadata found for release" });
      return;
    }

    const bundleKey = req.params.key;
    if (metadata.launchAsset.key !== bundleKey) {
      res.status(404).json({ error: "Bundle not found in metadata" });
      return;
    }

    const buffer = await loadFileFromStorage(`bundles/${metadata.launchAsset.key}`, releaseId);
    if (!buffer) {
      res.status(404).json({ error: "Bundle file not found" });
      return;
    }

    res.set("content-type", metadata.launchAsset.contentType);
    res.set("cache-control", "public, immutable, max-age=31536000");
    res.send(buffer);
  }

  router.get("/releases/:releaseId/assets/:key", async (req, res) => {
    await serveAssetByReleaseId(req, res, req.params.releaseId);
  });

  router.get("/releases/:releaseId/bundles/:key", async (req, res) => {
    await serveBundleByReleaseId(req, res, req.params.releaseId);
  });

  // Legacy aliases: keep serving from current release pointer for compatibility.
  router.get("/assets/:key", async (req, res) => {
    const releaseId = await loadCurrentReleaseId();
    if (!releaseId) {
      res.status(404).json({ error: "No current OTA release configured" });
      return;
    }
    await serveAssetByReleaseId(req, res, releaseId);
  });

  router.get("/bundles/:key", async (req, res) => {
    const releaseId = await loadCurrentReleaseId();
    if (!releaseId) {
      res.status(404).json({ error: "No current OTA release configured" });
      return;
    }
    await serveBundleByReleaseId(req, res, releaseId);
  });

  return router;
}
