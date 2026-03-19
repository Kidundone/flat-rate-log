/* -------------------- Payroll flagged hours (per week) -------------------- */
async function getThisWeekFlag(){
  const ws = startOfWeekLocal(new Date());
  const key = dateKey(ws);
  const stored = await get(STORES.weekflags, key);
  if (stored && Number.isFinite(Number(stored.flaggedHours))) return stored;

  const paid = getPaidRecordForWeekStart(ws);
  if (paid != null) {
    return { weekStartKey: key, flaggedHours: Number(paid || 0), updatedAt: null };
  }

  const stub = getPayStubForWeekKey(key);
  if (stub) {
    return { weekStartKey: key, flaggedHours: Number(stub.hoursPaid || 0), updatedAt: stub.updatedAt || null };
  }

  return null;
}
async function setThisWeekFlag(flaggedHours){
  const ws = startOfWeekLocal(new Date());
  const key = dateKey(ws);
  const value = Number(flaggedHours || 0);
  await put(STORES.weekflags, { weekStartKey: key, flaggedHours: value, updatedAt: nowISO() });
  setPaidHoursForWeekKey(key, value);
}

/* -------------------- Payroll scans (per week) -------------------- */
async function getWeekPayroll(){
  const ws = startOfWeekLocal(new Date());
  const key = dateKey(ws);
  return await get(STORES.payroll, key);
}

async function saveWeekPayroll({ photoDataUrl, ocrText }){
  const ws = startOfWeekLocal(new Date());
  const key = dateKey(ws);
  await put(STORES.payroll, { weekStartKey: key, photoDataUrl: photoDataUrl || null, ocrText: ocrText || "", updatedAt: nowISO() });
}

function rateForPdfEntry(entry, hours) {
  const directRate = Number(entry?.rate);
  if (Number.isFinite(directRate) && directRate >= 0) return directRate;

  const earnings = Number(entry?.earnings);
  if (Number.isFinite(earnings) && hours > 0) return earnings / hours;

  return 0;
}

function payForPdfEntry(entry, hours, rate) {
  const earnings = Number(entry?.earnings);
  if (Number.isFinite(earnings)) return round2(earnings);
  return round2(hours * rate);
}

async function exportEntriesToPDF(entries) {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) {
    alert("PDF export is not ready yet. Refresh and try again.");
    return;
  }

  const rows = Array.isArray(entries) ? entries : [];
  if (!rows.length) {
    alert("No entries to export.");
    return;
  }

  const doc = new jsPDF();
  const left = 20;
  const pageBottom = doc.internal.pageSize.getHeight() - 16;
  let y = 20;

  const nextLine = (step = 6) => {
    y += step;
    if (y > pageBottom) {
      doc.addPage();
      y = 20;
    }
  };

  doc.setFontSize(16);
  doc.text("Flat Rate Tracker Report", left, y);

  nextLine(10);

  const emp = getEmpId() || "N/A";
  doc.setFontSize(11);
  doc.text(`Employee: ${emp}`, left, y);

  nextLine(10);
  doc.text("RO      Type      Hours      Pay", left, y);
  nextLine(6);

  let totalHours = 0;
  let totalPay = 0;

  for (const e of rows) {
    const ro = e?.ro_number || e?.ref || e?.ro || "-";
    const type = e?.type || e?.typeText || e?.category || "-";
    const hours = Number(e?.hours ?? e?.flat_hours ?? 0) || 0;
    const rate = rateForPdfEntry(e, hours);
    const pay = payForPdfEntry(e, hours, rate);

    doc.text(
      `${String(ro).slice(0, 14)}   ${String(type).slice(0, 18)}   ${round1(hours)}   $${pay.toFixed(2)}`,
      left,
      y
    );
    nextLine(6);

    totalHours += hours;
    totalPay += pay;
  }

  nextLine(4);
  doc.text(`Total Hours: ${round1(totalHours)}`, left, y);
  nextLine(6);
  doc.text(`Total Pay: $${round2(totalPay).toFixed(2)}`, left, y);

  doc.save(`flat-rate-report-${todayKeyLocal()}.pdf`);
}

function exportSelected() {
  const selected = (window.STATE?.entries || []).filter((entry) => entry?.selected);

  if (!selected.length) {
    alert("No entries selected");
    return;
  }

  exportEntriesToPDF(selected);
}

