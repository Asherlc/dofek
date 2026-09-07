# Mobile Resumable Share Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import Strong and other shared mobile files through the durable `fileUpload` tRPC/R2 flow without constructing JavaScript `Blob` upload bodies.

**Architecture:** Keep provider detection, durable session coordination, and import-status polling in a focused mobile module. Use `expo-file-system` `File` instances for metadata and text reading, `expo-crypto` for SHA-256, and native `File.createUploadTask()` calls for presigned R2 parts. The server remains the authority for session creation, authorization, completion, and import status.

**Tech Stack:** TypeScript, Expo FileSystem, Expo Crypto, tRPC, Cloudflare R2, Vitest.

**Spec:** `docs/file-upload-architecture.md`

## Global Constraints

- Preserve provider IDs and server-authored errors.
- Use the existing `fileUpload` tRPC router; do not retain `/api/upload/*` requests.
- Never create a JavaScript `Blob` from an `ArrayBuffer` or `ArrayBufferView` on mobile.
- Use Expo `File.createUploadTask()` for presigned URLs, per <https://docs.expo.dev/versions/latest/sdk/filesystem/>.
- Keep direct private-part uploads consistent with `docs/file-upload-architecture.md` and <https://developers.cloudflare.com/r2/objects/upload-objects/>.
- Keep tests outside `packages/mobile/app/`.

---

### Task 1: Build the native upload transport

**Files:** Create `packages/mobile/lib/resumable-file-upload.ts`; create `packages/mobile/lib/resumable-file-upload.test.ts`.

**Interfaces:** Consume `FileUploadApi` methods `initiate`, `authorizeParts`, `complete`, and `resume`; produce `runMobileResumableFileUpload(options): Promise<{ uploadId: string }>`.

- [ ] **Step 1: Write the failing test**

Supply a CSV URI, size `8`, deterministic SHA-256, and native `uploadPart` spy. Assert it receives the presigned URL, original file URI, and `Content-Type: text/csv`; assert its ETag reaches `complete`; assert no global `fetch` is called.

```ts
expect(uploadPart).toHaveBeenCalledWith(expect.objectContaining({ fileUri, url }));
expect(api.complete).toHaveBeenCalledWith({ uploadId, parts: [{ partNumber: 1, etag: "etag-1" }] });
expect(fetchMock).not.toHaveBeenCalled();
```

- [ ] **Step 2: Verify red**

Run `rtk pnpm vitest run packages/mobile/lib/resumable-file-upload.test.ts`; expect failure because the transport does not exist.

- [ ] **Step 3: Implement minimally**

Create narrow adapters: `readBytes()` computes SHA-256 with `expo-crypto.digest`; `uploadPart()` calls `new File(fileUri).createUploadTask(url, { httpMethod: "PUT", headers, mimeType, sessionType: "foreground", onProgress }).uploadAsync()`. Initiate, resume, upload every missing part, require ETags, then complete sorted parts. Do not use `fetch` or `Blob` request bodies.

- [ ] **Step 4: Verify green**

Run `rtk pnpm vitest run packages/mobile/lib/resumable-file-upload.test.ts`; expect pass.

- [ ] **Step 5: Commit**

Run `git add packages/mobile/lib/resumable-file-upload.ts packages/mobile/lib/resumable-file-upload.test.ts` followed by `git commit -m "feat(mobile): add native resumable file uploads"`.

### Task 2: Replace legacy shared import

**Files:** Modify `packages/mobile/lib/share-import.ts`; modify `packages/mobile/lib/share-import.test.ts`.

**Interfaces:** Consume the mobile transport, an Expo file adapter, and `FileUploadApi`; produce `importSharedFile(args, deps)` that polls the durable upload lifecycle.

- [ ] **Step 1: Write the failing test**

Replace the legacy endpoint expectation for Strong with `fileUpload.initiate`; make the native uploader return an ETag and `resume` return `uploading` then `completed`; assert no URL contains `/api/upload/`.

```ts
expect(api.initiate).toHaveBeenCalledWith(expect.objectContaining({ importType: "strong-csv", filename: "Strong Export.csv" }));
expect(result).toEqual({ providerId: "strong-csv", jobId: `file-import-${uploadId}` });
```

- [ ] **Step 2: Verify red**

Run `rtk pnpm vitest run packages/mobile/lib/share-import.test.ts`; expect failure because the legacy endpoint client runs.

- [ ] **Step 3: Implement minimally**

Remove legacy target construction, chunk uploads, and status URLs. Keep CSV inference, read CSV text directly from the Expo file, map transport phases to `ShareImportProgress`, poll `fileUpload.resume` each second after completion, return the server `importJobId`, and report unexpected errors with `captureException()`.

- [ ] **Step 4: Verify green**

Run `rtk pnpm vitest run packages/mobile/lib/share-import.test.ts`; expect pass.

- [ ] **Step 5: Commit**

Run `git add packages/mobile/lib/share-import.ts packages/mobile/lib/share-import.test.ts` followed by `git commit -m "fix(mobile): use durable uploads for shared imports"`.

### Task 3: Wire the providers screen

**Files:** Modify `packages/mobile/app/providers/index.tsx`; modify `packages/mobile/app-tests/providers/index.test.tsx`.

**Interfaces:** Consume `trpc.fileUpload` mutations and resume query; pass the canonical dependency shape to `importSharedFile` for both shared and picker files.

- [ ] **Step 1: Write the failing screen test**

Expect `importSharedFile` dependencies to contain `fileUploadApi` and a native file uploader, rather than `readBlob`; assert the API has `initiate`, `authorizeParts`, `complete`, and `resume`.

- [ ] **Step 2: Verify red**

Run `rtk pnpm vitest run packages/mobile/app-tests/providers/index.test.tsx`; expect failure because the screen passes the Blob reader.

- [ ] **Step 3: Implement minimally**

Create one memoized API from the existing tRPC operations, pass it and the Expo File adapter to both import paths, and retain terminal cleanup. Do not add an endpoint fallback.

- [ ] **Step 4: Verify green**

Run `rtk pnpm vitest run packages/mobile/app-tests/providers/index.test.tsx`; expect pass.

- [ ] **Step 5: Commit**

Run `git add packages/mobile/app/providers/index.tsx packages/mobile/app-tests/providers/index.test.tsx` followed by `git commit -m "fix(mobile): wire shared imports to durable uploads"`.

### Task 4: Verify and ship

**Files:** Modify `docs/production-incident-baseline.md` if the user confirms this production-facing incident.

- [ ] **Step 1: Run focused tests**

Run `rtk pnpm vitest run packages/mobile/lib/resumable-file-upload.test.ts packages/mobile/lib/share-import.test.ts packages/mobile/app-tests/providers/index.test.tsx`; expect pass.

- [ ] **Step 2: Run static checks**

Run `rtk pnpm --dir packages/mobile typecheck` and `rtk pnpm --dir packages/mobile lint`; expect pass.

- [ ] **Step 3: Document the production incident**

Append the observed Blob failure and timeout, the retired legacy endpoint cause, validation evidence, and physical-device residual risk to the incident baseline.

- [ ] **Step 4: Commit and push**

Run `git add <verified changed files>`, `git commit -m "fix(mobile): complete durable shared file imports"`, and `git push`.
