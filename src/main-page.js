let EDITING_ID = null; // null = creating new
let EDITING_ENTRY = null;
let isSaving = false;
let ocrBusy = false;

function setEditingEntry(entry) {
  EDITING_ENTRY = entry || null;
  EDITING_ID = entry?.id ?? null;

  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) saveBtn.textContent = EDITING_ID ? "Update" : "Save";

  const clearBtn = document.getElementById("clearBtn");
  if (clearBtn) clearBtn.textContent = "Clear";

  const cancelBtn = document.getElementById("cancelEditBtn");
  if (cancelBtn) cancelBtn.style.display = EDITING_ID ? "inline-flex" : "none";
}

function startEditEntry(entry) {
  if (!entry) return;
  setEditingEntry(entry);

  const empInputEl = document.getElementById("empId");
  const refEl = document.getElementById("ref");
  const vinEl = document.getElementById("vin8");
  const typeEl = document.getElementById("typeText");
  const hoursEl = document.getElementById("hours");
  const rateEl = document.querySelector('input[name="rate"]');
  const notesEl = document.querySelector('textarea[name="notes"]');

  if (empInputEl && entry.empId) {
    empInputEl.value = entry.empId;
    setActiveEmp(entry.empId);
  }
  if (refEl) refEl.value = entry.ref || entry.ro || "";
  if (vinEl) vinEl.value = entry.vin8 || "";
  if (typeEl) typeEl.value = entry.typeText || entry.type || "";
  if (hoursEl) { hoursEl.value = entry.hours != null ? String(entry.hours) : ""; hoursEl.dataset.touched = "1"; }
  if (rateEl) { rateEl.value = entry.rate != null ? String(entry.rate) : "15"; rateEl.dataset.touched = "1"; }
  if (notesEl) notesEl.value = entry.notes || "";
  clearPickedPhoto();
  setPhotoLabelFromEntry(entry);

  setRefType(entry.refType || "RO");

  const detailsPanel = document.getElementById("detailsPanel");
  const detailsBtn = document.getElementById("toggleDetailsBtn");
  if (detailsPanel && detailsBtn) {
    detailsPanel.style.display = "block";
    detailsBtn.textContent = "Less";
  }

  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) saveBtn.disabled = false;
}

document.addEventListener("click", async (e) => {
  const btn = e.target?.closest?.("[data-action]");
  if (!btn) return;

  const action = btn.getAttribute("data-action");
  const id = btn.getAttribute("data-id");

  if (action === "view-photo") {
    e.preventDefault();
    e.stopPropagation();
    await viewPhotoById(id);
    return;
  }

  // ...existing actions (edit/delete/etc)
}, true);

document.addEventListener("click", (ev) => {
  const btn = ev.target?.closest?.("[data-edit-id]");
  if (!btn) return;

  const id = (btn.getAttribute("data-edit-id") || "").trim();
  if (!id) return;

  const pool = Array.isArray(CURRENT_ENTRIES) ? CURRENT_ENTRIES : [];
  const entry = pool.find(e => String(e.id) === id);
  if (!entry) return;

  startEditEntry(entry);
});

document.addEventListener("click", async (ev) => {
  const delBtn = ev.target?.closest?.("[data-del]");
  if (!delBtn) return;

  const id = (delBtn.getAttribute("data-del") || "").trim();
  if (!id) return;

  await onDeleteClicked(delBtn, id);
});

async function handleDeleteEntry(entry, ev) {
  ev?.preventDefault();
  ev?.stopPropagation();

  if (!entry || entry.id == null) return toast("Missing id.");

  await onDeleteClicked(ev?.currentTarget, entry.id);
}

function handleClear(ev) {
  if (ev) ev.preventDefault();
  setEditingEntry(null);
  const empInputEl = document.getElementById("empId");
  const refEl = document.getElementById("ref");
  const vinEl = document.getElementById("vin8");
  const typeEl = document.getElementById("typeText");
  const hoursEl = document.getElementById("hours");
  const rateEl = document.querySelector('input[name="rate"]');
  const notesEl = document.querySelector('textarea[name="notes"]');

  if (refEl) refEl.value = "";
  if (vinEl) vinEl.value = "";
  if (typeEl) typeEl.value = "";
  if (hoursEl) { hoursEl.value = ""; hoursEl.dataset.touched = ""; }
  if (rateEl) { rateEl.value = "15"; rateEl.dataset.touched = ""; }
  if (notesEl) notesEl.value = "";
  clearPickedPhoto();
  if (empInputEl) empInputEl.value = getEmpId();
  setRefType("RO");
  const detailsPanel = document.getElementById("detailsPanel");
  const detailsBtn = document.getElementById("toggleDetailsBtn");
  if (detailsPanel) detailsPanel.style.display = "none";
  if (detailsBtn) detailsBtn.textContent = "Add Details";
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) saveBtn.disabled = true;
}

function focusHoursInput() {
  const hoursEl = document.getElementById("hours");
  if (!hoursEl) return;
  requestAnimationFrame(() => {
    try {
      hoursEl.focus({ preventScroll: true });
    } catch {
      hoursEl.focus();
    }
  });
}

function showToast(msg) {
  console.log(msg);
  toast(msg);
}

function buildOcrToast(ocr) {
  const bits = [];
  if (ocr.ro_suggestion) bits.push(`RO ${ocr.ro_suggestion}`);
  if (ocr.stock_suggestion) bits.push(`STK ${ocr.stock_suggestion}`);
  if (ocr.vin_suggestion) bits.push(`VIN ${last8(ocr.vin_suggestion) || ocr.vin_suggestion}`);
  else if (ocr.vin8_suggestion) bits.push(`VIN ${ocr.vin8_suggestion}`);
  if (ocr.ocr_status === "needs_review") bits.push("needs review");
  return bits.length ? `Found ${bits.join(" · ")}` : "Saved. No OCR match found";
}