function exportWeek(weekKey) {
  const currentWeekKey = dateKey(startOfWeekLocal(new Date()));
  const key = String(weekKey || currentWeekKey).trim();

  const entries = (window.STATE?.entries || []).filter((entry) => (
    String(entry?.weekStartKey || "") === key
    || String(entry?.dayKey || "").startsWith(key)
  ));

  if (!entries.length) {
    alert(`No entries found for week: ${key}`);
    return;
  }

  exportEntriesToPDF(entries);
}

window.exportEntriesToPDF = exportEntriesToPDF;
window.exportSelected = exportSelected;
window.exportWeek = exportWeek;

async function exportCSV(){
  const all = await getAll(STORES.entries);
  const entries = filterEntriesByEmp(all, getEmpId(), true);
  entries.sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  downloadText(`flat_rate_log_${todayKeyLocal()}.csv`, toCSV(entries, true), "text/csv");
}

async function exportJSON(){
  const all = await getAll(STORES.entries);
  const entries = filterEntriesByEmp(all, getEmpId(), true);
  entries.sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  downloadText(`flat_rate_log_${todayKeyLocal()}.json`, JSON.stringify(entries, null, 2), "application/json");
}

function wireOcrReprocessButton() {
  const btn = document.getElementById("processPhotosBtn");
  const status = document.getElementById("galleryStatus");
  if (!btn || !status) return;
  if (btn.dataset.wired === "1") return;
  btn.dataset.wired = "1";

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    status.textContent = "Looking for saved photos to process...";

    try {
      const entries = await listEntriesNeedingOcr(10);
      if (!entries.length) {
        status.textContent = "No saved photos need OCR.";
        return;
      }

      let done = 0;
      let failed = 0;
      let processed = 0;
      for (const entry of entries) {
        try {
          status.textContent = `Processing ${processed + 1}/${entries.length}... done ${done}, failed ${failed}`;
          await markEntryProcessingOcr(entry.id);
          const signedUrl = await getSignedPhotoUrl(entry.photo_path);
          const ocr = await runOcrOnImage(signedUrl);
          const foundSomething = !!(ocr?.stock_suggestion || ocr?.vin_suggestion || ocr?.vin8_suggestion);
          if (foundSomething) {
            await saveOcrResult(entry.id, ocr);
            done += 1;
          } else {
            await markOcrFailed(
              entry.id,
              ocr?.quality_warning ? "OCR could not confidently read this image" : "No OCR match found"
            );
            failed += 1;
          }
        } catch (err) {
          console.error("Saved photo OCR failed", entry.id, err);
          await markOcrFailed(entry.id, err);
          failed += 1;
        } finally {
          processed += 1;
          status.textContent = `Processed ${processed}/${entries.length}... done ${done}, failed ${failed}`;
        }
      }

      status.textContent = failed
        ? `Batch complete: ${done} processed, ${failed} failed.`
        : `Batch complete: ${done} photo(s).`;
    } catch (err) {
      console.error(err);
      status.textContent = "OCR batch failed.";
    } finally {
      btn.disabled = false;
    }
  });
}

async function saveFlaggedHours(){
  const fh = document.getElementById("flaggedHours");
  const val = fh ? Number(fh.value || 0) : 0;
  if (!Number.isFinite(val) || val < 0) return alert("Flagged hours must be a number >= 0.");
  await setThisWeekFlag(val);
  alert("Flagged hours saved for this week.");
}

function expectedTotalsForWeekKey(weekStartKey, empId = getEmpId()) {
  const dt = parseDateInputValue(weekStartKey);
  if (!dt) return { totals: computeTotals([]), entries: [] };

  const source = normalizeEntries(Array.isArray(CURRENT_ENTRIES) ? CURRENT_ENTRIES : []);
  const ownEntries = filterEntriesByEmp(source, empId);
  const weekEntries = ownEntries.filter((entry) => {
    const day = entry?.dayKey || dayKeyFromISO(entry?.createdAt);
    return day ? inWeek(day, dt) : false;
  });

  return { totals: computeTotals(weekEntries), entries: weekEntries };
}

function signedHoursLabel(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n === 0) return "0";
  const sign = n > 0 ? "+" : "−";
  return `${sign}${formatHours(Math.abs(n))}`;
}

