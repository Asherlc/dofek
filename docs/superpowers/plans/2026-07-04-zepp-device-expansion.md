# Zepp Device Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the Zepp OS companion app manifest and docs so the app targets every official Zepp OS API_LEVEL 3.0+ device supported by its runtime APIs.

**Architecture:** Keep one shared Zepp OS implementation and expand only the installer manifest targets by screen size. Device capability differences remain runtime-checked through the existing sensor availability code. Do not add dedicated tests for static JSON, XML, YAML, TOML, manifests, or other declarative metadata files; verify the manifest by diff review, existing tests, typecheck, and Zeus build.

**Tech Stack:** Zepp OS `app.json`, TypeScript, Vitest, Zeus CLI via `pnpm --filter @dofek/zepp build`.

---

## File Structure

- Modify `packages/zepp/app.json`: add target groups by screen width and include every supported `deviceSource`.
- Modify `packages/zepp/README.md`: replace T-Rex 3-only documentation with API_LEVEL 3.0+ device support and official source links.
- Modify `packages/zepp/package.json`: update description from T-Rex 3-specific wording to general Zepp OS support.
- Add target asset directories under `packages/zepp/assets/`: each target key in `app.json` needs a matching asset directory with `icon.png`.
- Modify `docs/superpowers/specs/2026-07-04-zepp-device-expansion-design.md`: record the no-JSON-test verification decision and the 416 px Falcon target correction.

## Target Catalog

Use the official Zepp device list as of 2026-07-04. Supported `deviceSource` values are the Zepp OS devices with Latest API_LEVEL `>= 3.0`.

- `round-480`: 11141376, 11141377, 11141379, 11075840, 11075841, 9961728, 9961729, 10879232, 10879233, 10879235, 10813697, 10813699, 10551552, 10551553, 10551555, 9568512, 9568513, 9568515, 8716544, 8716545, 8716547, 8519936, 8519937, 8519939, 8126720, 8126721
- `round-466`: 11010304, 11010305, 11010307, 10944768, 10944769, 10944771, 10948867, 10682624, 10682625, 10682627, 8913152, 8913153, 8913155, 8913159, 10092800, 10092801, 10092803, 10092807, 7930112, 7930113, 7864577
- `round-454`: 8192256, 8192257, 6553856, 6553857
- `round-416`: 414, 415
- `round-360`: 8388864, 8388865
- `square-432x514`: 11206915
- `square-390x450`: 10223872, 10223873, 10223875, 9765120, 9765121, 10158337, 8323328, 8323329, 8257793, 7995648, 7995649
- `square-320x380`: 8782081, 8782088, 8782089

Excluded: API_LEVEL 1.x/2.x devices and non-Zepp OS devices listed in the same official document.

## Task 1: Expand Manifest Targets

**Files:**
- Modify: `packages/zepp/app.json`
- Add directories/files: `packages/zepp/assets/round-480/icon.png`, `packages/zepp/assets/round-466/icon.png`, `packages/zepp/assets/round-454/icon.png`, `packages/zepp/assets/round-416/icon.png`, `packages/zepp/assets/round-360/icon.png`, `packages/zepp/assets/square-432x514/icon.png`, `packages/zepp/assets/square-390x450/icon.png`, `packages/zepp/assets/square-320x380/icon.png`

- [ ] **Step 1: Replace `targets` in `app.json`**

Use the target catalog above. Each target uses this shared `module` object:

```json
{
  "page": {
    "pages": ["page/index"]
  },
  "app-side": {
    "path": "app-side/index"
  },
  "setting": {
    "path": "setting/index"
  },
  "app-service": {
    "services": ["app-service/imu_service"]
  }
}
```

For each platform, set `name`, `deviceSource`, `st`, and `sr`. Use `st: "r"` for round targets, `st: "s"` for square targets, and `sr` values `w480`, `w466`, `w454`, `w416`, `w360`, `w432`, `w390`, or `w320`.

- [ ] **Step 2: Add matching asset directories**

Run:

