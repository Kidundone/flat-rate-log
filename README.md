# Flat Rate Log

Flat Rate Log tracks flat-rate jobs, hours, pay, and proof with a single-browser frontend and a live Supabase data path.

## Current Status

- Build tag: `weekend-stable`
- Feature status: frozen for stabilization
- Active entry data path: `supabase`
- Source of truth: Supabase `work_logs` plus Supabase Storage for proof photos

The old local-only entry path is no longer the active runtime path for this weekend pass.

## Runtime Layout

The app is split into source modules under `src/`:

- `src/classification-service.js`
  Classifies jobs, prefixes, and work types.
- `src/data-service.js`
  Owns Supabase auth, row reads/writes, payroll data, and shared data normalization.
- `src/utils.js`
  Shared DOM helpers, date/math helpers, store helpers, formatting, and small cross-page utilities.
- `src/photo-service.js`
  Handles photo picking, compression, OCR helpers, uploads, and photo modal behavior.
- `src/main-page.js`
  Main logging page behavior, save flow, filters, totals, entry list rendering, and export actions tied to the main page.
- `src/more-page.js`
  More page behavior, payroll/settings/admin-style screens, and related event wiring.
- `src/boot.js`
  Build metadata, freeze flags, boot sequencing, page wiring, and startup registration.

## Build Flow

Do not edit the hashed bundle directly.

1. Edit files in `src/`
2. Run `node build.mjs`
3. `build.mjs` concatenates `src/*.js` into generated `app.src.js`
4. The same build writes a versioned `app.<hash>.js`
5. `index.html` and `more.html` are updated to the newest hashed bundle
6. Older hashed bundles are removed automatically

Current generated artifacts:

- `app.src.js`
  Generated, readable source bundle for inspection
- `app.<hash>.js`
  Generated deployable bundle referenced by the HTML entry points

## Data Notes

- Supabase is the active data path for auth and work log storage.
- Employee number still scopes the visible work log set inside the signed-in user account.
- Proof photos are stored in Supabase Storage.
- Exports remain available from the UI for CSV and JSON.

## Stability Notes

- This pass is for cleanup and hardening, not feature expansion.
- `boot.js` actively clears old service workers and caches during startup so stale client assets do not survive the module split.
- The removed local backend directory was not part of the active runtime path.

## Local Run

```bash
node build.mjs
open index.html
```

## License

MIT