function signedMoneyLabel(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  const sign = n > 0 ? "+" : "−";
  return `${sign}${formatMoney(Math.abs(n))}`;
}

function comparePayroll(expected, actual){
  const expHours = Number(expected?.hours || 0);
  const expPay = Number(expected?.pay || 0);
  const actHours = Number(actual?.hours || 0);
  const actPay = Number(actual?.pay || 0);

  return {
    missingHours: round1(expHours - actHours),
    missingPay: round2(expPay - actPay),
  };
}

function getPayStubAuditContext() {
  const weekEl = document.getElementById("payStubWeekEnding");
  const hoursEl = document.getElementById("payStubHoursPaid");
  const amountEl = document.getElementById("payStubAmountPaid");
  if (!weekEl || !hoursEl || !amountEl) {
    return { error: "Pay stub fields are not available on this page." };
  }

  const weekEnding = String(weekEl.value || "").trim();
  if (!weekEnding) return { error: "Week ending is required." };

  const weekStartKey = weekStartKeyFromDateInput(weekEnding);
  if (!weekStartKey) return { error: "Week ending date is invalid." };

  const hoursPaid = Number(hoursEl.value || 0);
  const amountPaid = Number(amountEl.value || 0);
  if (!Number.isFinite(hoursPaid) || hoursPaid < 0) return { error: "Hours paid must be a number >= 0." };
  if (!Number.isFinite(amountPaid) || amountPaid < 0) return { error: "Amount paid must be a number >= 0." };

  const { totals, entries } = expectedTotalsForWeekKey(weekStartKey);
  const expected = {
    hours: Number(totals?.hours || 0),
    pay: Number(totals?.dollars || 0),
  };
  const actual = {
    hours: hoursPaid,
    pay: amountPaid,
  };
  const comparison = comparePayroll(expected, actual);

  const ws = parseDateInputValue(weekStartKey);
  const weekEnd = ws ? dateKey(endOfWeekLocal(ws)) : "";

  return {
    weekEnding,
    weekStartKey,
    weekEnd,
    expected,
    actual,
    comparison,
    entries: Array.isArray(entries) ? entries : [],
  };
}

function hydratePayStubFormForWeek(weekStartKey) {
  const weekEl = document.getElementById("payStubWeekEnding");
  const hoursEl = document.getElementById("payStubHoursPaid");
  const amountEl = document.getElementById("payStubAmountPaid");
  if (!weekEl || !hoursEl || !amountEl) return;

  const key = String(weekStartKey || "").trim();
  const stub = getPayStubForWeekKey(key);
  if (stub) {
    weekEl.value = stub.weekEnding || weekEndingForWeekStartKey(key);
    hoursEl.value = String(Number(stub.hoursPaid || 0));
    amountEl.value = String(Number(stub.amountPaid || 0));
    return;
  }

  const weekEnd = weekEndingForWeekStartKey(key);
  if (weekEnd) weekEl.value = weekEnd;

  const startDate = parseDateInputValue(key);
  const paid = startDate ? getPaidRecordForWeekStart(startDate) : null;
  hoursEl.value = paid != null && Number(paid || 0) > 0 ? String(Number(paid)) : "";
  amountEl.value = "";
}

function renderPayStubComparison() {
  const weekEl = document.getElementById("payStubWeekEnding");
  const hoursEl = document.getElementById("payStubHoursPaid");
  const amountEl = document.getElementById("payStubAmountPaid");
  const summaryEl = document.getElementById("payStubSummary");
  const detailsEl = document.getElementById("payStubExpected");
  if (!weekEl || !hoursEl || !amountEl || !summaryEl || !detailsEl) return;

  if (!weekEl.value) {
    weekEl.value = dateKey(endOfWeekLocal(new Date()));
  }

  const ctx = getPayStubAuditContext();
  if (ctx.error) {
    summaryEl.textContent = ctx.error;
    detailsEl.textContent = "";
    renderMissingWorkReview();
    return;
  }

  summaryEl.textContent = `Week: ${ctx.weekStartKey}${ctx.weekEnd ? ` → ${ctx.weekEnd}` : ""}`;
  detailsEl.textContent =
    `Paid: ${formatHours(ctx.actual.hours)} hrs • ${formatMoney(ctx.actual.pay)} | ` +
    `Expected: ${formatHours(ctx.expected.hours)} hrs • ${formatMoney(ctx.expected.pay)} | ` +
    `Missing (expected-actual): ${signedHoursLabel(ctx.comparison.missingHours)} hrs • ${signedMoneyLabel(ctx.comparison.missingPay)}`;
  renderMissingWorkReview();
}

