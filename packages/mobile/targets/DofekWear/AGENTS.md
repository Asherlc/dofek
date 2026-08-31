# Dofek Wear Agent Guide

Read [README.md](README.md) before changing this target.

- Persist a recording before offering it to `WearTransferClient`; no server
  credential belongs on the watch.
- Keep `RecordingRepository` portable and test it under `app/src/test`.
- Keep the phone receiver's filename validation aligned with the iOS
  `watch-motion` bridge.
- Do not edit generated Android project output. The source target is copied by
  `../../plugins/with-wear-os-target.js` during prebuild.
