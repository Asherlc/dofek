---
name: storybook-review
description: Use when asked to open a specific Dofek Storybook story for review or read its Canvas Comments annotations in the current conversation.
---

# Storybook Review

## Open the requested story

1. Use the story title, variant, or source path from the request to identify the
   package. The root scripts `storybook:web` and `storybook:mobile:web` serve
   `packages/web` and `packages/mobile` in a browser. The `storybook:mobile`
   and `storybook:mobile:ios` scripts run native Storybook. For native-only
   stories, use the native workflow and report that Canvas Comments needs a
   browser Storybook with the Vite builder. [Canvas Comments requirements](https://storybook.js.org/addons/storybook-addon-canvas-comments#requirements)
2. Reuse the matching workspace's running Storybook if it serves the requested
   story and has **UI Feedback** when annotation is needed. Otherwise start the
   repository script in a persistent workspace terminal. Web Storybook already
   registers Canvas Comments. Use an available port and leave other servers
   running. From the repository root, for example:

   ```bash
   rtk proxy mise exec -- pnpm storybook:web --host 127.0.0.1 --port 6106 --exact-port --ci --no-open --disable-telemetry
   ```

   For a Vite Storybook without Canvas Comments that needs annotation, use
   temporary mode from its package directory. Check the current stable addon
   release before fetching and use that exact version throughout the review.
   Replace the example version and port as needed. [Canvas Comments temporary mode](https://storybook.js.org/addons/storybook-addon-canvas-comments#trying-it-without-installing-temporary-mode)

   ```bash
   rtk proxy mise exec -- pnpm view storybook-addon-canvas-comments version
   rtk proxy mise exec -- pnpm dlx storybook-addon-canvas-comments@0.3.10 dev --host 127.0.0.1 --port 6106 --exact-port --ci --no-open --disable-telemetry
   ```

3. Fetch the live story index and match the requested title and variant.
   Use the returned ID in `/?path=/story/<id>` on that server. Share the direct
   story URL. [Storybook story index](https://storybook.js.org/docs/api/main-config/main-config-indexers)

   ```bash
   rtk proxy curl -fsS http://127.0.0.1:6106/index.json |
     rtk proxy jq '.entries[] | select(.type == "story" and .title == "Training/TrainingCalendar" and .name == "Default") | {id, importPath}'
   ```

4. In Paseo, use `browser_list_tabs` and reuse a relevant tab with
   `browser_navigate`, or open the direct URL with `browser_new_tab`. Verify
   the rendered story in the preview and the **UI Feedback** toolbar and panel
   when collecting annotations. Use `browser_snapshot` or `browser_screenshot`.
   If tab registration times out, check `browser_list_tabs` again before
   creating another tab. If browser verification is unavailable, share the
   direct URL and report the verification limit. [Paseo browser tools](https://paseo.sh/docs/browser-tools.md)

## Read feedback in this conversation

Keep the workspace path, the server's working directory, the base URL, and the
selected story ID in the current conversation. Ask the user to turn on **UI
Feedback**, click an element on the canvas, save the note, and tell this
conversation when it is ready to read. [Canvas Comments controls](https://storybook.js.org/addons/storybook-addon-canvas-comments#usage)

Run a one-shot read from the server's working directory, normally `packages/web`
or `packages/mobile`. Substitute the URL and ID from the current review. The
CLI reads local `.storybook/canvas-comments/comments.json` and returns open
notes with their anchor, captured DOM, and replies. If the file is missing,
check the server's working directory and whether a note was saved.
[Canvas Comments CLI](https://storybook.js.org/addons/storybook-addon-canvas-comments)

```bash
rtk proxy mise exec -- pnpm exec canvas-comments-dom-map \
  --storybook-url http://127.0.0.1:6106 \
  --story-id training-trainingcalendar--default --status open --include-dom-tree
```

For a temporary server, replace `pnpm exec` with
`pnpm --package=storybook-addon-canvas-comments@0.3.10 dlx`, using the server's
addon version.

If the user asks to wait, have them click **Complete review** in the Storybook
panel when finished. Use the same `pnpm` invocation with
`canvas-comments-wait-comments --story-id <id> --status open --include-dom-tree
--no-reset --timeout-ms <milliseconds>`. The default wait resets the shared
review status on startup and waits indefinitely. `--no-reset` preserves a
completion already recorded. For a fresh round after an earlier completion,
have the reviewer reopen the review before waiting. [Review completion](https://storybook.js.org/addons/storybook-addon-canvas-comments#review-completion-coding-agent-integration)

Return the direct manager story URL from the index step and a short summary of
the open notes in this conversation. Keep the server running for review and
keep `.storybook/canvas-comments/` out of commits. Leave comment status and
contents as the reviewer saved them. Apply fixes only when requested.
