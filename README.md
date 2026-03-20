# Flat Rate Log

Flat Rate Log tracks flat-rate jobs, proof photos, OCR suggestions, review queues, and pay-stub comparison from a single-browser frontend backed by Supabase.

## Current Status

- Build tag: `weekend-stable`
- Active entry data path: `supabase`
- Active table: `work_logs`
- Proof photo bucket: `proofs`
- Feature mode: stabilization and hardening

## Runtime Rules

- Manual values always win.
- OCR can suggest, but it never overwrites `ro_number` or `vin8` by itself.
- OCR enrichment writes to `ocr_*` fields in `work_logs`.
- A user must tap `Apply STK ...` or `Apply VIN ...` before OCR suggestions become live entry data.
- Weak but partially readable images can land in `needs_review` instead of `failed`.

## Quick Entry

The default main-page flow is intentionally small:

1. Enter hours
2. Enter work done
3. Attach a proof photo if you have one
4. Save

RO/Stock, VIN, rate, and notes live behind the optional details panel so entry does not feel like paperwork.

## Review Flow

The More page is the cleanup and comparison surface:

- `Needs Review`
  Filters entries by proof presence, OCR waiting state, OCR failure, unapplied suggestions, and OCR mismatch.
- `Apply suggestion`
  One-tap controls let the user apply OCR stock/VIN suggestions only when they choose.
- `Pay Stub Entry`
  Compares paid totals against expected totals from logged entries.
- `Missing Work`
  Shows likely candidate entries for a shortfall. This is a heuristic because pay stubs only expose aggregate totals.

## Source Layout

The app is split into source modules under `src/`:

- `src/classification-service.js`
  OCR parsing, image quality gating, targeted region OCR, worker-backed Tesseract flow, and dealer classification helpers.
- `src/data-service.js`
  Supabase auth, `work_logs` reads/writes, OCR persistence helpers, payroll persistence, and row normalization.
- `src/utils.js`
  Shared date/math helpers, formatting, search/filter helpers, review-state helpers, and small cross-page utilities.
- `src/photo-service.js`
  Photo picking, downscaling, uploads, signed URL helpers, gallery rendering, and photo viewer behavior.
- `src/main-page.js`
  Quick Entry save flow, OCR suggestion apply controls, main entry list rendering, history, and exports.
- `src/more-page.js`
  Needs-review queue, pay-stub comparison, missing-work candidate view, exports, and More-page actions.
- `src/boot.js`
  Build metadata, startup sequencing, page wiring, and page-specific event binding.

## Build Flow

Do not edit generated bundles directly.

1. Edit files in `src/`
2. Run `node build.mjs`
3. `build.mjs` concatenates `src/*.js` into generated `app.src.js`
4. The same build writes a versioned `app.<hash>.js`
5. `index.html` and `more.html` are updated to the newest bundle
6. Older hashed bundles are removed automatically

Generated artifacts:

- `app.src.js`
  Readable generated source bundle
- `app.<hash>.js`
  Deployable bundle referenced by the HTML entry points

## Supabase Fields

Primary `work_logs` fields used by the app:

- `id`
- `user_id`
- `employee_number`
- `work_date`
- `category`
- `ro_number`
- `stock`
- `description`
- `flat_hours`
- `cash_amount`
- `location`
- `vin`
- `vin8`
- `photo_path`
- `dealer`
- `brand`
- `store_code`
- `campus`
- `created_at`
- `updated_at`

OCR and review fields:

- `ocr_status`
- `ocr_error`
- `ocr_quality_warning`
- `ocr_text_raw`
- `ocr_sheet_type`
- `ocr_ro_suggestion`
- `ocr_stock_suggestion`
- `ocr_vin_suggestion`
- `ocr_vin8_suggestion`
- `ocr_work_suggestion`
- `ocr_confidence`
- `ocr_processed_at`

## Demo Flow

Use this repeatable story:

1. Quick entry: hours + work done + optional photo
2. Save the entry
3. OCR enriches the saved photo in the background
4. Review totals on the main page
5. Compare the pay stub on the More page
6. Open the missing-work candidates and show the proof-backed entries

## Local Run

```bash
node build.mjs
open index.html
```

## License

MIT
