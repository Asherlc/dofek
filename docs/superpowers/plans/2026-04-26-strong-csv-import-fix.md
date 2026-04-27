# Strong CSV Import Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the crash when importing Strong CSV files on mobile by adding a `fetch` fallback when `Blob.text()` and `Blob.arrayBuffer()` are unsupported.

**Architecture:** We will modify `readBlobText` in `packages/mobile/lib/share-import.ts` to `try...catch` calls to `.text()` and `.arrayBuffer()` and fallback to `fetch(fileUri).then(res => res.text())`. A failing test will be added first in `packages/mobile/lib/share-import.test.ts` to simulate the environment where these blob methods are broken.

**Tech Stack:** TypeScript, React Native, Vitest

---

### Task 1: Add Failing Test for Blob Method Failure

**Files:**
- Modify: `packages/mobile/lib/share-import.test.ts`

- [ ] **Step 1: Write the failing test**

Open `packages/mobile/lib/share-import.test.ts` and add this test inside the `describe("importSharedFile")` block.

```typescript
  it("falls back to fetch when blob.text and blob.arrayBuffer throw errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const fileBody = "Date,Workout Name,Duration,Exercise Name\n2026-03-10,Leg Day,00:45:00,Squat";
    
    const customReadBlob = vi.fn().mockImplementation(async () => {
      const blob = new Blob([fileBody], { type: "text/csv" });
      Object.defineProperty(blob, "text", { 
        value: () => { throw new Error("creating blobs from arraybuffer or arraybufferview are not supported"); }
      });
      Object.defineProperty(blob, "arrayBuffer", { 
        value: () => { throw new Error("creating blobs from arraybuffer or arraybufferview are not supported"); }
      });
      return blob;
    });

    // The fetchImpl needs to handle both the initial file read AND the upload/status polls
    fetchImpl
      // 1. Initial file read fallback
      .mockResolvedValueOnce(new Response(fileBody, { status: 200 }))
      // 2. Upload request
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "processing", jobId: "job-fallback" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      // 3. Status poll
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "done", progress: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const result = await importSharedFile(
      {
        fileUri: "file:///tmp/fallback.csv",
        serverUrl: "https://example.com",
        sessionToken: "session-token",
      },
      {
        fetchImpl,
        readBlob: customReadBlob,
        sleep: async () => {},
      },
    );

    expect(result.providerId).toBe<ImportProviderId>("strong-csv");
    expect(result.jobId).toBe("job-fallback");
    // fetchImpl called 3 times: fallback read, upload, poll
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "file:///tmp/fallback.csv");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mobile && pnpm vitest run lib/share-import.test.ts`
Expected: FAIL with "creating blobs from arraybuffer or arraybufferview are not supported" or "Unsupported shared file type" (because it can't parse the CSV header when reading fails).

- [ ] **Step 3: Commit the failing test**

```bash
git add packages/mobile/lib/share-import.test.ts
git commit -m "test(mobile): add failing test for blob read fallback during share import"
```

---

### Task 2: Implement `fetch` Fallback in `readBlobText`

**Files:**
- Modify: `packages/mobile/lib/share-import.ts`

- [ ] **Step 1: Update `readBlobText` signature**

We need to pass `fileUri` and `fetchImpl` down to `readBlobText` so it can perform the fallback fetch.

Update the signature of `readBlobText` around line 187:

```typescript
async function readBlobText(blob: Blob, fileUri: string, fetchImpl: typeof fetch): Promise<string> {
```

- [ ] **Step 2: Implement the `try...catch` and fallback logic**

Update the implementation of `readBlobText` (around lines 187-194) to carefully try the native methods, catching errors and falling back to `fetch`:

```typescript
async function readBlobText(blob: Blob, fileUri: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    if (hasBlobTextReader(blob)) {
      return await blob.text();
    }
  } catch (error) {
    // Ignore error and fall through
  }

  try {
    const arrayBuffer = await blob.arrayBuffer();
    return new TextDecoder().decode(arrayBuffer);
  } catch (error) {
    // Ignore error and fall through
  }

  // Fallback to fetching the file URI directly
  const response = await fetchImpl(fileUri);
  if (!response.ok) {
    throw new Error(`Failed to read shared file via fetch fallback (${response.status})`);
  }
  return response.text();
}
```

- [ ] **Step 3: Update `readBlobText` call site**

Update the call to `readBlobText` inside `importSharedFile` (around line 378).

```typescript
    const csvHeaderLine =
      fileExtension === ".csv" ? getCsvHeaderLine(await readBlobText(blob, args.fileUri, fetchImpl)) : "";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mobile && pnpm vitest run lib/share-import.test.ts`
Expected: PASS

- [ ] **Step 5: Run linter and typecheck**

Run: `pnpm lint` and `cd packages/mobile && pnpm tsc --noEmit`
Expected: Success

- [ ] **Step 6: Commit the fix**

```bash
git add packages/mobile/lib/share-import.ts
git commit -m "fix(mobile): restore fetch fallback for blob reading during share import
    
Fixes a crash on iOS where creating blobs from array buffers is not supported
by gracefully falling back to \`fetch(fileUri).text()\` when blob methods throw."
```