async function queueOcrForSavedEntry(entry, refreshEntries) {
  if (!entry?.id || !entry?.photo_path) return;
  if (ocrBusy) return;

  ocrBusy = true;
  try {
    await markEntryQueuedForOcr(entry.id);
    showToast("Saved. Reading sheet...");

    await markEntryProcessingOcr(entry.id);

    const signedUrl = await getSignedPhotoUrl(entry.photo_path);
    if (!signedUrl) throw new Error("Could not open photo for OCR");

    const ocr = await runOcrOnImage(signedUrl);
    const foundSomething = !!(ocr?.ro_suggestion || ocr?.stock_suggestion || ocr?.vin_suggestion || ocr?.vin8_suggestion);
    if (foundSomething) {
      await saveOcrResult(entry.id, ocr);
      showToast(buildOcrToast(ocr));
    } else {
      await markOcrFailed(
        entry.id,
        ocr?.quality_warning ? "OCR could not confidently read this image" : "No OCR match found"
      );
      showToast(ocr?.quality_warning ? "Saved. OCR needs a clearer image" : "Saved. No OCR match found");
    }
    if (typeof refreshEntries === "function") await refreshEntries();
  } catch (err) {
    console.error("OCR queue failed", err);
    try { await markOcrFailed(entry.id, err); } catch {}
    showToast("Saved, but OCR failed");
  } finally {
    ocrBusy = false;
  }
}

function normalizeSuggestionValue(value) {
  return String(value || "").trim().toUpperCase();
}

function getDetectedSheetLabel(entry) {
  const sheetType = String(entry?.ocr_sheet_type || "").trim().toLowerCase();
  if (sheetType === "ro") return "RO sheet";
  if (sheetType === "get_ready") return "Get Ready sheet";
  if (sheetType) return `${sheetType.replace(/_/g, " ")} sheet`;
  return "OCR";
}

function getValidDetectedStock(entry) {
  const stock = normalizeSuggestionValue(entry?.ocr_stock_suggestion).replace(/[^A-Z0-9]/g, "");
  if (stock.length < 4 || stock.length > 10) return "";
  if (!/[0-9]/.test(stock)) return "";
  return stock;
}

function getValidDetectedRoNumber(entry) {
  const ro = normalizeSuggestionValue(entry?.ocr_ro_suggestion).replace(/\D/g, "");
  if (ro.length < 5 || ro.length > 8) return "";
  return ro;
}

function getValidDetectedVin(entry) {
  const vin = normalizeSuggestionValue(entry?.ocr_vin_suggestion).replace(/[^A-Z0-9]/g, "");
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return "";
  return vin;
}

function getValidDetectedVin8(entry) {
  const vin = getValidDetectedVin(entry);
  if (vin) return last8(vin);

  const vin8 = normalizeSuggestionValue(entry?.ocr_vin8_suggestion).replace(/[^A-Z0-9]/g, "");
  if (vin8.length < 6 || vin8.length > 8) return "";
  return vin8;
}

function getOcrDetectedFields(entry) {
  const roNumber = getValidDetectedRoNumber(entry);
  const stock = getValidDetectedStock(entry);
  const vin = getValidDetectedVin(entry);
  const vin8 = getValidDetectedVin8(entry);
  const currentRo = normalizeSuggestionValue(entry?.ro_number || entry?.ro || (entry?.refType === "RO" ? entry?.ref : "")).replace(/\D/g, "");
  const currentStock = normalizeSuggestionValue(entry?.stock || (entry?.refType === "STOCK" ? entry?.ref : "")).replace(/[^A-Z0-9]/g, "");
  const currentVin = normalizeSuggestionValue(entry?.vin).replace(/[^A-Z0-9]/g, "");
  const currentVin8 = normalizeSuggestionValue(entry?.vin8).replace(/[^A-Z0-9]/g, "");
  const patch = {};

  if (roNumber && roNumber !== currentRo) patch.ro_number = roNumber;
  if (stock && stock !== currentStock) patch.stock = stock;
  if (vin && vin !== currentVin) patch.vin = vin;
  if (vin8 && vin8 !== currentVin8) patch.vin8 = vin8;

  return {
    roNumber,
    stock,
    vin,
    vin8,
    sheetLabel: getDetectedSheetLabel(entry),
    patch,
  };
}

function getOcrSuggestionActions(entry) {
  const detected = getOcrDetectedFields(entry);
  const actions = [];

  if (detected.patch.ro_number || detected.patch.stock || detected.patch.vin || detected.patch.vin8) {
    actions.push({
      kind: "all",
      label: "Apply detected fields",
      appliedLabel: "Applied detected fields",
      patch: {
        ...detected.patch,
      },
      primary: true,
    });
  }

  if (detected.patch.stock) {
    actions.push({
      kind: "stock",
      label: "Apply STK",
      appliedLabel: `Applied STK ${detected.stock}`,
      patch: {
        stock: detected.stock,
      },
    });
  }

  if (detected.patch.vin || detected.patch.vin8) {
    actions.push({
      kind: "vin",
      label: "Apply VIN",
      appliedLabel: `Applied VIN ${detected.vin || detected.vin8}`,
      patch: {
        ...(detected.patch.vin ? { vin: detected.vin } : {}),
        ...(detected.patch.vin8 ? { vin8: detected.vin8 } : {}),
      },
    });
  }

  return actions;
}

function buildOcrSuggestionStripHtml(entry, actionAttrName = "data-ocr-action") {
  const detected = getOcrDetectedFields(entry);
  const actions = getOcrSuggestionActions(entry);
  if (!actions.length) return { actions, html: "" };

  const primaryAction = actions.find((action) => action.primary);
  const secondaryActions = actions.filter((action) => !action.primary);

  const html = `
    <div style="margin-top:10px;padding:10px;border:1px dashed rgba(29,78,216,.45);border-radius:12px;background:rgba(29,78,216,.08);">
      <div class="small" style="margin-bottom:8px;color:rgba(191,219,254,.95);">Detected fields</div>
      <div class="small">Detected RO: <span class="mono">${escapeHtml(detected.roNumber || "blank")}</span></div>
      <div class="small">Detected VIN: <span class="mono">${escapeHtml(detected.vin || "blank")}</span></div>
      <div class="small">Detected STK: <span class="mono">${escapeHtml(detected.stock || "blank")}</span></div>
      <div class="small" style="margin-bottom:8px;">Detected from ${escapeHtml(detected.sheetLabel)}</div>
      <div class="small" style="margin-bottom:8px;">Manual values stay in place until you tap Apply.</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${primaryAction ? `<button class="btn primary" type="button" ${actionAttrName}="${escapeHtml(primaryAction.kind)}">${escapeHtml(primaryAction.label)}</button>` : ""}
        ${secondaryActions.map((action) => `<button class="btn" type="button" ${actionAttrName}="${escapeHtml(action.kind)}">${escapeHtml(action.label)}</button>`).join("")}
      </div>
    </div>
  `;

  return { actions, html };
}

