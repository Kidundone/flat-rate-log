# Test Checklist

## Build

- Run `node build.mjs`
- Run `node --check app.src.js`
- Confirm `index.html` and `more.html` point to the newest `app.<hash>.js`

## Quick Entry

- Employee number present
- Save button stays disabled until hours and work done are filled
- Save works with no RO/Stock value
- Save works with a photo attached
- Details panel can be opened and closed
- Clearing the form resets it back to Quick Entry mode

## OCR

- Saving an entry with a photo queues OCR
- OCR does not overwrite manual `ro_number` or `vin8`
- Visible apply buttons appear when OCR finds stock or VIN suggestions
- `Apply STK ...` updates the live entry value
- `Apply VIN ...` updates the live entry value
- OCR failure writes `ocr_status = failed` and a readable `ocr_error`
- Tiny or missing images fail fast instead of running full OCR

## Needs Review

- `Needs Review` filter shows pending OCR, failed OCR, and suggestion/mismatch cases
- `Photo Attached` filter only shows entries with proof photos
- `OCR Failed` filter shows failed rows and the error detail
- `OCR Mismatch` filter shows rows where manual values differ from OCR suggestions
- Apply buttons work inside the review queue and refresh the list

## Missing Work

- Pay-stub form loads the selected week
- Paid vs expected totals update as fields change
- When paid totals are short, candidate entries render under the missing-work section
- Candidate entries include date, ref, VIN8, photo state, created/updated timestamps, and OCR state
- When totals match or exceed expected totals, the missing-work section explains that no shortfall is indicated

## Proof and Metadata

- Main-page recent entries show date, photo state, created/updated timestamps, and OCR state
- History entries show the same proof and timestamp fields
- More-page review entries show the same proof and timestamp fields
- CSV export includes `updatedAt`, proof fields, and OCR fields

## Photos

- Pick Photo, Take Photo, and Pick File all attach a photo
- Saved photo label changes to `Photo attached` on existing entries
- More-page photo gallery still loads and opens the viewer
- Batch OCR processing still runs in batches of 10

## Browser Smoke

- Main page boots
- More page boots
- Supabase config is present
- Tesseract worker path is available
- `Process OCR` button exists on the More page
