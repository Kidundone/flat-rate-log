# Flat Rate Log

A simple, offline-first log for flat-rate technicians to **track work, hours, pay, and proof** — without relying on memory, spreadsheets, or dealership systems.

This tool exists for one reason: **protect your pay**.

---

## What Flat Rate Log Does

- Log flat-rate jobs with:
  - RO / Stock #
  - Job type
  - Hours
  - Rate
  - Notes
  - Photo proof (optional)
- Automatically calculates:
  - Daily totals
  - Weekly totals
  - Monthly totals
  - Average hours per job
- Compare **logged hours vs flagged payroll hours**
- Filter by:
  - Day
  - Week
  - Month
  - All time
- Export your data as:
  - CSV
  - JSON
- Works **offline**
- No account required

---

## How Data Works (Important)

- All data is stored **locally on your device** using IndexedDB.
- Each technician is separated by **Employee Number**.
- Nothing is uploaded.
- Clearing browser data will remove logs.
- Exports are the source of truth.

This is intentional.

---

## Who This Is For

- Flat-rate technicians  
- Detailers  
- Anyone paid by flagged hours who needs proof  

This is **not** payroll software and does **not** replace dealership systems.

---

## How to Use

1. Open the app  
2. Enter your **Employee Number**  
3. Log each job as you complete it  
4. Attach a photo if proof is needed  
5. Review totals by Day / Week / Month  
6. Set flagged hours for the week (More → Payroll)  
7. Export your data if payroll doesn’t match  

That’s it.

---

## Exporting Data

- Exports are filtered by the **active Employee Number**
- To export:
  1. Enter your Employee Number
  2. Open **More**
  3. Choose CSV or JSON

CSV is recommended for payroll disputes.

---

## Why This Exists

Flat-rate work fails when:
- Jobs are forgotten
- Hours are shorted
- Proof is missing
- Payroll disputes turn into “he said / she said”

Flat Rate Log gives you:
- A record
- A timeline
- Proof

Nothing more. Nothing less.

---

## Installation (Optional)

You can run this directly from GitHub Pages, or locally.

```bash
git clone https://github.com/Kidundone/flat-rate-log.git
cd flat-rate-log
```

Open `index.html` in a browser.

---

## Tech Stack

- Vanilla JavaScript
- IndexedDB
- Service Workers
- Progressive Web App (PWA)

No frameworks. No backend.

---

## MVP Status

This project is intentionally scoped as an MVP.

Planned only after real-world use:
- Optional cloud sync
- Optional backend
- Team/manager views

Nothing will be added without a proven need.

---

## License

MIT License  
Use it. Modify it. Improve it.