async function applyEntryOcrSuggestion(entry, action) {
  if (!entry?.id || !action?.patch) return;

  await applyOcrSuggestion(entry.id, {
    ...action.patch,
    updated_at: nowISO(),
  });
  showToast(action.appliedLabel || "Suggestion applied");
  await safeLoadEntries();

  if (String(EDITING_ID ?? "") !== String(entry.id ?? "")) return;

  const updated = (Array.isArray(CURRENT_ENTRIES) ? CURRENT_ENTRIES : [])
    .find((row) => String(row?.id ?? "") === String(entry.id ?? ""));
  if (updated) startEditEntry(updated);
}

function buildEntryMetaHtml(entry) {
  const dayKey = entry?.dayKey || dayKeyFromISO(entry?.createdAt) || entry?.work_date || "-";
  const vin8 = String(entry?.vin8 || "").trim();
  const meta = [];

  if (vin8) meta.push(`VIN8: <span class="mono">${escapeHtml(vin8)}</span>`);
  if (entryHasPhoto(entry)) meta.push("Photo attached");

  return `
    <div class="small">Date: <span class="mono">${escapeHtml(dayKey)}</span>${meta.length ? ` • ${meta.join(" • ")}` : ""}</div>
    <div class="small">Created: ${escapeHtml(formatWhen(entry?.createdAt || entry?.created_at || ""))} • Updated: ${escapeHtml(formatWhen(entry?.updatedAt || entry?.updated_at || entry?.createdAt || entry?.created_at || ""))}</div>
  `;
}

window.__FR = window.__FR || {};
window.__FR.queueOcrForSavedEntry = queueOcrForSavedEntry;

async function saveEntry(entry) {
  const payload = normalizeEntryForApi(entry);
  const photoFile = getSelectedPhotoFile();
  const empId = getEmpId();
  const client = empId ? sb() : null;
  const uid = client ? await requireUserId(client) : null;

  // SAVE LOG FIRST
  let saved;
  let photoStatus = "none";
  let photo_path = null;

  if (EDITING_ID) {
    const { photo_path: _ignored, ...patch } = payload;
    if (photoFile) toast("Uploading photo...");
    patch.updated_at = new Date().toISOString();
    saved = await saveEditedLog(EDITING_ID, patch);
    photo_path = saved?.photo_path || null;
    if (photoFile) photoStatus = "ok";
  } else {
    saved = await apiCreateLog(payload, entry);
    photo_path = saved?.photo_path || payload.photo_path || null;
    if (photoFile) {
      toast("Uploading photo...");
      try {
        const uploaded = await uploadProofPhoto({
          sb: client,
          empId,
          logId: saved.id,
          file: photoFile,
          roNumber: payload.ro_number || null,
        });
        const newPath = uploaded?.path || null;
        setPhotoUploadTarget(newPath);
        photo_path = newPath;
        photoStatus = "ok";
      } catch (err) {
        photoStatus = "fail";
      }
    }
  }

  const shouldUpdatePhotoPath = !photoFile && !!photo_path;
  if (shouldUpdatePhotoPath && empId && uid) {
    const { error } = await client
      .from("work_logs")
      .update({ photo_path })
      .eq("id", saved.id)
      .eq("user_id", uid)
      .eq("employee_number", empId);
    if (error) {
      if (photoFile) photoStatus = "fail";
    }
  }

  setEditingEntry(null);
  const savedEntryForOcr = {
    id: saved?.id || null,
    photo_path: photo_path || saved?.photo_path || null,
  };
  if (photoStatus === "fail") toast("Saved (photo failed)");
  else if (photoStatus === "ok") toast("Saved + Photo");
  else toast("Saved");
  handleClear();
  return savedEntryForOcr;
}

