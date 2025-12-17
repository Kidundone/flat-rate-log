const DB_NAME = "flatRateLogDB";
const DB_VERSION = 5;

const STORES = {
  entries: "entries",
  types: "types",
  weekflags: "weekflags",
  payroll: "payroll"
};

const $ = (id) => document.getElementById(id);

function nowISO(){ return new Date().toISOString(); }
function todayKeyLocal(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function formatMoney(n){
  const x = Number(n || 0);
  return `$${x.toFixed(2)}`;
}
function uuid(){
  return crypto.randomUUID ? crypto.randomUUID() : `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[c]));
}

function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORES.entries)) {
        const os = db.createObjectStore(STORES.entries, { keyPath: "id" });
        os.createIndex("createdAt", "createdAt", { unique: false });
        os.createIndex("dayKey", "dayKey", { unique: false });
        os.createIndex("ro", "ro", { unique: false });
        os.createIndex("type", "type", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.types)) {
        const os = db.createObjectStore(STORES.types, { keyPath: "id" });
        os.createIndex("name", "name", { unique: true });
      }

      if (!db.objectStoreNames.contains(STORES.weekflags)) {
        // key: weekStartKey (YYYY-MM-DD)
        const os = db.createObjectStore(STORES.weekflags, { keyPath: "weekStartKey" });
      }

      if (!db.objectStoreNames.contains(STORES.payroll)) {
        // key: weekStartKey (YYYY-MM-DD)
        db.createObjectStore(STORES.payroll, { keyPath: "weekStartKey" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode="readonly"){
  const db = await openDB();
  const t = db.transaction(storeName, mode);
  return { db, t, store: t.objectStore(storeName) };
}

async function getAll(storeName){
  const { db, store } = await tx(storeName, "readonly");
  const items = await new Promise((resolve, reject) => {
    const r = store.getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
  db.close();
  return items;
}

async function get(storeName, key){
  const { db, store } = await tx(storeName, "readonly");
  const item = await new Promise((resolve, reject) => {
    const r = store.get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
  db.close();
  return item;
}

async function put(storeName, item){
  const { db, store } = await tx(storeName, "readwrite");
  await new Promise((resolve, reject) => {
    const r = store.put(item);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
  db.close();
}

async function del(storeName, key){
  const { db, store } = await tx(storeName, "readwrite");
  await new Promise((resolve, reject) => {
    const r = store.delete(key);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
  db.close();
}

async function clearStore(storeName){
  const { db, store } = await tx(storeName, "readwrite");
  await new Promise((resolve, reject) => {
    const r = store.clear();
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
  db.close();
}

async function fileToDataURL(file){
  if (!file) return null;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/* -------------------- Week helpers (Mon–Sun) -------------------- */
function dateKey(d){
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function startOfWeekLocal(d=new Date()){
  // Monday as start
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay(); // 0 Sun ... 6 Sat
  const diff = (day === 0 ? -6 : 1 - day); // move back to Monday
  x.setDate(x.getDate() + diff);
  return x;
}
function endOfWeekLocal(d=new Date()){
  const s = startOfWeekLocal(d);
  const e = new Date(s);
  e.setDate(e.getDate() + 6);
  return e;
}
function inWeek(dayKeyStr, weekStart){
  // dayKeyStr = YYYY-MM-DD
  const s = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
  const e = endOfWeekLocal(weekStart);
  const [yy,mm,dd] = dayKeyStr.split("-").map(Number);
  const v = new Date(yy, mm-1, dd);
  return v >= s && v <= e;
}

/* -------------------- Types: autocomplete + remembered defaults -------------------- */
const DEFAULT_TYPES = [
  { name: "Preowned Detail", lastHours: 4.5, lastRate: 15 },
  { name: "FPF", lastHours: 1.0, lastRate: 15 },
  { name: "Sold", lastHours: 1.0, lastRate: 15 },
  { name: "Buff", lastHours: 1.0, lastRate: 15 }
];

async function ensureDefaultTypes(){
  const types = await getAll(STORES.types);
  if (types.length > 0) return;
  for (const t of DEFAULT_TYPES) {
    await put(STORES.types, { id: uuid(), name: t.name, lastHours: t.lastHours, lastRate: t.lastRate, updatedAt: nowISO() });
  }
}

async function loadTypesSorted(){
  const types = await getAll(STORES.types);
  types.sort((a,b) => a.name.localeCompare(b.name));
  return types;
}

async function renderTypeDatalist(){
  const list = $("typeList");
  if (!list) return;
  const types = await loadTypesSorted();
  list.innerHTML = "";
  for (const t of types) {
    const opt = document.createElement("option");
    opt.value = t.name;
    list.appendChild(opt);
  }
}

async function findTypeByName(name){
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  const types = await getAll(STORES.types);
  return types.find(t => String(t.name).toLowerCase() === n) || null;
}

async function upsertTypeDefaults(nameRaw, hours, rate){
  const name = String(nameRaw || "").trim();
  if (!name) return;

  const existing = await findTypeByName(name);
  const payload = {
    id: existing ? existing.id : uuid(),
    name: existing ? existing.name : name,
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
  const existing = await findTypeByName(name);
  if (existing) return;
  await put(STORES.types, { id: uuid(), name, lastHours: 0.5, lastRate: 15, updatedAt: nowISO() });
  await renderTypeDatalist();
  await renderTypesListInMore();
}

async function maybeAutofillFromType(nameRaw){
  const name = String(nameRaw || "").trim();
  if (!name) return;
  const t = await findTypeByName(name);
  if (!t) return;

  const hoursEl = document.querySelector('input[name="hours"]');
  const rateEl  = document.querySelector('input[name="rate"]');

  if (hoursEl && hoursEl.dataset.touched === "1") return;
  if (rateEl && rateEl.dataset.touched === "1") return;

  if (hoursEl && Number.isFinite(Number(t.lastHours))) hoursEl.value = String(t.lastHours);
  if (rateEl && Number.isFinite(Number(t.lastRate))) rateEl.value = String(t.lastRate);
}

async function renderTypesListInMore(){
  const box = $("savedTypesList");
  if (!box) return;
  const types = await loadTypesSorted();
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

/* -------------------- Payroll flagged hours (per week) -------------------- */
async function getThisWeekFlag(){
  const ws = startOfWeekLocal(new Date());
  const key = dateKey(ws);
  return await get(STORES.weekflags, key);
}
async function setThisWeekFlag(flaggedHours){
  const ws = startOfWeekLocal(new Date());
  const key = dateKey(ws);
  await put(STORES.weekflags, { weekStartKey: key, flaggedHours: Number(flaggedHours || 0), updatedAt: nowISO() });
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

/* -------------------- Entries / Summary -------------------- */
function computeToday(entries, dayKey){
  const today = entries.filter(e => e.dayKey === dayKey);
  const hours = today.reduce((s, e) => s + Number(e.hours || 0), 0);
  const dollars = today.reduce((s, e) => s + Number(e.earnings || 0), 0);
  return { hours, dollars, count: today.length };
}

function computeWeek(entries, weekStart){
  const weekEntries = entries.filter(e => inWeek(e.dayKey, weekStart));
  const hours = weekEntries.reduce((s, e) => s + Number(e.hours || 0), 0);
  const dollars = weekEntries.reduce((s, e) => s + Number(e.earnings || 0), 0);
  return { hours, dollars, count: weekEntries.length, entries: weekEntries };
}

function toCSV(entries){
  const header = ["createdAt","dayKey","ro","vin8","type","hours","rate","earnings","notes","hasPhoto"];
  const escape = (v) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const rows = entries.map(e => ([
    e.createdAt, e.dayKey, e.ro, e.vin8, e.type, e.hours, e.rate, e.earnings, e.notes,
    e.photoDataUrl ? "yes" : "no"
  ].map(escape).join(",")));
  return [header.join(","), ...rows].join("\n");
}

function downloadText(filename, text, mime="text/plain"){
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

function renderList(entries, mode){
  const list = $("entryList");
  if (!list) return;
  list.innerHTML = "";

  const dayKey = todayKeyLocal();
  const filtered = (mode === "today") ? entries.filter(e => e.dayKey === dayKey) : entries;

  if (filtered.length === 0) {
    list.innerHTML = `<div class="muted">No entries.</div>`;
    return;
  }

  for (const e of filtered.slice(0, 60)) {
    const div = document.createElement("div");
    div.className = "item";
    const ts = new Date(e.createdAt).toLocaleString();
    div.innerHTML = `
      <div class="itemTop">
        <div>
          <div><span class="mono">RO ${escapeHtml(e.ro)}</span> <span class="muted">(${escapeHtml(e.type)})</span></div>
          <div class="small">VIN8: <span class="mono">${escapeHtml(e.vin8 || "-")}</span> • ${ts}</div>
          ${e.notes ? `<div style="margin-top:6px;">${escapeHtml(e.notes)}</div>` : ""}
          ${e.photoDataUrl ? `<img alt="Proof" src="${e.photoDataUrl}" style="margin-top:10px;width:100%;max-height:240px;object-fit:cover;border-radius:14px;border:1px solid #222;" />` : ""}
        </div>
        <div class="right">
          <div class="mono">${String(e.hours)} hrs @ ${formatMoney(e.rate)}</div>
          <div style="margin-top:6px;font-size:18px;">${formatMoney(e.earnings)}</div>
        </div>
      </div>
    `;
    list.appendChild(div);
  }
}

async function refreshUI(){
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  const entries = await getAll(STORES.entries);
  entries.sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  // Today
  const dayKey = todayKeyLocal();
  const today = computeToday(entries, dayKey);
  setText("todayHours", String(today.hours));
  setText("todayDollars", formatMoney(today.dollars));
  setText("todayCount", String(today.count));

  // Week
  const ws = startOfWeekLocal(new Date());
  const we = endOfWeekLocal(new Date());
  const week = computeWeek(entries, ws);

  setText("weekHours", String(week.hours));
  setText("weekDollars", formatMoney(week.dollars));
  setText("weekRange", `${dateKey(ws)} → ${dateKey(we)}`);

  const flag = await getThisWeekFlag();
  const flagged = flag ? Number(flag.flaggedHours || 0) : 0;
  const delta = Number((flagged - week.hours).toFixed(1));
  setText("weekDelta", String(delta));

  // More panel input value
  const fh = document.getElementById("flaggedHours");
  if (fh && flag) fh.value = String(flagged);

  // Payroll preview/ocr
  await refreshPayrollUI();

  const fs = document.getElementById("filterSelect");
  const mode = fs ? fs.value : "today";
  renderList(entries, mode);

  // stash last week calc for export
  window.__WEEK_STATE__ = { ws, we, week, flagged, delta };
}

function registerSW(){
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

async function refreshPayrollUI(){
  const preview = $("payrollPreview");
  const ocrBox = $("payrollOcrText");
  if (preview) preview.innerHTML = "";
  if (ocrBox) ocrBox.value = "";

  const data = await getWeekPayroll();
  if (!data) return;

  if (preview && data.photoDataUrl) {
    const img = document.createElement("img");
    img.src = data.photoDataUrl;
    img.alt = "Payroll sheet";
    img.style.maxWidth = "100%";
    img.style.borderRadius = "12px";
    img.style.border = "1px solid #222";
    preview.appendChild(img);
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
}

/* -------------------- More panel -------------------- */
function openMore(){ $("morePanel").style.display = "block"; }
function closeMore(){ $("morePanel").style.display = "none"; }

/* -------------------- Boot -------------------- */
document.addEventListener("DOMContentLoaded", async () => {
  registerSW();

  await ensureDefaultTypes();
  await renderTypeDatalist();
  await renderTypesListInMore();

  // wiring
  const refreshBtn = $("refreshBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", refreshUI);
  const filter = $("filterSelect");
  if (filter) filter.addEventListener("change", refreshUI);

  const moreBtn = $("moreBtn");
  if (moreBtn) moreBtn.addEventListener("click", openMore);
  const closeBtn = $("closeMoreBtn");
  if (closeBtn) closeBtn.addEventListener("click", closeMore);
  const morePanel = $("morePanel");
  if (morePanel) morePanel.addEventListener("click", (e) => { if (e.target.id === "morePanel") closeMore(); });

  const hoursEl = document.querySelector('input[name="hours"]');
  const rateEl  = document.querySelector('input[name="rate"]');
  if (hoursEl) hoursEl.addEventListener("input", () => hoursEl.dataset.touched = "1");
  if (rateEl)  rateEl.addEventListener("input", () => rateEl.dataset.touched = "1");

  const clearBtn = $("clearFormBtn");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    $("logForm").reset();
    if (hoursEl){ hoursEl.value = "0.5"; hoursEl.dataset.touched = ""; }
    if (rateEl){ rateEl.value = "15"; rateEl.dataset.touched = ""; }
  });

  const wipeBtn = $("wipeBtn");
  if (wipeBtn) wipeBtn.addEventListener("click", async () => {
    await wipeAllData();
    await ensureDefaultTypes();
    await renderTypeDatalist();
    await renderTypesListInMore();
    await refreshUI();
  });

  const exportCsvBtn = $("exportCsvBtn");
  if (exportCsvBtn) exportCsvBtn.addEventListener("click", async () => {
    const entries = await getAll(STORES.entries);
    entries.sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    downloadText(`flat_rate_log_${todayKeyLocal()}.csv`, toCSV(entries), "text/csv");
  });

  const exportJsonBtn = $("exportJsonBtn");
  if (exportJsonBtn) exportJsonBtn.addEventListener("click", async () => {
    const entries = await getAll(STORES.entries);
    entries.sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    downloadText(`flat_rate_log_${todayKeyLocal()}.json`, JSON.stringify(entries, null, 2), "application/json");
  });

  const saveFlaggedBtn = $("saveFlaggedBtn");
  if (saveFlaggedBtn) saveFlaggedBtn.addEventListener("click", async () => {
    const fh = $("flaggedHours");
    const val = fh ? Number(fh.value || 0) : 0;
    if (!Number.isFinite(val) || val < 0) return alert("Flagged hours must be a number >= 0.");
    await setThisWeekFlag(val);
    await refreshUI();
    alert("Flagged hours saved for this week.");
  });

  const savePayrollPhotoBtn = $("savePayrollPhotoBtn");
  if (savePayrollPhotoBtn) savePayrollPhotoBtn.addEventListener("click", async () => {
    const pick = $("payrollPhotoPick");
    const cam = $("payrollPhotoCam");
    const file = (cam && cam.files && cam.files[0]) ? cam.files[0] : (pick && pick.files && pick.files[0]) ? pick.files[0] : null;
    if (!file) return alert("Choose a payroll photo first.");
    const photoDataUrl = await fileToDataURL(file);
    await saveWeekPayroll({ photoDataUrl, ocrText: $("payrollOcrText") ? $("payrollOcrText").value : "" });
    await refreshPayrollUI();
    alert("Payroll photo saved for this week.");
  });

  const scanPayrollBtn = $("scanPayrollBtn");
  if (scanPayrollBtn) scanPayrollBtn.addEventListener("click", async () => {
    const pick = $("payrollPhotoPick");
    const cam = $("payrollPhotoCam");
    const file = (cam && cam.files && cam.files[0]) ? cam.files[0] : (pick && pick.files && pick.files[0]) ? pick.files[0] : null;
    if (!file) return alert("Choose a payroll photo first.");
    if (!(window.Tesseract && window.Tesseract.recognize)) {
      return alert("Tesseract not loaded yet. Connect online once to cache it, then try again.");
    }
    const photoDataUrl = await fileToDataURL(file);
    const status = $("payrollPreview");
    if (status) status.innerHTML = "<div class=\"muted\">Scanning...</div>";
    try {
      const { data } = await Tesseract.recognize(photoDataUrl, "eng");
      const text = data && data.text ? data.text.trim() : "";
      const ocrBox = $("payrollOcrText");
      if (ocrBox) ocrBox.value = text;
      await saveWeekPayroll({ photoDataUrl, ocrText: text });
      await refreshPayrollUI();
      alert("OCR complete.");
    } catch (err) {
      console.error(err);
      alert("OCR failed. Try again while online or with a clearer photo.");
    }
  });

  const exportWeekSummaryBtn = $("exportWeekSummaryBtn");
  if (exportWeekSummaryBtn) exportWeekSummaryBtn.addEventListener("click", async () => {
    await refreshUI();
    const s = window.__WEEK_STATE__;
    if (!s) return;
    const lines = [];
    lines.push("FLAT-RATE LOG — WEEK SUMMARY");
    lines.push(`Week: ${dateKey(s.ws)} → ${dateKey(s.we)}`);
    lines.push(`Logged hours: ${s.week.hours}`);
    lines.push(`Logged $: ${formatMoney(s.week.dollars)}`);
    lines.push(`Payroll flagged hours: ${s.flagged}`);
    lines.push(`Delta (Flagged - Logged): ${s.delta}`);
    lines.push("");
    lines.push("Entries:");
    for (const e of s.week.entries.sort((a,b)=> (a.createdAt||"").localeCompare(b.createdAt||""))) {
      lines.push(`${e.dayKey} ${new Date(e.createdAt).toLocaleTimeString()} | RO ${e.ro} | ${e.type} | ${e.hours} hrs | $${e.earnings}`);
    }
    downloadText(`week_summary_${dateKey(s.ws)}.txt`, lines.join("\n"), "text/plain");
  });

  // ---- Proof Packet Export (HTML + JSON) ----
  function buildProofPacket(state, payroll){
    const ws = state.ws;
    const we = state.we;
    const weekEntries = (state.week.entries || []).slice().sort((a,b)=> (a.createdAt||"").localeCompare(b.createdAt||""));
    return {
      meta: {
        generatedAt: nowISO(),
        app: "Flat-Rate Log",
        version: "proof-packet-v1"
      },
      week: {
        start: dateKey(ws),
        end: dateKey(we)
      },
      totals: {
        loggedHours: Number(state.week.hours || 0),
        loggedDollars: Number(state.week.dollars || 0),
        entriesCount: Number(state.week.count || weekEntries.length),
        payrollFlaggedHours: Number(state.flagged || 0),
        differenceFlaggedMinusLogged: Number(state.diff || 0)
      },
      payroll: {
        photoDataUrl: payroll?.photoDataUrl || null,
        ocrText: payroll?.ocrText || ""
      },
      entries: weekEntries
    };
  }

  function downloadHTML(filename, html){
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function proofHTML(packet){
    const esc = (s) => String(s ?? "").replace(/[&<>\"']/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
    const money = (n) => `$${Number(n||0).toFixed(2)}`;
    const rows = (packet.entries||[]).map(e => {
      const t = new Date(e.createdAt).toLocaleString();
      return `
        <tr>
          <td>${esc(e.dayKey)}</td>
          <td>${esc(t)}</td>
          <td>${esc(e.ro)}</td>
          <td>${esc(e.vin8 || "-")}</td>
          <td>${esc(e.type)}</td>
          <td style="text-align:right">${esc(e.hours)}</td>
          <td style="text-align:right">${money(e.rate)}</td>
          <td style="text-align:right">${money(e.earnings)}</td>
          <td>${esc(e.notes || "")}</td>
        </tr>
      `;
    }).join("");

    const img = packet.payroll.photoDataUrl ? `<img src="${packet.payroll.photoDataUrl}" style="width:100%;max-height:520px;object-fit:contain;border:1px solid #ddd;border-radius:12px" />` : `<div style="color:#666">No payroll photo saved for this week.</div>`;

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Flat-Rate Proof Packet</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 18px; color: #111; }
    .card { border: 1px solid #e5e5e5; border-radius: 14px; padding: 14px; margin-bottom: 14px; }
    h1 { margin: 0 0 10px 0; font-size: 20px; }
    h2 { margin: 0 0 10px 0; font-size: 16px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .k { color:#666; font-size: 12px; margin-bottom: 4px; }
    .v { font-size: 14px; font-weight: 600; }
    table { width:100%; border-collapse: collapse; font-size: 12px; }
    th, td { border-bottom: 1px solid #eee; padding: 8px; vertical-align: top; }
    th { text-align:left; background: #fafafa; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    @media print { .card { break-inside: avoid; } }
  </style>
</head>
<body>
  <h1>Flat-Rate Proof Packet</h1>
  <div class="card">
    <div class="grid">
      <div>
        <div class="k">Week</div>
        <div class="v mono">${esc(packet.week.start)} → ${esc(packet.week.end)}</div>
      </div>
      <div>
        <div class="k">Generated</div>
        <div class="v mono">${esc(packet.meta.generatedAt)}</div>
      </div>
      <div>
        <div class="k">Logged Hours</div>
        <div class="v">${esc(packet.totals.loggedHours)}</div>
      </div>
      <div>
        <div class="k">Logged $</div>
        <div class="v">${money(packet.totals.loggedDollars)}</div>
      </div>
      <div>
        <div class="k">Payroll Flagged Hours</div>
        <div class="v">${esc(packet.totals.payrollFlaggedHours)}</div>
      </div>
      <div>
        <div class="k">Difference (Flagged - Logged)</div>
        <div class="v">${esc(packet.totals.differenceFlaggedMinusLogged)}</div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Payroll Sheet Photo</h2>
    ${img}
  </div>

  <div class="card">
    <h2>Entries</h2>
    <table>
      <thead>
        <tr>
          <th>Date</th><th>Time</th><th>RO</th><th>VIN8</th><th>Type</th>
          <th style="text-align:right">Hours</th><th style="text-align:right">Rate</th><th style="text-align:right">$</th><th>Notes</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="9" style="color:#666">No entries for this week.</td></tr>`}
      </tbody>
    </table>
  </div>
</body>
</html>`;
  }

  const exportProofHtmlBtn = $("exportProofHtmlBtn");
  if (exportProofHtmlBtn) exportProofHtmlBtn.addEventListener("click", async () => {
    await refreshUI();
    const state = window.__WEEK_STATE__;
    const payroll = await getThisWeekPayroll();
    const packet = buildProofPacket(state, payroll);
    const html = proofHTML(packet);
    downloadHTML(`proof_packet_${packet.week.start}.html`, html);
  });

  const exportProofJsonBtn = $("exportProofJsonBtn");
  if (exportProofJsonBtn) exportProofJsonBtn.addEventListener("click", async () => {
    await refreshUI();
    const state = window.__WEEK_STATE__;
    const payroll = await getThisWeekPayroll();
    const packet = buildProofPacket(state, payroll);
    downloadText(`proof_packet_${packet.week.start}.json`, JSON.stringify(packet, null, 2), "application/json");
  });

  const typeEl = $("typeText");
  if (typeEl) {
    typeEl.addEventListener("blur", async () => {
      await maybeSaveTypeNameOnly(typeEl.value);
      await maybeAutofillFromType(typeEl.value);
    });
    typeEl.addEventListener("change", async () => {
      if (hoursEl) hoursEl.dataset.touched = "";
      if (rateEl) rateEl.dataset.touched = "";
      await maybeAutofillFromType(typeEl.value);
    });
  }

  const form = $("logForm");
  if (form) form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);

    const ro = String(fd.get("ro") || "").trim();
    const vin8 = String(fd.get("vin8") || "").trim().toUpperCase().slice(0,8);
    const type = String(fd.get("typeText") || "").trim();

    const hours = Number(fd.get("hours") || 0);
    const rate = Number(fd.get("rate") || 0);
    const notes = String(fd.get("notes") || "").trim();

    const photoFile = fd.get("photo");
    const photoDataUrl = (photoFile && photoFile.size) ? await fileToDataURL(photoFile) : null;

    if (!ro) return alert("RO # is required.");
    if (!type) return alert("Type is required.");
    if (!Number.isFinite(hours) || hours <= 0) return alert("Hours must be > 0 (decimals ok).");
    if (!Number.isFinite(rate) || rate < 0) return alert("Rate must be >= 0.");

    const createdAt = nowISO();
    const dayKey = todayKeyLocal();
    const earnings = Number((hours * rate).toFixed(2));

    await put(STORES.entries, {
      id: uuid(),
      createdAt,
      dayKey,
      ro,
      vin8,
      type,
      hours,
      rate,
      earnings,
      notes,
      photoDataUrl
    });

    await upsertTypeDefaults(type, hours, rate);

    ev.target.reset();
    if (hoursEl){ hoursEl.value = "0.5"; hoursEl.dataset.touched = ""; }
    if (rateEl){ rateEl.value = "15"; rateEl.dataset.touched = ""; }

    await refreshUI();
  });

  await refreshUI();
});