function drawAuditLines(doc, rows, left, startY) {
  const pageBottom = doc.internal.pageSize.getHeight() - 16;
  let y = startY;

  for (const row of rows) {
    const line = String(row || "");
    doc.text(line, left, y);
    y += 6;
    if (y > pageBottom) {
      doc.addPage();
      y = 20;
    }
  }

  return y;
}

async function exportAuditReport() {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) {
    alert("PDF export is not ready yet. Refresh and try again.");
    return;
  }

  const ctx = getPayStubAuditContext();
  if (ctx.error) {
    alert(ctx.error);
    return;
  }

  const doc = new jsPDF();
  const left = 20;
  let y = 20;
  const emp = getEmpId() || "N/A";

  doc.setFontSize(16);
  doc.text("Flat Rate Audit Report", left, y);
  y += 10;

  doc.setFontSize(11);
  y = drawAuditLines(doc, [
    `Employee: ${emp}`,
    `Week Ending: ${ctx.weekEnding}`,
    `Week Range: ${ctx.weekStartKey}${ctx.weekEnd ? ` -> ${ctx.weekEnd}` : ""}`,
    "",
    `Actual Paid Hours: ${formatHours(ctx.actual.hours)}`,
    `Actual Amount Paid: ${formatMoney(ctx.actual.pay)}`,
    `Expected Hours: ${formatHours(ctx.expected.hours)}`,
    `Expected Pay: ${formatMoney(ctx.expected.pay)}`,
    `Missing Hours (expected-actual): ${signedHoursLabel(ctx.comparison.missingHours)}`,
    `Missing Pay (expected-actual): ${signedMoneyLabel(ctx.comparison.missingPay)}`,
    "",
    `Entries used in expected totals: ${ctx.entries.length}`,
    "RO      Type      Day      Hours      Pay",
  ], left, y);

  const entryRows = ctx.entries.map((e) => {
    const ro = e?.ro_number || e?.ref || e?.ro || "-";
    const type = e?.type || e?.typeText || e?.category || "-";
    const day = e?.dayKey || dayKeyFromISO(e?.createdAt) || "-";
    const hours = Number(e?.hours ?? e?.flat_hours ?? 0) || 0;
    const rate = rateForPdfEntry(e, hours);
    const pay = payForPdfEntry(e, hours, rate);
    return `${String(ro).slice(0, 10)}   ${String(type).slice(0, 14)}   ${day}   ${round1(hours)}   $${pay.toFixed(2)}`;
  });

  if (entryRows.length) {
    y = drawAuditLines(doc, entryRows, left, y + 2);
  } else {
    y = drawAuditLines(doc, ["No entries found for that week."], left, y + 2);
  }

  y = drawAuditLines(doc, [
    "",
    `Totals: ${formatHours(ctx.expected.hours)} hrs • ${formatMoney(ctx.expected.pay)}`,
  ], left, y + 2);

  doc.save(`flat-rate-audit-${ctx.weekStartKey}.pdf`);
}

async function savePayStubEntry() {
  const weekEl = document.getElementById("payStubWeekEnding");
  const hoursEl = document.getElementById("payStubHoursPaid");
  const amountEl = document.getElementById("payStubAmountPaid");
  if (!weekEl || !hoursEl || !amountEl) return;

  const weekEnding = String(weekEl.value || "").trim();
  const hoursPaid = Number(hoursEl.value || 0);
  const amountPaid = Number(amountEl.value || 0);

  if (!weekEnding) return alert("Week ending is required.");
  if (!Number.isFinite(hoursPaid) || hoursPaid < 0) return alert("Hours paid must be a number >= 0.");
  if (!Number.isFinite(amountPaid) || amountPaid < 0) return alert("Amount paid must be a number >= 0.");

  const weekStartKey = weekStartKeyFromDateInput(weekEnding);
  if (!weekStartKey) return alert("Week ending date is invalid.");

  upsertPayStubEntry({
    weekStartKey,
    weekEnding,
    hoursPaid,
    amountPaid,
  });

  const thisWeekKey = dateKey(startOfWeekLocal(new Date()));
  if (weekStartKey === thisWeekKey) {
    await setThisWeekFlag(hoursPaid);
  }

  renderPayStubComparison();
  if (typeof refreshUI === "function") await refreshUI(CURRENT_ENTRIES);
  alert("Pay stub saved.");
}

