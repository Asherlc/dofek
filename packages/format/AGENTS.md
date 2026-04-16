# Agent Guidelines for @dofek/format

Read the [README.md](./README.md) first to understand the implementation details.

- **Prefer UnitConverter**: Always use the `UnitConverter` class rather than hardcoding conversion factors like `2.20462`.
- **Handle Mobile Parsing**: Use `parseValidDate` instead of `new Date()` when dealing with strings from the database to ensure compatibility with Hermes.
- **Unit Stability**: All internal calculations MUST remain in metric; use this package only for the final display layer.
