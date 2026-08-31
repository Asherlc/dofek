# Wear Motion Agent Guide

Read [README.md](README.md) before changing this module.

- The process-owned listener must persist a complete channel stream before any
  Expo module call can observe it.
- Preserve the list/read/explicit-delete contract. Never delete a file before
  its application upload acknowledges success.
- Keep unsafe filename rejection identical at TypeScript and Kotlin boundaries.
- Capture unexpected native receipt failures with Sentry.