function initPayStubUI() {
  const weekEl = document.getElementById("payStubWeekEnding");
  const hoursEl = document.getElementById("payStubHoursPaid");
  const amountEl = document.getElementById("payStubAmountPaid");
  if (!weekEl || !hoursEl || !amountEl) return;

  if (!weekEl.value) weekEl.value = dateKey(endOfWeekLocal(new Date()));

  const startKey = weekStartKeyFromDateInput(weekEl.value);
  if (startKey) hydratePayStubFormForWeek(startKey);
  renderPayStubComparison();

  weekEl.addEventListener("change", () => {
    const key = weekStartKeyFromDateInput(weekEl.value);
    if (key) hydratePayStubFormForWeek(key);
    renderPayStubComparison();
  });
  hoursEl.addEventListener("input", renderPayStubComparison);
  amountEl.addEventListener("input", renderPayStubComparison);
}

window.comparePayroll = comparePayroll;
window.exportAuditReport = exportAuditReport;

async function wipeLocalOnly(){
  await clearStore(STORES.entries);
  await clearStore(STORES.types);
  localStorage.removeItem(PAY_STUBS_KEY);
  localStorage.removeItem("paidHoursByWeek");
  if (_photosRequested) await renderPhotoGrid(true, { updateStatus: true });
  else clearPhotoGallery();
  await ensureDefaultTypes();
}

async function refreshPayrollUI(){
  const preview = $("payrollPreview");
  const ocrBox = $("payrollOcrText");
  if (preview) { preview.style.display = "none"; preview.removeAttribute("src"); }
  if (ocrBox) ocrBox.value = "";
  setPayrollStatus("");

  const data = await getWeekPayroll();
  if (!data) return;

  if (preview && data.photoDataUrl) {
    preview.src = data.photoDataUrl;
    preview.style.display = "block";
  }
  if (ocrBox && data.ocrText) {
    ocrBox.value = data.ocrText;
  }
}

async function wipeAllData(){
  const phrase = prompt('Type WIPE to delete ALL local data.');
  if (phrase !== "WIPE") return;
  await clearStore(STORES.entries);
  await clearStore(STORES.types);
  await clearStore(STORES.weekflags);
  await clearStore(STORES.payroll);
  localStorage.removeItem(PAY_STUBS_KEY);
  localStorage.removeItem("paidHoursByWeek");
  if (_photosRequested) await renderPhotoGrid(true, { updateStatus: true });
  else clearPhotoGallery();
}

function reviewFocusMatches(entry, focus) {
  const review = getEntryReviewState(entry);
  switch (focus) {
    case "with-photo":
      return review.hasPhoto;
    case "ocr-pending":
      return review.ocrWaiting;
    case "ocr-suggestions":
      return review.suggestionsPending && !review.ocrFailed;
    case "ocr-failed":
      return review.ocrFailed;
    case "ocr-mismatch":
      return review.refMismatch || review.vinMismatch;
    case "needs-review":
      return review.needsReview;
    case "all":
    default:
      return true;
  }
}

