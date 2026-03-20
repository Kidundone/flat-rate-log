# Architecture

## Runtime Shape

Flat Rate Log is a browser-first app that loads one generated script bundle built from `src/*.js`.

Build order:

1. `src/classification-service.js`
2. `src/data-service.js`
3. `src/utils.js`
4. `src/photo-service.js`
5. `src/main-page.js`
6. `src/more-page.js`
7. `src/boot.js`

`build.mjs` concatenates those files into `app.src.js`, hashes the output into `app.<hash>.js`, updates `index.html` and `more.html`, and deletes older hashed bundles.

## Pages

### Main Page

Purpose:

- fast Quick Entry capture
- recent entry review
- one-tap OCR suggestion application
- totals and exports

Primary modules involved:

- `src/main-page.js`
- `src/photo-service.js`
- `src/data-service.js`

### More Page

Purpose:

- pay-stub entry
- needs-review queue
- missing-work candidate review
- photo gallery and OCR batch reprocessing
- exports and cleanup tools

Primary modules involved:

- `src/more-page.js`
- `src/photo-service.js`
- `src/data-service.js`

## Data Path

Active runtime source of truth:

- Supabase table: `work_logs`
- Supabase Storage bucket: `proofs`

The app no longer treats the old local-only entry path as the live weekend path.

## Entry Lifecycle

1. User enters hours, work done, and optionally a photo.
2. Main-page save flow writes the row to `work_logs`.
3. If a photo exists, the app uploads it to `proofs`.
4. Background OCR marks the row queued, then processing.
5. OCR stores suggestions only in `ocr_*` fields.
6. The UI exposes visible apply buttons for stock and VIN suggestions.
7. Manual values remain authoritative until the user taps an apply button.
8. Weak but usable OCR results persist as `needs_review` instead of hard failure.

## OCR Pipeline

The in-browser OCR path is optimized in this order:

1. Downscale the image before upload and OCR
2. Reject unusable images early
3. Detect the sheet type
4. Crop fixed template regions
5. OCR only the VIN and stock target regions
6. Run OCR through a dedicated Tesseract worker

OCR result persistence fields:

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

## Review Model

`getEntryReviewState(...)` in `src/utils.js` is the shared interpretation layer for:

- photo attached vs no photo
- OCR waiting
- OCR failed
- OCR suggestion ready
- OCR mismatch
- needs review

Both the main page and the More page render from that same review-state model.

## Missing-Work Comparison

The pay-stub workflow compares:

- expected hours and pay from logged entries in the selected week
- actual hours and pay from the pay stub entry

If a shortfall exists, the More page shows likely candidate entries for that missing work. This candidate list is heuristic because the pay stub only exposes totals, not line-item ROs.

## Guardrails

- Manual values win over OCR until the user explicitly applies a suggestion.
- OCR never auto-writes `ro_number` or `vin8`.
- The review queue exists to make OCR cleanup explicit instead of implicit.
- The app prefers visible, proof-backed records over hidden background enrichment.
