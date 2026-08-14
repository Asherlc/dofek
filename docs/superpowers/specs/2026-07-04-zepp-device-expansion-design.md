# Zepp Device Expansion Design

## Scope

Expand the Zepp OS companion app in `packages/zepp` from Amazfit T-Rex 3 only to every official Zepp OS device that can support the current app. "Can support" means the official Zepp device list reports Latest API_LEVEL `>= 3.0`, because the app already depends on API_LEVEL 3.0 APIs such as app service startup, permission querying, and file transfer.

Sources:
- Zepp Device Basic Information lists Zepp OS devices, Latest API_LEVEL, `deviceSource`, and screen resolution: https://docs.zepp.com/docs/reference/related-resources/device-list/
- Zepp mini program `app.json` targets use `platforms`, `deviceSource`, `st`, `sr`, and `designWidth`: https://docs.zepp.com/docs/watchface/app-json/
- Zepp `TransferFile` starts at API_LEVEL 3.0: https://docs.zepp.com/docs/reference/device-app-api/newAPI/transfer-file/TransferFile/
- Zepp app service `start` starts at API_LEVEL 3.0: https://docs.zepp.com/docs/reference/device-app-api/newAPI/app-service/start/
- Zepp `queryPermission` starts at API_LEVEL 3.0: https://docs.zepp.com/docs/reference/device-app-api/newAPI/app/queryPermission/

## Non-Goals

- Do not change the `amazfit-zepp` cloud sync provider.
- Do not add support for API_LEVEL 1.x or 2.x devices in this pass.
- Do not add compatibility shims for devices that lack the required runtime APIs.
- Do not duplicate the app implementation per device unless the manifest requires separate targets.

## Architecture

Keep one shared Zepp OS implementation:
- `page/index.ts` remains the watch app entry and continues sizing UI from `getDeviceInfo().width`.
- `app-side/index.ts`, `setting/index.ts`, and `app-service/imu_service.ts` remain shared across targets.
- Runtime sensor checks continue to decide whether accelerometer, gyroscope, and optional health sensors are available on a specific device.

Expand `packages/zepp/app.json` into screen-width target groups. Each group uses the same modules and contains every matching `deviceSource` from supported API_LEVEL `>= 3.0` devices. Target keys should match asset subdirectories, so each new target needs an icon asset path.

## Device Grouping

Use one target per screen/design width class:
- Round 480 x 480
- Round 466 x 466
- Round 454 x 454
- Round 416 x 416
- Round 360 x 360
- Square 432 x 514
- Square 390 x 450
- Square 320 x 380

## Verification

Do not add a dedicated test for `app.json`; repository guidance treats static JSON, XML, YAML, TOML, manifests, and other declarative metadata files as unnecessary to unit test. Verify the manifest by reviewing the target diff against the official Zepp device list and by running the focused Zepp checks.

Run:
- `pnpm --filter @dofek/zepp test`
- `pnpm --filter @dofek/zepp typecheck`
- `pnpm --filter @dofek/zepp build`

## Documentation

Update `packages/zepp/README.md` and `packages/zepp/package.json` so they no longer describe the app as T-Rex 3 only. Keep the README source citations to official Zepp docs.