function buildReviewEntryRow(entry) {
  const facts = getEntryRecordFacts(entry);
  const review = facts.review;
  const refLabel = entry.refType === "STOCK" ? "STK" : "RO";
  const suggestionStrip = typeof buildOcrSuggestionStripHtml === "function"
    ? buildOcrSuggestionStripHtml(entry, "data-review-ocr")
    : { actions: [], html: "" };
  const applyActions = suggestionStrip.actions;
  const row = document.createElement("div");
  row.className = "item";
  row.innerHTML = `
    <div class="itemTop">
      <div>
        <div class="mono">${escapeHtml(refLabel)}: ${escapeHtml(entry.ref || entry.ro || "-")} <span class="muted">(${escapeHtml(entry.type || entry.typeText || "")})</span></div>
        <div class="small">Date: <span class="mono">${escapeHtml(facts.dayKey)}</span> • VIN8: <span class="mono">${escapeHtml(facts.vin8)}</span> • Photo: ${escapeHtml(facts.photoText)}</div>
        <div class="small">Created: ${escapeHtml(facts.createdText)} • Updated: ${escapeHtml(facts.updatedText)}</div>
        <div class="small">OCR: ${escapeHtml(facts.ocrText)}</div>
        ${entry.notes ? `<div class="small" style="margin-top:6px;">${escapeHtml(entry.notes)}</div>` : ""}
        ${suggestionStrip.html}
      </div>
      <div class="right">
        <div class="mono">${String(entry.hours)} hrs @ ${formatMoney(entry.rate)}</div>
        <div style="margin-top:6px;font-size:16px;">${formatMoney(entry.earnings)}</div>
        <div class="small" style="margin-top:8px;">${escapeHtml(review.statusLabel)}</div>
        <div style="margin-top:8px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
          ${review.hasPhoto ? `<button class="btn" type="button" data-review-photo="${escapeHtml(String(entry.id ?? ""))}">View Photo</button>` : ""}
          <button class="btn danger" data-del="${entry.id}">Delete</button>
        </div>
      </div>
    </div>
  `;

  if (review.hasPhoto) {
    const photoBtn = row.querySelector("button[data-review-photo]");
    photoBtn?.addEventListener("click", () => openPhotoViewer(entry));
  }

  const ocrBtns = Array.from(row.querySelectorAll("button[data-review-ocr]"));
  for (const btn of ocrBtns) {
    btn.addEventListener("click", async () => {
      const kind = btn.getAttribute("data-review-ocr") || "";
      const action = applyActions.find((item) => item.kind === kind);
      if (!action || typeof applyEntryOcrSuggestion !== "function") return;

      ocrBtns.forEach((el) => { el.disabled = true; });
      try {
        await applyEntryOcrSuggestion(entry, action);
        await renderReview();
        renderPayStubComparison();
      } catch (err) {
        console.error("Review OCR apply failed", entry?.id, kind, err);
        ocrBtns.forEach((el) => { el.disabled = false; });
      }
    });
  }

  return row;
}

function scoreMissingWorkCandidate(entry) {
  const review = getEntryReviewState(entry);
  let score = 0;
  if (review.hasPhoto) score += 30;
  if (entry.notes) score += 8;
  if (review.suggestionsPending) score += 6;
  if (review.ocrFailed) score += 4;
  score += Math.floor((Date.parse(entry.updatedAt || entry.createdAt || "") || 0) / 86400000);
  return score;
}

function getMissingWorkCandidates(ctx) {
  const missingHours = Number(ctx?.comparison?.missingHours || 0);
  const missingPay = Number(ctx?.comparison?.missingPay || 0);
  if (missingHours <= 0 && missingPay <= 0) return [];

  const remaining = {
    hours: missingHours,
    pay: missingPay,
  };

  const sorted = (ctx?.entries || []).slice().sort((a, b) => scoreMissingWorkCandidate(b) - scoreMissingWorkCandidate(a));
  const picks = [];

  for (const entry of sorted) {
    if (remaining.hours <= 0 && remaining.pay <= 0) break;
    const hours = Number(entry?.hours || 0);
    const pay = Number(entry?.earnings || 0);
    picks.push(entry);
    remaining.hours = round1(remaining.hours - hours);
    remaining.pay = round2(remaining.pay - pay);
  }

  return picks;
}

function renderMissingWorkReview() {
  const summaryEl = document.getElementById("missingWorkSummary");
  const listEl = document.getElementById("missingWorkList");
  if (!summaryEl || !listEl) return;

  const ctx = getPayStubAuditContext();
  listEl.innerHTML = "";

  if (ctx.error) {
    summaryEl.textContent = "";
    return;
  }

  const missingHours = Number(ctx.comparison?.missingHours || 0);
  const missingPay = Number(ctx.comparison?.missingPay || 0);
  if (missingHours <= 0 && missingPay <= 0) {
    summaryEl.textContent = `Logged ${ctx.entries.length} entries for the selected pay week. Paid totals currently cover the logged totals.`;
    return;
  }

  summaryEl.textContent =
    `Potential missing work based on logged entries for ${ctx.weekStartKey}${ctx.weekEnd ? ` -> ${ctx.weekEnd}` : ""}. This is a heuristic because the pay stub only contains totals.`;

  const picks = getMissingWorkCandidates(ctx);
  if (!picks.length) {
    listEl.innerHTML = `<div class="muted">No logged entries are available to explain the shortfall yet.</div>`;
    return;
  }

  for (const entry of picks) {
    listEl.appendChild(buildReviewEntryRow(entry));
  }
}