```bash
rtk mkdir -p packages/zepp/assets/round-480 packages/zepp/assets/round-466 packages/zepp/assets/round-454 packages/zepp/assets/round-416 packages/zepp/assets/round-360 packages/zepp/assets/square-432x514 packages/zepp/assets/square-390x450 packages/zepp/assets/square-320x380
rtk cp packages/zepp/assets/icon.png packages/zepp/assets/round-480/icon.png
rtk cp packages/zepp/assets/icon.png packages/zepp/assets/round-466/icon.png
rtk cp packages/zepp/assets/icon.png packages/zepp/assets/round-454/icon.png
rtk cp packages/zepp/assets/icon.png packages/zepp/assets/round-416/icon.png
rtk cp packages/zepp/assets/icon.png packages/zepp/assets/round-360/icon.png
rtk cp packages/zepp/assets/icon.png packages/zepp/assets/square-432x514/icon.png
rtk cp packages/zepp/assets/icon.png packages/zepp/assets/square-390x450/icon.png
rtk cp packages/zepp/assets/icon.png packages/zepp/assets/square-320x380/icon.png
```

- [ ] **Step 3: Review manifest diff**

Run: `rtk git diff -- packages/zepp/app.json`

Expected: `targets` contains exactly the eight screen groups in the target catalog, and the old T-Rex 3-only group is gone.

## Task 2: Documentation and Metadata

**Files:**
- Modify: `packages/zepp/README.md`
- Modify: `packages/zepp/package.json`

- [ ] **Step 1: Update package description**

Change `packages/zepp/package.json` description to:

```json
"description": "Raw IMU logger for Zepp OS API_LEVEL 3.0+ devices"
```

- [ ] **Step 2: Update README support section**

Replace the T-Rex 3-only target section with a section stating:

```md
## Target devices

The app targets Zepp OS devices whose official Latest API_LEVEL is 3.0 or newer. This boundary comes from the APIs the app uses: file transfer, app service startup, and permission querying all start at API_LEVEL 3.0.

| Requirement | Value | Source |
|---|---|---|
| Device family | Zepp OS devices with Latest API_LEVEL >= 3.0 | [Zepp OS device list](https://docs.zepp.com/docs/reference/related-resources/device-list/) |
| Required API_LEVEL | 3.0+ | [TransferFile](https://docs.zepp.com/docs/reference/device-app-api/newAPI/transfer-file/TransferFile/), [app-service start](https://docs.zepp.com/docs/reference/device-app-api/newAPI/app-service/start/), [queryPermission](https://docs.zepp.com/docs/reference/device-app-api/newAPI/app/queryPermission/) |
| Screen targets | Round 480/466/454/416/360, square 432/390/320 widths | [Zepp OS device list](https://docs.zepp.com/docs/reference/related-resources/device-list/) and [app.json target docs](https://docs.zepp.com/docs/watchface/app-json/) |

Configured in `app.json` as screen-width target groups.
```

Also replace build/install wording that specifically says T-Rex 3 with generic Zepp OS API_LEVEL 3.0+ wording.

## Task 3: Verification

**Files:**
- Review: all changed files

- [ ] **Step 1: Run focused Zepp checks**

Run:

```bash
rtk pnpm --filter @dofek/zepp test
rtk pnpm --filter @dofek/zepp typecheck
rtk pnpm --filter @dofek/zepp build
```

Expected: all pass.

- [ ] **Step 2: Inspect changed files**

Run:

```bash
rtk git diff --stat
rtk git diff -- packages/zepp/app.json packages/zepp/README.md packages/zepp/package.json docs/superpowers/specs/2026-07-04-zepp-device-expansion-design.md docs/superpowers/plans/2026-07-04-zepp-device-expansion.md
```

Expected: changes are limited to Zepp manifest/docs/spec/plan and asset copies.

- [ ] **Step 3: Run required pre-push checks**

Run the repo-required checks before committing and pushing:

```bash
rtk pnpm lint
rtk pnpm --filter @dofek/zepp test
rtk pnpm --filter @dofek/zepp typecheck
rtk pnpm --filter @dofek/zepp build
rtk pnpm tsc --noEmit
rtk bash -lc 'cd packages/server && pnpm tsc --noEmit'
rtk bash -lc 'cd packages/web && pnpm tsc --noEmit'
```

Expected: all pass.

- [ ] **Step 4: Commit and push**

Run:

```bash
rtk git status --short
rtk git add docs/superpowers/specs/2026-07-04-zepp-device-expansion-design.md docs/superpowers/plans/2026-07-04-zepp-device-expansion.md packages/zepp/app.json packages/zepp/README.md packages/zepp/package.json packages/zepp/assets
rtk git commit -m "feat: expand Zepp OS device targets"
rtk git push
```

Expected: commit succeeds and branch pushes to its configured remote.
