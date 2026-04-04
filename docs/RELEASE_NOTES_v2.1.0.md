# Release Notes - v2.1.0

## Highlights

- `cafe_style` is removed from the default artist path.
- Artist ID now targets **Kaloscope2.0** with a verified LSNet runtime route.
- Censor Edit now prefers the local **Wenaka privacy-part YOLO** automatically.
- Generic `yolo26s-seg` and `yolov8s-seg` models are supported as compatibility models and clearly labeled as such.
- Similar search now reports local CLIP readiness directly in the UI.
- The launcher and browser now share the same model readiness truth through `backend/model_health.py`.

## User Experience Improvements

- Ordinary users no longer need to type a legacy YOLO path just to start censoring.
- `Censor`, `Similar`, and `Artist ID` now show clear runtime banners instead of failing silently.
- Release assets are split into a small app package, a portable core-model package, and optional heavy model packs.

## Verified Before Release

- Backend test suite: `379 passed, 2 skipped`
- Playwright smoke suite: `41 passed`
- Live API checks verified:
  - CLIP local model ready
  - Kaloscope runtime ready
  - Censor models endpoint reporting `recommended_backend: both`
  - Live censor detection returning privacy-part regions
  - Live artist identification request completing with `model_loaded: true`

## Release Assets

- `sd-image-sorter-v2.1.0-app.zip`
- `sd-image-sorter-v2.1.0-portable-core-models.zip`
- `sd-image-sorter-v2.1.0-wd14-eva02-model.zip`
- `sd-image-sorter-v2.1.0-artist-runtime.zip`
- Split archives for Kaloscope checkpoint and SAM3 checkpoint

See [RELEASE_PACKS.md](./RELEASE_PACKS.md) for extraction order and recommendations.

## Honest Limitation

- `SAM3` files can be included as optional release assets, but in the current verified setup the feature should still be treated as **GPU-only**.
