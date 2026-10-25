# WHOOP connection incident evidence — October 24, 2026

This record preserves sanitized primary query output and local validation output for the [incident baseline](../production-incident-baseline.md#2026-10-24--recurrent-whoop-bluetooth-disconnect-alerts). It contains connection metadata, not sensor values or credentials.

## Reported symptoms

The user reported an overnight Dofek “WHOOP disconnected” notification around 01:00 Pacific and another around 07:24, without intentionally disconnecting. They reported the phone was beside them overnight and believed the devices were nearby during the recurrence. These are first-person reports recorded during the investigation; notification delivery and physical proximity were not independently instrumented.

## Saved Axiom timeline

Queried October 24 with the authenticated Axiom CLI, using the [documented query procedure](../axiom-observability-runbook.md). All timestamps below are UTC. This projection intentionally omits account/device identifiers, sensor values, and unrelated logs. Historical mobile fields and current map fields are shown separately.

```apl
['dofek-logs'] | where _time >= datetime(2026-10-24T08:00:00Z) and _time < datetime(2026-10-24T14:26:00Z) | where ['service.name'] == 'dofek-mobile' | where body contains 'BLE disconnected' or body contains 'BLE reconnected' or body contains '[app-startup]' or body contains '[whoop-ble] capture_snapshot' or body contains '[whoop-ble] previous_buffer_checkpoint' | project _time, body, appState=['attributes.custom']['appState'], connectionState=['attributes.custom']['connectionState'], lastDataNotificationAt=['attributes.custom']['lastDataNotificationAt'], checkpointAt=['attributes.custom']['checkpointAt'], previousCheckpointAt=['attributes.custom']['previousCheckpointAt'], bufferInstanceId=['attributes.custom']['bufferInstanceId'], runtimeId=['attributes.custom']['runtimeId'], legacyAppState=['attributes.appState'], legacyConnectionState=['attributes.connectionState'], legacyLastDataNotificationAt=['attributes.lastDataNotificationAt'], legacyCheckpointAt=['attributes.checkpointAt'] | sort by _time asc
```

```jsonl
{"_time":"2026-10-24T08:24:08.783Z","appState":null,"body":"[whoop-ble] capture_snapshot","bufferInstanceId":null,"checkpointAt":null,"connectionState":null,"lastDataNotificationAt":null,"legacyAppState":"background","legacyCheckpointAt":"2026-10-24T08:24:08.626Z","legacyConnectionState":"connecting","legacyLastDataNotificationAt":"2026-10-24T08:24:07.575Z","previousCheckpointAt":null,"runtimeId":null}
{"_time":"2026-10-24T08:24:08.815Z","appState":null,"body":"[whoop-ble] BLE disconnected (Unknown error.), will reconnect","bufferInstanceId":null,"checkpointAt":null,"connectionState":null,"lastDataNotificationAt":null,"legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":null,"runtimeId":null}
{"_time":"2026-10-24T14:10:41.056Z","appState":null,"body":"[app-startup] Startup phase completed: phase=ota durationMs=15.920875 outcome=ready","bufferInstanceId":null,"checkpointAt":null,"connectionState":null,"lastDataNotificationAt":null,"legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":null,"runtimeId":"987d65a2-bfae-461a-9543-f5765bd1ac67"}
{"_time":"2026-10-24T14:10:41.069Z","appState":null,"body":"[app-startup] Startup phase completed: phase=javascript durationMs=15 outcome=ready","bufferInstanceId":null,"checkpointAt":null,"connectionState":null,"lastDataNotificationAt":null,"legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":null,"runtimeId":"987d65a2-bfae-461a-9543-f5765bd1ac67"}
{"_time":"2026-10-24T14:10:41.229Z","appState":null,"body":"[app-startup] Startup phase completed: phase=authentication durationMs=159 outcome=authenticated","bufferInstanceId":null,"checkpointAt":null,"connectionState":null,"lastDataNotificationAt":null,"legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":null,"runtimeId":"987d65a2-bfae-461a-9543-f5765bd1ac67"}
{"_time":"2026-10-24T14:10:41.266Z","appState":null,"body":"[app-startup] Startup phase completed: phase=splash-hide durationMs=1 outcome=ready","bufferInstanceId":null,"checkpointAt":null,"connectionState":null,"lastDataNotificationAt":null,"legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":null,"runtimeId":"987d65a2-bfae-461a-9543-f5765bd1ac67"}
{"_time":"2026-10-24T14:10:41.294Z","appState":null,"body":"[whoop-ble] previous_buffer_checkpoint","bufferInstanceId":"1554449D-15D9-40D3-AE87-009E039366A6","checkpointAt":null,"connectionState":null,"lastDataNotificationAt":null,"legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":"2026-10-24T08:24:08.626Z","runtimeId":"987d65a2-bfae-461a-9543-f5765bd1ac67"}
{"_time":"2026-10-24T14:10:41.295Z","appState":"inactive","body":"[whoop-ble] capture_snapshot","bufferInstanceId":"1554449D-15D9-40D3-AE87-009E039366A6","checkpointAt":"2026-10-24T14:10:41.282Z","connectionState":"idle","lastDataNotificationAt":null,"legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":null,"runtimeId":"987d65a2-bfae-461a-9543-f5765bd1ac67"}
{"_time":"2026-10-24T14:10:41.329Z","appState":null,"body":"[app-startup] Startup phase completed: phase=service-bootstrap durationMs=34 outcome=ready","bufferInstanceId":null,"checkpointAt":null,"connectionState":null,"lastDataNotificationAt":null,"legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":null,"runtimeId":"987d65a2-bfae-461a-9543-f5765bd1ac67"}
{"_time":"2026-10-24T14:10:41.329Z","appState":null,"body":"[app-startup] Startup lifecycle completed: interactiveDurationMs=227.9208984375 lifecycleDurationMs=290.9208984375 outcome=ready","bufferInstanceId":null,"checkpointAt":null,"connectionState":null,"lastDataNotificationAt":null,"legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":null,"runtimeId":"987d65a2-bfae-461a-9543-f5765bd1ac67"}
{"_time":"2026-10-24T14:10:41.689Z","appState":"active","body":"[whoop-ble] capture_snapshot","bufferInstanceId":"1554449D-15D9-40D3-AE87-009E039366A6","checkpointAt":"2026-10-24T14:10:41.689Z","connectionState":"idle","lastDataNotificationAt":null,"legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":null,"runtimeId":"987d65a2-bfae-461a-9543-f5765bd1ac67"}
{"_time":"2026-10-24T14:10:42.117Z","appState":"active","body":"[whoop-ble] capture_snapshot","bufferInstanceId":"1554449D-15D9-40D3-AE87-009E039366A6","checkpointAt":"2026-10-24T14:10:42.116Z","connectionState":"streaming","lastDataNotificationAt":null,"legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":null,"runtimeId":"987d65a2-bfae-461a-9543-f5765bd1ac67"}
{"_time":"2026-10-24T14:10:42.117Z","appState":null,"body":"[whoop-ble] BLE reconnected","bufferInstanceId":null,"checkpointAt":null,"connectionState":null,"lastDataNotificationAt":null,"legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":null,"runtimeId":"987d65a2-bfae-461a-9543-f5765bd1ac67"}
{"_time":"2026-10-24T14:10:55.21Z","appState":"inactive","body":"[whoop-ble] capture_snapshot","bufferInstanceId":"1554449D-15D9-40D3-AE87-009E039366A6","checkpointAt":"2026-10-24T14:10:55.206Z","connectionState":"streaming","lastDataNotificationAt":"2026-10-24T14:10:54.535Z","legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":null,"runtimeId":"987d65a2-bfae-461a-9543-f5765bd1ac67"}
{"_time":"2026-10-24T14:10:56.897Z","appState":"background","body":"[whoop-ble] capture_snapshot","bufferInstanceId":"1554449D-15D9-40D3-AE87-009E039366A6","checkpointAt":"2026-10-24T14:10:56.894Z","connectionState":"streaming","lastDataNotificationAt":"2026-10-24T14:10:56.576Z","legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":null,"runtimeId":"987d65a2-bfae-461a-9543-f5765bd1ac67"}
{"_time":"2026-10-24T14:19:47.7Z","appState":"background","body":"[whoop-ble] capture_snapshot","bufferInstanceId":"1554449D-15D9-40D3-AE87-009E039366A6","checkpointAt":"2026-10-24T14:19:47.671Z","connectionState":"connecting","lastDataNotificationAt":"2026-10-24T14:19:41.626Z","legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":null,"runtimeId":"987d65a2-bfae-461a-9543-f5765bd1ac67"}
{"_time":"2026-10-24T14:19:47.704Z","appState":null,"body":"[whoop-ble] BLE disconnected (The connection has timed out unexpectedly.), will reconnect","bufferInstanceId":null,"checkpointAt":null,"connectionState":null,"lastDataNotificationAt":null,"legacyAppState":null,"legacyCheckpointAt":null,"legacyConnectionState":null,"legacyLastDataNotificationAt":null,"previousCheckpointAt":null,"runtimeId":"987d65a2-bfae-461a-9543-f5765bd1ac67"}
```

This timeline proves the recorded disconnects and subsequent morning reconnect. Its filtered output is not proof that all other mobile logging stopped. It does not establish why automatic reconnection failed or whether an application handshake timeout fired.

## Saved cloud-request aggregate

```apl
['dofek-logs'] | where _time > datetime(2026-10-24T08:00:00Z) and _time < datetime(2026-10-24T14:01:00Z) | where body startswith '[whoop] API request' | summarize requests=count() by status=tostring(['attributes.custom']['status'])
```

```jsonl
{"requests":117,"status":"200"}
```

This is an aggregate of logged WHOOP requests in the specified window, not proof of complete sensor coverage for an individual account.


## Saved complete mobile-log gap counts

These unfiltered-by-message queries check the two no-log intervals. Absence of exported logs does not establish absence of capture or a termination cause.

```apl
['dofek-logs'] | where _time > datetime(2026-10-24T08:24:08.815Z) and _time < datetime(2026-10-24T14:10:41.056Z) | where ['service.name'] == 'dofek-mobile' | summarize events=count()
```

```jsonl
[]
```

```apl
['dofek-logs'] | where _time > datetime(2026-10-24T14:19:47.704Z) and _time < datetime(2026-10-24T14:26:00Z) | where ['service.name'] == 'dofek-mobile' | summarize events=count()
```

```jsonl
[]
```

## Initial local validation output

Initial implementation: [f4a707e](https://github.com/Asherlc/dofek/commit/f4a707e21384bd50e47999075403f4177a19df29). The excerpts below are the actual command summaries retained from that validation. [Hosted CI](https://github.com/Asherlc/dofek/actions/runs/40104981492) validates the subsequent test-organization correction separately.

Command: `pnpm test --retry=0`.

```text
Test Files  1324 passed | 2 skipped (1326)
      Tests  20469 passed | 19 skipped (20488)
   Start at  07:38:16
   Duration  302.84s (transform 132.03s, setup 313.55s, import 804.75s, tests 708.49s, environment 578.88s)
```

Command: `swift test --package-path packages/mobile/modules/whoop-ble`.

```text
Test Suite 'All tests' passed at 2026-10-24 07:38:05.735.
	 Executed 152 tests, with 0 failures (0 unexpected) in 9.245 (9.289) seconds
◇ Test run started.
↳ Testing Library Version: 2084
↳ Target Platform: arm64e-apple-macos14.0
✔ Test run with 0 tests in 0 suites passed after 0.001 seconds.
```

The repository lint command, root/server/web/mobile/module typechecks, and signed Debug iOS Simulator build returned exit code 0 during the same local validation. The simulator build used the checked-in Expo configuration with local ad-hoc signing and compiled the Expo bridge; it did not exercise a physical strap or prove background recovery. Native module changes require a [new native build](https://docs.expo.dev/workflow/customizing/).


## Identifier privacy regression validation

The added regression first failed because invalid caller text reached memory and persisted preferences; canonical UUID validation at the native journal boundary made it pass. The final native suite returned:

```text
Test Suite 'All tests' passed at 2026-10-24 08:07:43.052.
	 Executed 153 tests, with 0 failures (0 unexpected) in 4.841 (4.868) seconds
◇ Test run started.
↳ Testing Library Version: 2084
↳ Target Platform: arm64e-apple-macos14.0
✔ Test run with 0 tests in 0 suites passed after 0.001 seconds.
```

Strict SwiftLint passed over all 139 tracked Swift files, and the signed Debug iOS Simulator rebuild returned exit code 0 after this correction. No TypeScript implementation changed.

## Evening recurrence with native diagnostics

The user reported another “WHOOP disconnected” alert on October 24 Pacific.
The updated native journal was present in the installed app. The following
read-only [Axiom query](../axiom-observability-runbook.md#queries) retains only
connection metadata, omitting account, device, process and event identifiers:

```apl
['dofek-logs']
| where _time >= datetime(2026-10-25T01:31:35Z) and _time < datetime(2026-10-25T01:40:00Z)
| where ['service.name'] == 'dofek-mobile'
| where body == '[whoop-ble] native_connection_event' or body contains 'BLE disconnected'
| project _time, body,
    nativeEvent=['attributes.custom']['nativeEvent'],
    nativeOccurredAt=['attributes.custom']['nativeOccurredAt'],
    connectionState=['attributes.custom']['connectionState'],
    previousConnectionState=['attributes.custom']['previousConnectionState'],
    centralState=['attributes.custom']['centralState'],
    reconnectIntent=['attributes.custom']['reconnectIntent'],
    reason=['attributes.custom']['reason'],
    errorDomain=['attributes.custom']['errorDomain'],
    errorCode=['attributes.custom']['errorCode'],
    errorDescription=['attributes.custom']['errorDescription'],
    appState=['attributes.custom']['appState']
| sort by _time asc
```

```jsonl
{"_time":"2026-10-25T01:31:46.76Z","appState":"background","body":"[whoop-ble] native_connection_event","centralState":"poweredOn","connectionState":"streaming","errorCode":6,"errorDescription":"The connection has timed out unexpectedly.","errorDomain":"CBErrorDomain","nativeEvent":"disconnected","nativeOccurredAt":"2026-10-25T01:31:46.590Z","previousConnectionState":null,"reason":null,"reconnectIntent":true}
{"_time":"2026-10-25T01:31:46.766Z","appState":"background","body":"[whoop-ble] native_connection_event","centralState":"poweredOn","connectionState":"idle","errorCode":null,"errorDescription":null,"errorDomain":null,"nativeEvent":"state_transition","nativeOccurredAt":"2026-10-25T01:31:46.598Z","previousConnectionState":"streaming","reason":null,"reconnectIntent":true}
{"_time":"2026-10-25T01:31:46.767Z","appState":"background","body":"[whoop-ble] native_connection_event","centralState":"poweredOn","connectionState":"connecting","errorCode":null,"errorDescription":null,"errorDomain":null,"nativeEvent":"state_transition","nativeOccurredAt":"2026-10-25T01:31:46.602Z","previousConnectionState":"idle","reason":null,"reconnectIntent":true}
{"_time":"2026-10-25T01:31:46.768Z","appState":"background","body":"[whoop-ble] native_connection_event","centralState":"poweredOn","connectionState":"connecting","errorCode":null,"errorDescription":null,"errorDomain":null,"nativeEvent":"connect_requested","nativeOccurredAt":"2026-10-25T01:31:46.604Z","previousConnectionState":null,"reason":"automatic_reconnect","reconnectIntent":true}
{"_time":"2026-10-25T01:31:46.774Z","appState":null,"body":"[whoop-ble] BLE disconnected (The connection has timed out unexpectedly.), will reconnect","centralState":null,"connectionState":null,"errorCode":null,"errorDescription":null,"errorDomain":null,"nativeEvent":null,"nativeOccurredAt":null,"previousConnectionState":null,"reason":null,"reconnectIntent":null}
```

The native event records an OS-reported timeout at 18:31:46 Pacific, followed
14 ms later by an automatic reconnect request. The capture snapshot exported
at `01:31:46.771Z` recorded its last data notification at `01:31:40.439Z`.
These observations identify the failure and attempted recovery; they do not
establish what caused the link timeout or whether recovery later succeeded.
The five-minute delay in the [notification coordinator](../../packages/mobile/modules/background-refresh/ios/CollectionNotificationCoordinator.swift)
predicts an alert around 18:36:46 Pacific; actual delivery was not logged.

A complete mobile-service query returned no events after the disconnect export
through `01:40:00Z`:

```apl
['dofek-logs']
| where _time > datetime(2026-10-25T01:31:46.774Z) and _time < datetime(2026-10-25T01:40:00Z)
| where ['service.name'] == 'dofek-mobile'
| summarize events=count()
```

```jsonl
[]
```

Separately, the last-hour cloud-request aggregate returned 18 requests with
status `200`. This is evidence of successful logged cloud requests, not
Bluetooth recovery or complete capture. The user was asked to open Dofek to
allow retained native history to upload. Inspect `nativeOccurredAt` and the
native session when correlating replayed events: the [diagnostics reporter](../../packages/mobile/lib/whoop-ble-diagnostics.ts)
exports persisted history with the current snapshot context. In particular,
look for a later `handshake_aborted` event before attributing recovery failure
to the [application handshake timeout](../../packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager.swift).
Cause and recovery remain unresolved; no behavioral change or production
mutation was performed.