async function handleSave(ev) {
  ev?.preventDefault();
  const saveBtn = document.getElementById("saveBtn");
  if (isSaving) return;
  isSaving = true;
  if (saveBtn) saveBtn.disabled = true;
  try {
    const empId = getEmpId();
    if (!empId) { toast("Employee # required"); return; }

    const isEditing = !!EDITING_ID;
    const baseEntry = isEditing ? (EDITING_ENTRY || {}) : {};

    const refEl = document.getElementById("ref");
    const vinEl = document.getElementById("vin8");
    const typeEl = document.getElementById("typeText");
    const hoursEl = document.getElementById("hours");
    const rateEl = document.querySelector('input[name="rate"]');
    const notesEl = document.querySelector('textarea[name="notes"]');

    const ref = (refEl?.value || "").trim();
    const vin8 = (vinEl?.value || "").trim().toUpperCase();
    const typeName = (typeEl?.value || "").trim();
    const hoursVal = num(hoursEl?.value);
    const rateVal = num(rateEl?.value) || 15;
    const notes = (notesEl?.value || "").trim();

    if (!typeName) { toast("Type required"); return; }
    if (!hoursVal || hoursVal <= 0) { toast("Hours must be > 0"); return; }

    const createdAt = (isEditing && baseEntry.createdAt) ? baseEntry.createdAt : nowISO();
    const createdAtMs = (isEditing && Number.isFinite(baseEntry.createdAtMs)) ? baseEntry.createdAtMs : Date.now();
    const dayKey = (isEditing && baseEntry.dayKey) ? baseEntry.dayKey : dayKeyFromISO(createdAt);
    const entry = {
      ...baseEntry,
      // IMPORTANT: never generate a new id while editing.
      // If you do, you'll create duplicates and edits won't "stick".
      id: isEditing ? (baseEntry.id ?? EDITING_ID) : uuid(),
      empId,
      createdAt,
      createdAtMs,
      dayKey,
      weekStartKey: baseEntry.weekStartKey || dateKey(startOfWeekLocal(new Date(createdAt))),
      refType: currentRefType,
      ref,
      ro: ref,
      dealer: baseEntry.dealer || null,
      vin8,
      type: typeName,
      typeText: typeName,
      hours: round1(hoursVal),
      rate: round2(rateVal),
      earnings: round2(hoursVal * rateVal),
      notes,
      photoDataUrl: null,
      location: baseEntry.location ?? null
    };

    const refreshEntries = async () => {
      await safeLoadEntries();
    };
    await saveEntry(entry);
    await refreshEntries();
    setSelectedPhotoFile(null);
    document.getElementById("photoPicker") && (document.getElementById("photoPicker").value = "");
    document.getElementById("photoCamera") && (document.getElementById("photoCamera").value = "");
    document.getElementById("photoFile") && (document.getElementById("photoFile").value = "");
    focusHoursInput();
  } catch (err) {
    console.error("Save failed", err);
    const msg = /sign in required/i.test(String(err?.message || ""))
      ? "Sign in on More page first"
      : (err?.message || "Save failed");
    showToast(msg);
  } finally {
    isSaving = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}

function showHistory(open=true){
  const p = $("historyPanel");
  if (!p) return;
  p.style.display = open ? "block" : "none";
}

async function renderHistory(){
  const empId = getEmpId();
  if (!empId) { toast("Employee # required"); return; }

  const q = ($("historySearchInput")?.value || "").trim();
  const range = $("histRange")?.value || "week";
  const group = $("histGroup")?.value || "none";

  const all = filterEntriesByEmp(await getAll(STORES.entries), empId)
    .slice()
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

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

  slice = slice.filter(e => matchSearch(e, q));
  slice.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const totals = computeTotals(slice);
  const meta = $("historyMeta");
  if (meta) meta.textContent = `${slice.length} entries • ${formatHours(totals.hours)} hrs • ${formatMoney(totals.dollars)}`;

  const box = $("historyList");
  if (!box) return;
  box.innerHTML = "";

  if (!slice.length) {
    box.innerHTML = `<div class="muted">No entries match.</div>`;
    return;
  }

  if (group === "day") {
    const groups = groupByDay(slice);
    for (const g of groups) {
      const t = computeTotals(g.entries);
      const header = document.createElement("div");
      header.className = "item";
      header.innerHTML = `
        <div class="itemTop">
          <div class="mono">${g.dayKey}</div>
          <div class="right mono">${formatHours(t.hours)} hrs • ${formatMoney(t.dollars)}</div>
        </div>
      `;
      box.appendChild(header);

      for (const e of g.entries) {
        const row = document.createElement("div");
        row.className = "item";
        row.innerHTML = `
          <div class="itemTop">
            <div>
              <div class="mono">${escapeHtml(e.refType||"RO")}: ${escapeHtml(e.ref||e.ro||"-")} <span class="muted">(${escapeHtml(e.type||"")})</span></div>
              ${buildEntryMetaHtml(e)}
              ${e.notes ? `<div class="small" style="margin-top:6px;">${escapeHtml(e.notes)}</div>` : ""}
            </div>
            <div class="right">
              <div class="mono">${String(e.hours)} hrs @ ${formatMoney(e.rate)}</div>
              <div style="margin-top:6px;font-size:16px;">${formatMoney(e.earnings)}</div>
              <div style="margin-top:8px;display:flex;gap:8px;justify-content:flex-end;">
                <button class="btn" data-edit-id="${escapeHtml(String(e.id ?? ""))}" ${e.id == null ? "disabled" : ""}>Edit</button>
                <button class="btn danger" data-del="${e.id}">Delete</button>
              </div>
            </div>
          </div>`;
        box.appendChild(row);
      }
    }
    return;
  }

  // no group
  for (const e of slice.slice(0, 200)) {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div class="itemTop">
        <div>
          <div class="mono">${e.refType || "RO"}: ${escapeHtml(e.ref || e.ro || "-")} <span class="muted">(${escapeHtml(e.type||"")})</span></div>
          ${buildEntryMetaHtml(e)}
        </div>
        <div class="right">
          <div class="mono">${String(e.hours)} hrs @ ${formatMoney(e.rate)}</div>
          <div style="margin-top:6px;font-size:16px;">${formatMoney(e.earnings)}</div>
          <div style="margin-top:8px;display:flex;gap:8px;justify-content:flex-end;">
            <button class="btn" data-edit-id="${escapeHtml(String(e.id ?? ""))}" ${e.id == null ? "disabled" : ""}>Edit</button>
            <button class="btn danger" data-del="${e.id}">Delete</button>
          </div>
        </div>
      </div>
    `;
    box.appendChild(row);
  }
}

/* -------------------- Types: autocomplete + remembered defaults -------------------- */
const DEFAULT_TYPES = []; // no presets; the app learns from each employee

function cleanEmpId(empId){
  return String(empId ?? "").trim();
}

function normalizeTypeName(name){
  return String(name || "").trim();
}

function normalizeTypeLower(name){
  return normalizeTypeName(name).toLowerCase();
}

async function ensureDefaultTypes(){
  const empId = cleanEmpId(getEmpId());
  const types = await loadTypesSorted(empId);
  if (types.length > 0) return;
  const targetEmp = empId || "";
  for (const t of DEFAULT_TYPES) {
    await put(STORES.types, {
      id: uuid(),
      empId: targetEmp,
      name: t.name,
      nameLower: normalizeTypeLower(t.name),
      lastHours: t.lastHours,
      lastRate: t.lastRate,
      updatedAt: nowISO()
    });
  }
}

async function loadTypesSorted(empId){
  const e = String(empId || "").trim();
  const types = (await getAll(STORES.types)).filter(t => String(t.empId || "").trim() === e);
  types.sort((a,b) => a.name.localeCompare(b.name));
  return types;
}

async function renderTypeDatalist(){
  const list = $("typeList");
  if (!list) return;
  const empId = getEmpId();
  const types = await loadTypesSorted(empId);
  list.innerHTML = "";
  for (const t of types) {
    const opt = document.createElement("option");
    opt.value = t.name;
    list.appendChild(opt);
  }
}

async function findTypeByName(empId, name){
  const n = String(name || "").trim().toLowerCase();
  const e = String(empId || "").trim();
  if (!e || !n) return null;

  const types = await getAll(STORES.types);
  return types.find(t =>
    String(t.empId || "").trim() === e &&
    String(t.nameLower || "").trim() === n
  ) || null;
}

async function upsertTypeDefaults(nameRaw, hours, rate){
  const name = String(nameRaw || "").trim();
  if (!name) return;

  const empId = cleanEmpId(getEmpId());
  const nameLower = normalizeTypeLower(name);
  const existing = await findTypeByName(empId, name);
  const existingEmp = existing ? cleanEmpId(existing.empId) : null;
  const isSameEmp = existing && existingEmp === empId;
  const payload = {
    id: isSameEmp ? existing.id : uuid(),
    empId: isSameEmp ? existingEmp : empId,
    name: isSameEmp ? existing.name : name,
    nameLower,
    lastHours: Number(hours),
    lastRate: Number(rate),
    updatedAt: nowISO()
  };
  await put(STORES.types, payload);
  await renderTypeDatalist();
  await renderTypesListInMore();
}

async function maybeSaveTypeNameOnly(nameRaw){
  const name = String(nameRaw || "").trim();
  if (!name) return;
  const empId = cleanEmpId(getEmpId());
  const nameLower = normalizeTypeLower(name);
  const existing = await findTypeByName(empId, name);
  if (existing && cleanEmpId(existing.empId) === empId) return;
  await put(STORES.types, {
    id: uuid(),
    empId,
    name,
    nameLower,
    lastHours: 0.5,
    lastRate: 15,
    updatedAt: nowISO()
  });
  await renderTypeDatalist();
  await renderTypesListInMore();
}

async function maybeAutofillFromType(nameRaw){
  const name = String(nameRaw || "").trim();
  if (!name) return;
  const t = await findTypeByName(cleanEmpId(getEmpId()), name);
  if (!t) return;

  const hoursEl = $("hours");
  const rateEl  = document.querySelector('input[name="rate"]');

  if (hoursEl && hoursEl.dataset.touched === "1") return;
  if (rateEl && rateEl.dataset.touched === "1") return;

  if (hoursEl && Number.isFinite(Number(t.lastHours))) hoursEl.value = String(t.lastHours);
  if (rateEl && Number.isFinite(Number(t.lastRate))) rateEl.value = String(t.lastRate);
}

async function renderTypesListInMore(){
  const box = $("savedTypesList");
  if (!box) return;
  const empId = getEmpId();
  const types = await loadTypesSorted(empId);
  box.innerHTML = "";
  if (types.length === 0) {
    box.innerHTML = `<div class="muted">No saved types yet.</div>`;
    return;
  }
  for (const t of types) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="itemTop">
        <div>
          <div class="mono">${escapeHtml(t.name)}</div>
          <div class="small">defaults: ${String(t.lastHours ?? "")} hrs @ ${formatMoney(t.lastRate||0)}</div>
        </div>
        <div class="right"><span class="muted">tap to delete</span></div>
      </div>
    `;
    div.addEventListener("click", async () => {
      const ok = confirm(`Delete type "${t.name}"?`);
      if (!ok) return;
      await del(STORES.types, t.id);
      await renderTypeDatalist();
      await renderTypesListInMore();
    });
    box.appendChild(div);
  }
}

/* -------------------- Entries / Summary -------------------- */
function computeToday(entries, dayKey){
  const today = entries.filter(e => e.dayKey === dayKey);
  const hours = today.reduce((s, e) => s + Number(e.hours || 0), 0);
  const dollars = today.reduce((s, e) => s + Number(e.earnings || 0), 0);
  return { hours: round1(hours), dollars: round2(dollars), count: today.length };
}

function computeWeek(entries, weekStart){
  const weekEntries = entries.filter(e => inWeek(e.dayKey, weekStart));
  const hours = weekEntries.reduce((s, e) => s + Number(e.hours || 0), 0);
  const dollars = weekEntries.reduce((s, e) => s + Number(e.earnings || 0), 0);
  return { hours: round1(hours), dollars: round2(dollars), count: weekEntries.length, entries: weekEntries };
}

function filterByMode(entries, mode){
  const now = new Date();
  if (mode === "day") {
    const dayKey = todayKeyLocal();
    return entries.filter(e => e.dayKey === dayKey);
  }
  if (mode === "week") {
    const ws = startOfWeekLocal(now);
    return entries.filter(e => inWeek(e.dayKey, ws));
  }
  if (mode === "month") {
    const ms = startOfMonthLocal(now);
    return entries.filter(e => inMonth(e.dayKey, ms));
  }
  return entries;
}

function computeTotals(entries){
  const hours = entries.reduce((s, e) => s + Number(e.hours || 0), 0);
  const dollars = entries.reduce((s, e) => s + Number(e.earnings || 0), 0);
  const count = entries.length;
  const avgHrs = count ? (hours / count) : 0;
  return {
    hours: round1(hours),
    dollars: round2(dollars),
    count,
    avgHrs
  };
}

function computeWeekComparison(entries, now = new Date()){
  const { thisWeekKey, lastWeekKey } = getThisAndLastWeekKeys(now);

  const thisWeekEntries = filterByWeekStartKey(entries, thisWeekKey);
  const lastWeekEntries = filterByWeekStartKey(entries, lastWeekKey);

  const thisTotals = computeTotals(thisWeekEntries);
  const lastTotals = computeTotals(lastWeekEntries);

  return {
    keys: { thisWeekKey, lastWeekKey },
    entries: { thisWeekEntries, lastWeekEntries },
    totals: { thisTotals, lastTotals },
    diff: {
      hours: round1(thisTotals.hours - lastTotals.hours),
      dollars: round2(thisTotals.dollars - lastTotals.dollars),
      count: thisTotals.count - lastTotals.count,
      avgHrs: round1(thisTotals.avgHrs - lastTotals.avgHrs)
    }
  };
}

function addDaysLocal(d, days){
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function weekStartKeyForDate(d){
  // uses your existing helpers
  return dateKey(startOfWeekLocal(d));
}

function getThisAndLastWeekKeys(now = new Date()){
  const thisStart = startOfWeekLocal(now);
  const lastStart = addDaysLocal(thisStart, -7);
  return {
    thisWeekKey: dateKey(thisStart),
    lastWeekKey: dateKey(lastStart)
  };
}

function filterByWeekStartKey(entries, weekStartKey){
  return entries.filter(e => e && e.weekStartKey === weekStartKey);
}

function sumHours(entries) {
  return entries.reduce((acc, e) => acc + (Number(e.hours) || 0), 0);
}

function getWeekStats(allEntries, now = new Date()) {
  const entries = normalizeEntries(allEntries);

  const rThis = weekRangeFor("thisWeek", now);
  const rLast = weekRangeFor("lastWeek", now);

  const thisWeekEntries = entries.filter(e => inRange(e.createdAtMs, rThis.start, rThis.end));
  const lastWeekEntries = entries.filter(e => inRange(e.createdAtMs, rLast.start, rLast.end));

  const thisHours = sumHours(thisWeekEntries);
  const lastHours = sumHours(lastWeekEntries);
  const diff = thisHours - lastHours;

  return {
    ranges: { this: rThis, last: rLast },
    thisWeekEntries,
    lastWeekEntries,
    thisHours,
    lastHours,
    diff,
  };
}

function renderEntriesList(entries) {
  renderList(entries, "all");
}

function renderWeekHeader(allEntries) {
  const stats = getWeekStats(allEntries);

  const mainHours = summaryRange === "thisWeek" ? stats.thisHours : stats.lastHours;
  const otherHours = summaryRange === "thisWeek" ? stats.lastHours : stats.thisHours;
  const diff = stats.thisHours - stats.lastHours; // always this - last

  const paidThis = getPaidHoursForWeekStart(stats.ranges.this.start);
  const payrollDiff = stats.thisHours - paidThis;

  const hoursMain = document.getElementById("hoursMain");
  if (hoursMain) hoursMain.textContent = `${formatHours(mainHours)} hrs`;

  const hoursCompare = document.getElementById("hoursCompare");
  if (hoursCompare) hoursCompare.textContent = `Last Week: ${formatHours(otherHours)} hrs`;

  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "";
  const hoursDiff = document.getElementById("hoursDiff");
  if (hoursDiff) hoursDiff.textContent = `Diff: ${sign}${formatHours(Math.abs(diff))} hrs`;

  const paidHours = document.getElementById("paidHours");
  if (paidHours) paidHours.textContent = `Paid: ${formatHours(paidThis)} hrs`;

  const payrollSign = payrollDiff > 0 ? "+" : payrollDiff < 0 ? "−" : "";
  const payrollDiffEl = document.getElementById("payrollDiff");
  if (payrollDiffEl) {
    payrollDiffEl.textContent =
      `Payroll Diff: ${payrollSign}${formatHours(Math.abs(payrollDiff))} hrs`;
  }

  // Also render the list for the selected range
  const list = summaryRange === "thisWeek" ? stats.thisWeekEntries : stats.lastWeekEntries;
  renderEntriesList(list);

  // Optional: show the date range string
  const range = summaryRange === "thisWeek" ? stats.ranges.this : stats.ranges.last;
  const rangeLabel = document.getElementById("rangeLabel");
  if (rangeLabel) {
    rangeLabel.textContent =
      `${range.start.toLocaleDateString()} – ${addDays(range.end, -1).toLocaleDateString()}`;
  }
}

function filterEntriesByEmp(entries, empId, allowAll = false){
  const id = String(empId ?? getEmpId() ?? "").trim();
  if (!id) return allowAll ? (entries || []) : [];
  return (entries || []).filter(e => String(e.empId || "").trim() === id);
}

async function requireAdmin() {
  const pass = prompt("Admin export. Enter passcode:");
  return pass === "0231"; // change this
}

function rangeSubLabel(mode){
  const now = new Date();
  if (mode === "day") return dateKey(now);
  if (mode === "week") {
    const ws = startOfWeekLocal(now);
    const we = endOfWeekLocal(now);
    return `${dateKey(ws)} → ${dateKey(we)}`;
  }
  if (mode === "month") {
    const ms = startOfMonthLocal(now);
    const me = endOfMonthLocal(now);
    return `${dateKey(ms)} → ${dateKey(me)}`;
  }
  const entries = (window.__RANGE_FILTERED__ || window.__RANGE_ENTRIES__ || []);
  if (!entries.length) return "—";
  const keys = entries.map(e => e.dayKey).filter(Boolean).sort();
  return keys.length ? `${keys[0]} → ${keys[keys.length - 1]}` : "—";
}

function toCSV(entries, includeEmp = false){
  const header = includeEmp
    ? ["empId","createdAt","updatedAt","dayKey","refType","ref","vin8","type","hours","rate","earnings","notes","hasPhoto","photoPath"]
    : ["createdAt","updatedAt","dayKey","refType","ref","vin8","type","hours","rate","earnings","notes","hasPhoto","photoPath"];

  const escape = (v) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const rows = (entries || []).map(e => {
    const hasPhoto = e.photo_path || e.photoDataUrl ? "yes" : "no";
    const row = includeEmp
      ? [e.empId, e.createdAt, e.updatedAt || e.updated_at || e.createdAt, e.dayKey, e.refType || "RO", e.ref || e.ro || e.stock, e.vin8 || "", e.type, e.hours, e.rate, e.earnings, e.notes, hasPhoto, e.photo_path || ""]
      : [e.createdAt, e.updatedAt || e.updated_at || e.createdAt, e.dayKey, e.refType || "RO", e.ref || e.ro || e.stock, e.vin8 || "", e.type, e.hours, e.rate, e.earnings, e.notes, hasPhoto, e.photo_path || ""];
    return row.map(escape).join(",");
  });

  return [header.join(","), ...rows].join("\n");
}

async function downloadText(filename, text, mime="text/plain"){
  // iOS-friendly: try Share Sheet first
  try{
    const blob = new Blob([text], { type: mime });
    const file = new File([blob], filename, { type: mime });

    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return;
    }
  } catch {}

  // fallback: normal download
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setEntrySelectedById(id, selected) {
  const key = String(id ?? "").trim();
  if (!key) return;
  const next = !!selected;

  const apply = (rows) => {
    if (!Array.isArray(rows)) return;
    const hit = rows.find((row) => String(row?.id ?? "").trim() === key);
    if (hit) hit.selected = next;
  };

  apply(CURRENT_ENTRIES);
  apply(window.STATE?.entries);
  apply(window.__RANGE_ENTRIES__);
  apply(window.__RANGE_FILTERED__);
}

function renderList(entries, mode){
  const list = $("entryList");
  if (!list) return;
  list.innerHTML = "";

  const dayKey = todayKeyLocal();
  const byRange = (mode === "today") ? entries.filter(e => e.dayKey === dayKey) : entries;

  const pickedDay = (mode === "week") ? (window.__WEEK_DAY_PICK__ || "") : "";
  const ranged = pickedDay ? byRange.filter(e => e.dayKey === pickedDay) : byRange;

  const searchInput = document.getElementById("searchInput") || document.getElementById("searchBox");
  const q = (searchInput?.value || "").trim().toLowerCase();

  const visible = applySearch(ranged, q).slice();
  const isWeekRange = (window.__RANGE_MODE__ || rangeMode) === "week";
  visible.sort((a, b) => {
    const aTs = Date.parse(a.work_date || a.createdAt || "") || 0;
    const bTs = Date.parse(b.work_date || b.createdAt || "") || 0;
    return bTs - aTs;
  });
  const capped = visible.slice(0, 60);

  if (capped.length === 0) {
    const msg = q ? `No entries match "${escapeHtml(q)}".` : "No entries match your search.";
    list.innerHTML = `<div class="muted">${msg}</div>`;
    return;
  }

  const buildEntry = (e) => {
    const row = document.createElement("div");
    row.className = "item";
    const refLabel = e.refType === "STOCK" ? "STK" : "RO";
    const refVal = escapeHtml(e.ref || e.ro || "-");
    const refDisplay = `${refLabel}: ${refVal}`;
    const typeLabel = escapeHtml(e.type || e.typeText || "-");
    const entryId = escapeHtml(String(e.id ?? ""));
    const editBtn = `<button class="btn" data-action="edit" data-id="${e.id}">Edit</button>`;
    const deleteBtn = `<button class="btn danger" data-del="${e.id}">Delete</button>`;
    const viewPhotoBtn = entryHasPhoto(e)
      ? `<button class="btn" data-action="view-photo" data-id="${e.id}">View Photo</button>`
      : "";
    const actionButtons = [editBtn, deleteBtn, viewPhotoBtn].filter(Boolean).join(" ");
    row.innerHTML = `
      <div class="itemTop">
        <div>
          <div>
            <label class="small muted" style="display:inline-flex;align-items:center;gap:6px;margin-right:8px;">
              <input type="checkbox" data-select-id="${entryId}" ${e.selected ? "checked" : ""} />
              Select
            </label>
            <span class="mono">${refDisplay}</span> <span class="muted">(${typeLabel})</span>
          </div>
          ${buildEntryMetaHtml(e)}
          ${e.notes ? `<div style="margin-top:6px;">${escapeHtml(e.notes)}</div>` : ""}
          <div style="margin-top:8px;">${actionButtons}</div>
        </div>
        <div class="right">
          <div class="mono">${String(e.hours)} hrs @ ${formatMoney(e.rate)}</div>
          <div style="margin-top:6px;font-size:18px;">${formatMoney(e.earnings)}</div>
        </div>
      </div>
    `;
    const editBtnEl = row.querySelector('button[data-action="edit"]');
    if (editBtnEl) editBtnEl.addEventListener("click", () => startEditEntry(e));
    const selectEl = row.querySelector('input[data-select-id]');
    if (selectEl) {
      selectEl.addEventListener("change", (ev) => {
        setEntrySelectedById(e.id, !!ev.target?.checked);
      });
    }
    if (entryHasPhoto(e)) {
      const btn = row.querySelector('button[data-action="view-photo"]');
      if (btn) btn.addEventListener("click", () => openPhoto(e));
    }
    return row;
  };

  if (isWeekRange) {
    const groups = new Map();
    for (const e of capped) {
      const key = e.dayKey || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    const dayKeys = Array.from(groups.keys()).sort((a, b) => (b || "").localeCompare(a || ""));
    for (const key of dayKeys) {
      const bucket = groups.get(key) || [];
      const header = document.createElement("div");
      header.style.display = "flex";
      header.style.justifyContent = "space-between";
      header.style.alignItems = "baseline";
      header.style.margin = "8px 0";
      header.innerHTML = `
        <div class="mono">${escapeHtml(key || "Unknown")}</div>
        <div class="muted small">${formatDayLabel(key)}</div>
      `;
      list.appendChild(header);
      for (const e of bucket) {
        list.appendChild(buildEntry(e));
      }
    }
    return;
  }

  for (const e of capped) {
    list.appendChild(buildEntry(e));
  }
}

function applyPhotoLoadGuard(img, photo_path) {
  if (!img) return;
  img.onerror = () => {
    console.error("PHOTO LOAD FAILED", photo_path);
    img.replaceWith(
      Object.assign(document.createElement("div"), {
        textContent: "Photo failed to load",
        className: "photo-error"
      })
    );
  };
}

function ensurePhotoImg(id, container, styleText, beforeEl) {
  let img = document.getElementById(id);
  if (img || !container) return img;

  img = document.createElement("img");
  img.id = id;
  img.alt = "Proof photo";
  if (styleText) img.style.cssText = styleText;

  const errorDiv = container.querySelector(".photo-error");
  if (errorDiv) {
    errorDiv.replaceWith(img);
    return img;
  }

  if (beforeEl) container.insertBefore(img, beforeEl);
  else container.appendChild(img);
  return img;
}

async function viewPhotoById(id) {
  const entries = Array.isArray(CURRENT_ENTRIES) ? CURRENT_ENTRIES : [];
  const row = entries.find(e => String(e.id) === String(id));

  if (!row) {
    alert("Photo entry not found.");
    return;
  }

  const path = row.photo_path || row.photoPath;
  if (!path) {
    alert("No photo on this entry.");
    return;
  }

  const url = await getPhotoUrl(path);

  // whatever modal you already use:
  openPhotoModal(url, path);
}

function openPhotoModal(url, pathLabel) {
  const modal = document.getElementById("photoModal");
  const card = modal?.querySelector(".card");
  const img = ensurePhotoImg(
    "photoImg",
    card,
    "width:100%; height:auto; border-radius:14px; margin-top:12px; display:block;"
  );
  const label = document.getElementById("photoPathLabel") || document.getElementById("photoMeta");

  if (!modal || !img) {
    // fallback: just open in new tab
    window.open(url, "_blank");
    return;
  }

  if (label) label.textContent = pathLabel || "";
  applyPhotoLoadGuard(img, pathLabel);
  img.src = url;

  modal.classList.add("open"); // use your existing show logic
  document.body.classList.add("modal-open");
}

async function openPhoto(row) {
  const path = row?.photo_path || row?.photoPath;
  if (!path) return toast("No photo saved.");
  const url = await getPhotoUrl(path);
  openPhotoModal(url, path);
}

function closePhotoModal(){
  const shell = document.getElementById("photoModal");
  const img = document.getElementById("photoImg");
  if (img) img.src = "";
  if (shell) {
    shell.classList.remove("open");
    shell.style.display = "";
  }
  document.body.classList.remove("modal-open");
}

async function refreshUI(entriesOverride){
  if (!entriesOverride && !window.STATE?.entries?.length) {
    console.warn("refreshUI skipped — no data yet");
    return;
  }

  const allEntries = Array.isArray(entriesOverride)
    ? normalizeEntries(entriesOverride)
    : normalizeEntries(window.STATE.entries);

  const setText = (id, val) => { 
    const el = document.getElementById(id); 
    if (el) el.textContent = val; 
  };

  const empId = getEmpId();

  const entries = filterEntriesByEmp(allEntries, empId);
  entries.sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  window.__RANGE_ENTRIES__ = entries;

  const mode = window.__RANGE_MODE__ || rangeMode || "day";
  rangeMode = mode;

  const now = new Date();
  const dayKey = todayKeyLocal();
  let ws = startOfWeekLocal(now);
  let we = endOfWeekLocal(now);
  const ms = startOfMonthLocal(now);
  if (summaryRange === "lastWeek") {
    ws = new Date(ws);
    ws.setDate(ws.getDate() - 7);
    we = endOfWeekLocal(ws);
  }

  let filtered = filterByMode(entries, mode);

  let wc = null;
  let shownEntries = filtered;
  let shownTotals = null;
  if (mode === "week") {
    wc = computeWeekComparison(entries, now);
    shownEntries = summaryRange === "lastWeek" ? wc.entries.lastWeekEntries : wc.entries.thisWeekEntries;
    shownTotals = summaryRange === "lastWeek" ? wc.totals.lastTotals : wc.totals.thisTotals;
  }

  if (mode === "week") {
    // optional day filter inside week
    const pick = window.__WEEK_DAY_PICK__ || "";
    if (pick) shownEntries = shownEntries.filter(e => e.dayKey === pick);

    // render week breakdown (always uses full week, not the picked day)
    const days = computeWeekBreakdown(entries.filter(e => inWeek(e.dayKey, ws)), ws);
    renderWeekBreakdown(days);
  } else {
    // hide week breakdown when not in week mode
    const card = document.getElementById("weekBreakdownCard");
    if (card) card.style.display = "none";
    window.__WEEK_DAY_PICK__ = ""; // reset when leaving week mode
  }

  const searchInput = document.getElementById("searchInput") || document.getElementById("searchBox");
  const q = searchInput?.value || "";
  const searched = applySearch(shownEntries, q);

  window.__RANGE_FILTERED__ = searched; // replace for list + totals
  let totals = computeTotals(searched);
  let diffStr = "";
  if (mode === "week" && wc && shownTotals) {
    totals = shownTotals;
    const diffHrs = wc.diff.hours;
    diffStr = diffHrs > 0 ? `+${diffHrs}` : `${diffHrs}`;
  }

  const r1 = (n) => (Math.round(Number(n || 0) * 10) / 10).toFixed(1);

  const title =
    mode === "day" ? "Today" :
    mode === "week" ? (summaryRange === "lastWeek" ? "Last Week" : "This Week") :
    mode === "month" ? "This Month" : "All Time";

  setText("rangeTitle", title);
  setText("rangeHours", r1(totals.hours));
  setText("rangeDollars", formatMoney(totals.dollars));
  setText("rangeCount", String(totals.count));
  setText("rangeAvgHrs", r1(totals.avgHrs));
  setText("rangeSub", rangeSubLabel(mode));

  // Today
  const today = computeToday(entries, dayKey);
  setText("todayHours", round1(today.hours));
  setText("todayDollars", formatMoney(today.dollars));
  setText("todayCount", String(today.count));

  // Week
  const week = computeWeek(entries, ws);

  setText("weekHours", round1(week.hours));
  setText("weekDollars", formatMoney(week.dollars));
  setText("weekRange", `${dateKey(ws)} → ${dateKey(we)}`);
  if (diffStr) setText("weekDelta", `Diff: ${diffStr} hrs`);

  const flag = await getThisWeekFlag();
  const flagged = flag ? Number(flag.flaggedHours || 0) : 0;
  let delta = null; // ALWAYS defined

  if (!flagged || flagged <= 0) {
    setText("weekDelta", "—");
    setText("weekDeltaHint", "Set flagged hours in More");
  } else {
    delta = round1(flagged - week.hours);
    setText("weekDelta", String(delta));
    setText("weekDeltaHint", "");
  }

  // More panel input value
  const fh = document.getElementById("flaggedHours");
  if (fh && flag) fh.value = String(flagged);

  // Payroll preview/ocr
  await refreshPayrollUI();

  const fs = document.getElementById("filterSelect");
  const listFilter = fs ? fs.value : "today";
  const listMode = (listFilter === "today") ? "today" : "all";

  const status = document.getElementById("filterStatus");
  if (status) {
    const rangeLabel = title;
    const qtxt = q.trim() ? ` • Search: "${q.trim()}"` : "";
    status.textContent = `Showing: ${rangeLabel}${qtxt} • ${searched.length} entries`;
  }

  const hasWeekHeader =
    !!document.getElementById("hoursMain") ||
    !!document.getElementById("hoursCompare") ||
    !!document.getElementById("hoursDiff") ||
    !!document.getElementById("rangeLabel");
  if (hasWeekHeader) renderWeekHeader(entries);
  else renderList(shownEntries, listMode);

  // stash last week calc for export (delta always set)
  window.__WEEK_STATE__ = { ws, we, week, flagged, delta };
}
