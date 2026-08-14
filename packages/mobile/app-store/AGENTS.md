# App Store assets agent guide

Read [README.md](README.md) before changing this directory.

## Scope

- `screenshots/` contains generated App Store listing images and their manifest.
- `../scripts/capture-app-store-screenshots.ts` captures the images from the
  built mobile Storybook.
- Page stories and seeded data outside this directory define the rendered
  content; do not hand-edit generated screenshots.

## Change rules

- Keep screenshot order, filenames, captions, and the generated manifest in
  sync.
- Use Apple's current
  [screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
  and
  [app preview specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/app-preview-specifications);
  do not copy a volatile device matrix into repository documentation.
- Keep claims about App Store submission behavior cited to
  [App Store Connect Help](https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots).
- Never add real user health data to stories or screenshots.

## Validate

From the repository root:

```bash
pnpm app-store:mobile:screenshots
```

Review every generated image and `screenshots/manifest.json` before accepting
the change.
