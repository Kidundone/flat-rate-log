# Test Checklist

## Build

- Run `node build.mjs`
- Run `node --check app.src.js`
- Confirm `index.html` and `more.html` point to the newest `app.<hash>.js`

## Quick Entry

- Employee number present
- Save button stays disabled until hours and work done are filled
- Save works with no RO/Stock value
- Details panel can be opened and closed
- Clearing the form resets it back to Quick Entry mode

## Missing Work

- Pay-stub form loads the selected week
- Paid vs expected totals update as fields change
- When paid totals are short, candidate entries render under the missing-work section
- Candidate entries include date, ref, VIN8, and created/updated timestamps
- When totals match or exceed expected totals, the missing-work section explains that no shortfall is indicated

## Proof and Metadata

- Main-page recent entries show date and created/updated timestamps
- History entries show the same proof and timestamp fields
- CSV export includes the core work-log fields only

## Browser Smoke

- Main page boots
- More page boots
- Supabase config is present