async function renderReview(){
  const empId = getEmpId();
  if (!empId) { setStatusMsg("Enter Employee # to review work."); return; }

  const range = document.getElementById("reviewRange")?.value || "week";
  const focus = document.getElementById("reviewFocus")?.value || "needs-review";
  const group = document.getElementById("reviewGroup")?.value || "day";
  const q = (document.getElementById("reviewSearch")?.value || "").trim().toLowerCase();

  const all = sortEntriesByRo(filterEntriesByEmp(await getAll(STORES.entries), empId));

  let slice = all;
  if (range === "week") {
    const ws = startOfWeekLocal(new Date());
    slice = all.filter(e => inWeek(e.dayKey || dayKeyFromISO(e.createdAt), ws));
  } else if (range === "lastweek") {
    const { ws } = getLastWeekRange();
    slice = all.filter(e => inWeek(e.dayKey || dayKeyFromISO(e.createdAt), ws));
  } else if (range === "month") {
    const ms = startOfMonthLocal(new Date());
    slice = all.filter(e => inMonth(e.dayKey || dayKeyFromISO(e.createdAt), ms));
  }

  slice = slice.filter((entry) => reviewFocusMatches(entry, focus));
  if (q) slice = slice.filter(e => matchSearch(e, q));

  const totals = computeTotals(slice);
  const reviewCounts = slice.reduce((acc, entry) => {
    const review = getEntryReviewState(entry);
    if (review.needsReview) acc.needsReview += 1;
    if (review.ocrFailed) acc.failed += 1;
    if (review.suggestionsPending) acc.suggestions += 1;
    if (review.refMismatch || review.vinMismatch) acc.mismatches += 1;
    return acc;
  }, { needsReview: 0, failed: 0, suggestions: 0, mismatches: 0 });
  const meta = document.getElementById("reviewMeta");
  if (meta) {
    meta.textContent =
      `${slice.length} entries • ${formatHours(totals.hours)} hrs • ${formatMoney(totals.dollars)} • ` +
      `${reviewCounts.needsReview} need review • ${reviewCounts.failed} OCR failed • ${reviewCounts.suggestions} suggestion ready • ${reviewCounts.mismatches} mismatch`;
  }

  const list = document.getElementById("reviewList");
  if (!list) return;

  list.innerHTML = "";
  if (!slice.length) { list.innerHTML = `<div class="muted">No entries match.</div>`; return; }

  if (group === "day" || group === "dealer") {
    const groups = group === "dealer" ? groupByDealer(slice) : groupByDay(slice);
    for (const g of groups) {
      const t = computeTotals(g.entries);
      const head = document.createElement("div");
      head.className = "item";
      head.innerHTML = `
        <div class="itemTop">
          <div class="mono">${group === "dealer" ? escapeHtml(g.dealer) : g.dayKey}</div>
          <div class="right mono">${formatHours(t.hours)} hrs • ${formatMoney(t.dollars)}</div>
        </div>`;
      list.appendChild(head);

      for (const e of g.entries) {
        list.appendChild(buildReviewEntryRow(e));
      }
    }
    return;
  }

  // no group
  for (const e of slice.slice(0, 200)) {
    list.appendChild(buildReviewEntryRow(e));
  }
}

async function exportAllCsvAdmin() {
  if (!(await requireAdmin())) return alert("Denied.");

  const entries = await getAll(STORES.entries);
  entries.sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  downloadText(`flat_rate_log_ALL_${todayKeyLocal()}.csv`, toCSV(entries), "text/csv");
}

window.__FR = window.__FR || {};
window.__FR.wireOcrReprocessButton = wireOcrReprocessButton;
