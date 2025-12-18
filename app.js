const DB_NAME = "flatRateLogDB";
const DB_VERSION = 5;

const STORES = {
  entries: "entries",
  types: "types",
  weekflags: "weekflags",
  payroll: "payroll"
};

const $ = (id) => document.getElementById(id);

console.log("BUILD", "c3fdf8a", new Date().toISOString());

function setStatusMsg(msg){
  const s = $("statusMsg");
  if (s) s.textContent = msg;
}

function toast(msg){
  const t = document.getElementById("toast");
  if(!t) return;
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1400);
}

function num(v){
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
}

function getRate(){
  const rateInput = document.querySelector('[name="rate"]');
  return rateInput ? num(rateInput.value) : 15;
}

function getNotes(){
  const notesInput = document.querySelector('[name="notes"]');
  return notesInput ? (notesInput.value || "").trim() : "";
}

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

/* -------------------- OCR helpers -------------------- */
function setPayrollStatus(msgHtml) {
  const status = $("payrollScanStatus");
  if (status) status.innerHTML = msgHtml || "";
}

function fileToImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function preprocessDataUrlForOCR(photoDataUrl) {
  const img = await fileToImageFromDataUrl(photoDataUrl);

  const maxW = 1600;
  const scale = Math.min(1, maxW / img.width);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);

  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  const contrast = 1.25;
  const intercept = 128 * (1 - contrast);

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    let y = 0.299 * r + 0.587 * g + 0.114 * b;
    y = y * contrast + intercept;
    y = Math.max(0, Math.min(255, y));
    d[i] = d[i + 1] = d[i + 2] = y;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

function extractSuggestionsFromText(text) {
  const t = String(text || "");
  const roMatch = t.match(/\b(\d{5,8})\b/);
  const ref = roMatch ? roMatch[1] : "";
  const vinMatch = t.match(/\b([A-HJ-NPR-Z0-9]{8})\b/);
  const vin8 = vinMatch ? vinMatch[1] : "";
  const hoursMatches = t.match(/\b\d{1,2}\.\d\b/g) || [];
  const hours = hoursMatches
    .map(x => Number(x))
    .filter(n => n > 0 && n < 20)
    .sort((a, b) => b - a)[0];
  return { ref, vin8, hours: Number.isFinite(hours) ? String(hours) : "" };
}

function renderSuggestionButtons(s) {
  const parts = [];
  const refVal = s.ref;
  if (refVal) parts.push(`<button type="button" class="btn" id="useSugRO">Use Ref ${refVal}</button>`);
  if (s.vin8) parts.push(`<button type="button" class="btn" id="useSugVIN">Use VIN ${s.vin8}</button>`);
  if (s.hours) parts.push(`<button type="button" class="btn" id="useSugHRS">Use Hours ${s.hours}</button>`);
  if (!parts.length) return `<div class="muted">No clear Ref/VIN/Hours found. Use the text box below.</div>`;
  return `<div class="row" style="gap:10px; flex-wrap:wrap">${parts.join("")}</div>`;
}

function wireSuggestionButtons(s) {
  const refEl = $("ref");
  const vinEl = $("vin8");
  const hrsEl = $("hours");

  const bRO = $("useSugRO");
  if (bRO && refEl) bRO.onclick = () => { refEl.value = s.ref; refEl.dispatchEvent(new Event("input")); };

  const bVIN = $("useSugVIN");
  if (bVIN && vinEl) bVIN.onclick = () => { vinEl.value = s.vin8; vinEl.dispatchEvent(new Event("input")); };

  const bHRS = $("useSugHRS");
  if (bHRS && hrsEl) bHRS.onclick = () => { hrsEl.value = s.hours; hrsEl.dispatchEvent(new Event("input")); };
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
  const header = ["createdAt","dayKey","refType","ref","vin8","type","hours","rate","earnings","notes","hasPhoto"];
  const escape = (v) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const rows = entries.map(e => ([
    e.createdAt,
    e.dayKey,
    e.refType || "RO",
    e.ref || e.ro,
    e.vin8,
    e.type,
    e.hours,
    e.rate,
    e.earnings,
    e.notes,
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
    const refLabel = e.refType === "STOCK" ? "STK" : "RO";
    const refVal = escapeHtml(e.ref || e.ro || "-");
    const refDisplay = `${refLabel}: ${refVal}`;
    const viewPhotoBtn = e.photoDataUrl
      ? `<button class="btn" data-action="view-photo" data-id="${e.id}">View Photo</button>`
      : "";
    div.innerHTML = `
      <div class="itemTop">
        <div>
          <div><span class="mono">${refDisplay}</span> <span class="muted">(${escapeHtml(e.type)})</span></div>
          <div class="small">VIN8: <span class="mono">${escapeHtml(e.vin8 || "-")}</span> • ${ts}</div>
          ${e.notes ? `<div style="margin-top:6px;">${escapeHtml(e.notes)}</div>` : ""}
          ${viewPhotoBtn ? `<div style="margin-top:8px;">${viewPhotoBtn}</div>` : ""}
        </div>
        <div class="right">
          <div class="mono">${String(e.hours)} hrs @ ${formatMoney(e.rate)}</div>
          <div style="margin-top:6px;font-size:18px;">${formatMoney(e.earnings)}</div>
        </div>
      </div>
    `;
    list.appendChild(div);

    if (e.photoDataUrl) {
      const btn = div.querySelector('button[data-action="view-photo"]');
      if (btn) btn.addEventListener("click", () => openPhotoModal(e));
    }
  }
}

function openPhotoModal(entry){
  const shell = document.getElementById("photoModal");
  const img = document.getElementById("photoImg");
  const meta = document.getElementById("photoMeta");
  if (!shell || !img) return;

  img.src = entry.photoDataUrl;

  const when = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "";
  const refLabel = entry.refType === "STOCK" ? "STK" : "RO";
  const refVal = entry.ref || entry.ro || "";
  if (meta) meta.textContent = `${refLabel}: ${refVal} • ${entry.typeText || entry.type || ""} • ${entry.hours ?? ""} hrs • ${when}`;

  shell.style.display = "block";
  document.body.classList.add("modal-open");
}

function closePhotoModal(){
  const shell = document.getElementById("photoModal");
  const img = document.getElementById("photoImg");
  if (img) img.src = "";
  if (shell) shell.style.display = "none";
  document.body.classList.remove("modal-open");
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
}

// ===== More modal: iOS-safe open/close + tab init =====
let _moreScrollY = 0;

function lockBodyScrollForMore() {
  _moreScrollY = window.scrollY || 0;
  document.body.classList.add("modal-open");
  document.body.style.position = "fixed";
  document.body.style.top = `-${_moreScrollY}px`;
  document.body.style.left = "0";
  document.body.style.right = "0";
}

function unlockBodyScrollForMore() {
  document.body.classList.remove("modal-open");
  document.body.style.position = "";
  const top = document.body.style.top;
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  const y = _moreScrollY || 0;
  _moreScrollY = 0;
  window.scrollTo(0, y);
}

function initMoreTabs() {
  const root = document.getElementById("moreModal");
  if (!root) return;

  const tabBtns = Array.from(root.querySelectorAll(".tabBtn"));
  const panels  = Array.from(root.querySelectorAll(".tabPanel"));
  if (!tabBtns.length || !panels.length) return;

  function activate(id) {
    panels.forEach(p => p.classList.toggle("active", p.id === id));
    tabBtns.forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  }

  // prevent double-binding if init runs more than once
  tabBtns.forEach(btn => {
    btn.onclick = () => activate(btn.dataset.tab);
  });

  activate("payrollTab");
}

function openMore() {
  const modal = document.getElementById("moreModal");
  if (!modal) return;
  modal.classList.add("open");
  lockBodyScrollForMore();

  // Make sure the modal scroll container starts at top
  const body = modal.querySelector(".modalBody");
  if (body) body.scrollTop = 0;
}

function closeMore() {
  const modal = document.getElementById("moreModal");
  if (!modal) return;
  modal.classList.remove("open");
  unlockBodyScrollForMore();
}

/* -------------------- Boot -------------------- */
document.addEventListener("DOMContentLoaded", () => {
  initMoreTabs();
  document.getElementById("moreBtn")?.addEventListener("click", openMore);
  document.getElementById("closeMoreBtn")?.addEventListener("click", closeMore);

  document.getElementById("moreModal")?.addEventListener("click", (e) => {
    if (e.target && e.target.id === "moreModal") closeMore();
  });

  (async () => {
    registerSW();

    await ensureDefaultTypes();
    await renderTypeDatalist();
    await renderTypesListInMore();

    // wiring
    const refreshBtn = $("refreshBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", refreshUI);
    const filter = $("filterSelect");
    if (filter) filter.addEventListener("change", refreshUI);

    const hoursInput = $("hours");
    const rateInput  = document.querySelector('input[name="rate"]');
    if (hoursInput) hoursInput.addEventListener("input", () => hoursInput.dataset.touched = "1");
    if (rateInput)  rateInput.addEventListener("input", () => rateInput.dataset.touched = "1");

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
    const cam = $("payrollPhotoTake");
    const file = (cam && cam.files && cam.files[0]) ? cam.files[0] : (pick && pick.files && pick.files[0]) ? pick.files[0] : null;
    if (!file) return alert("Choose a payroll photo first.");
    const photoDataUrl = await fileToDataURL(file);
    await saveWeekPayroll({ photoDataUrl, ocrText: $("payrollOcrText") ? $("payrollOcrText").value : "" });
    await refreshPayrollUI();
    alert("Payroll photo saved for this week.");
  });

  const scanPayrollBtn = $("scanPayrollBtn");
  if (scanPayrollBtn) scanPayrollBtn.addEventListener("click", async () => {
    const ocrBox = $("payrollOcrText");
    const data = await getThisWeekPayroll();
    const photoDataUrl = data?.photoDataUrl;

    if (!photoDataUrl) {
      setPayrollStatus(`<div class="muted">No photo saved yet. Add a payroll photo first.</div>`);
      return;
    }

    if (!(window.Tesseract && window.Tesseract.recognize)) {
      setPayrollStatus(`<div class="muted">OCR engine not loaded yet. Open the app once while online, then retry.</div>`);
      return;
    }

    try {
      setPayrollStatus(`<div class="muted">Preprocessing image…</div>`);
      const prepped = await preprocessDataUrlForOCR(photoDataUrl);

      setPayrollStatus(`<div class="muted">Scanning… (10–30s on iPhone)</div>`);
      const { data: ocrData } = await Tesseract.recognize(prepped, "eng");
      const text = (ocrData && ocrData.text) ? ocrData.text : "";

      if (ocrBox) ocrBox.value = text;
      await saveWeekPayroll({ photoDataUrl, ocrText: text });

      const sug = extractSuggestionsFromText(text);
      setPayrollStatus(`
        <div><strong>OCR complete.</strong> Tap to fill fields:</div>
        ${renderSuggestionButtons(sug)}
        <div class="muted" style="margin-top:8px;">If this looks wrong, retake with better lighting/glare control.</div>
      `);
      wireSuggestionButtons(sug);

    } catch (e) {
      setPayrollStatus(`<div class="muted">OCR couldn’t read this. Photo is saved. Retry with a clearer photo or enter values manually.</div>`);
    }
  });

  const exportWeekSummaryBtn = $("exportWeekTxtBtn");
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
      const refLabel = e.refType === "STOCK" ? "STK" : "RO";
      const refVal = e.ref || e.ro;
      lines.push(`${e.dayKey} ${new Date(e.createdAt).toLocaleTimeString()} | ${refLabel}: ${refVal} | ${e.type} | ${e.hours} hrs | $${e.earnings}`);
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
      const refLabel = e.refType === "STOCK" ? "STK" : "RO";
      const refVal = e.ref || e.ro || "";
      return `
        <tr>
          <td>${esc(e.dayKey)}</td>
          <td>${esc(t)}</td>
          <td>${esc(`${refLabel}: ${refVal}`)}</td>
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
          <th>Date</th><th>Time</th><th>Ref</th><th>VIN8</th><th>Type</th>
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

  const wipeAllBtn = $("wipeAllBtn");
  if (wipeAllBtn) wipeAllBtn.addEventListener("click", async () => {
    await wipeAllData();
    await ensureDefaultTypes();
    await renderTypeDatalist();
    await renderTypesListInMore();
    await refreshUI();
  });

  const wipeTypesBtn = $("wipeTypesBtn");
  if (wipeTypesBtn) wipeTypesBtn.addEventListener("click", async () => {
    const ok = confirm("Wipe all saved types?");
    if (!ok) return;
    await clearStore(STORES.types);
    await ensureDefaultTypes();
    await renderTypeDatalist();
    await renderTypesListInMore();
  });

  const exportTypesBtn = $("exportTypesBtn");
  if (exportTypesBtn) exportTypesBtn.addEventListener("click", async () => {
    const types = await getAll(STORES.types);
    downloadText("flat_rate_types.json", JSON.stringify(types, null, 2), "application/json");
  });

  const typeEl = $("typeText");
  if (typeEl) {
    typeEl.addEventListener("blur", async () => {
      await maybeSaveTypeNameOnly(typeEl.value);
      await maybeAutofillFromType(typeEl.value);
    });
    typeEl.addEventListener("change", async () => {
      if (hoursInput) hoursInput.dataset.touched = "";
      if (rateInput) rateInput.dataset.touched = "";
      await maybeAutofillFromType(typeEl.value);
    });
  }

  const form = $("logForm");
  const saveBtnFooter = $("saveBtn");
  const saveEntryBtn = $("saveEntryBtn");
  const formSubmitBtn = form ? form.querySelector('button[type="submit"]') : null;

  let refType = "RO";
  const setRefType = (next) => {
    refType = next === "STOCK" ? "STOCK" : "RO";
    const bRO = document.getElementById("refTypeRO");
    const bSTK = document.getElementById("refTypeSTK");
    if (bRO) bRO.classList.toggle("active", refType === "RO");
    if (bSTK) bSTK.classList.toggle("active", refType === "STOCK");
  };
  setRefType("RO");
  document.getElementById("refTypeRO")?.addEventListener("click", () => setRefType("RO"));
  document.getElementById("refTypeSTK")?.addEventListener("click", () => setRefType("STOCK"));

  const clearFastFields = (ev) => {
    if (ev) ev.preventDefault();
    const clearAll = ev && ev.target && ev.target.id === "clearFormBtn";
    if (clearAll) {
      if ($("ref")) $("ref").value = "";
      if ($("vin8")) $("vin8").value = "";
      setRefType("RO");
    }
    if (typeEl) typeEl.value = "";
    if (hoursInput) { hoursInput.value = ""; hoursInput.dataset.touched = ""; }
    const photoInput = $("proofPhoto");
    if (photoInput) photoInput.value = "";
    const notesInput = document.querySelector('[name="notes"]');
    if (notesInput) notesInput.value = "";
    setStatusMsg("Ready.");
    if (typeEl) typeEl.focus();
  };

  ["clearFormBtn","clearEntryBtn","clearBtn"].forEach((id) => {
    const btn = $(id);
    if (btn) btn.addEventListener("click", clearFastFields);
  });

  async function getEntryById(id){
    if (!id) return null;
    const { db, store } = await tx(STORES.entries, "readonly");
    const item = await new Promise((resolve, reject) => {
      const r = store.get(id);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return item;
  }

  const entryList = $("entryList");
  if (entryList) {
    entryList.addEventListener("click", async (e) => {
      const btn = e.target?.closest?.("button[data-action='view-photo']");
      if (!btn) return;
      const id = btn.getAttribute("data-id");
      const entry = await getEntryById(id);
      if (!entry?.photoDataUrl) {
        toast("No photo saved");
        return;
      }
      openPhotoModal(entry);
    });
  }

  document.getElementById("closePhotoBtn")?.addEventListener("click", closePhotoModal);
  document.getElementById("photoModal")?.addEventListener("click", (e) => {
    if (e.target && e.target.id === "photoModal") closePhotoModal();
  });

  const handleSave = async (ev) => {
    if (ev) ev.preventDefault();
    const disableSaves = (state) => {
      if (saveBtnFooter) saveBtnFooter.disabled = state;
      if (formSubmitBtn) formSubmitBtn.disabled = state;
      if (saveEntryBtn) saveEntryBtn.disabled = state;
    };

    const ref = (document.getElementById("ref")?.value || "").trim().toUpperCase();
    const vin8 = ($("vin8")?.value || "").trim().toUpperCase().slice(0,8);
    const type = (typeEl?.value || "").trim();
    const hours = num(hoursInput?.value);
    const rate = getRate();
    const notes = getNotes();

    if (!ref) { toast("RO/Stock required"); setStatusMsg("RO/Stock required"); return; }
    if (!type) { toast("Type required"); setStatusMsg("Type required"); return; }
    if (!(hours > 0)) { toast("Hours must be > 0"); setStatusMsg("Hours must be > 0"); return; }
    if (!(rate > 0)) { toast("Rate must be > 0"); setStatusMsg("Rate must be > 0"); return; }

    disableSaves(true);
    setStatusMsg("Saving...");

    try {
      const id = uuid();
      const createdAt = nowISO();
      const dayKey = todayKeyLocal();
      const weekStartKey = dateKey(startOfWeekLocal(new Date()));
      const typeText = type;
      const photoInput = $("proofPhoto");
      const photoFile = photoInput?.files?.[0];
      const photoDataUrl = photoFile ? await fileToDataURL(photoFile) : null;

      const earnings = Number((hours * rate).toFixed(2));

      await put(STORES.entries, {
        id,
        createdAt,
        dayKey,
        weekStartKey,
        refType,
        ref,
        ro: ref,
        vin8,
        typeText,
        type,
        hours,
        rate,
        earnings,
        notes,
        photoDataUrl
      });

      await upsertTypeDefaults(type, hours, rate);

      setStatusMsg("Saved.");
      toast("Saved ✅");

      if (typeEl) typeEl.value = "";
      if (hoursInput) { hoursInput.value = ""; hoursInput.dataset.touched = ""; }
      const notesInput = document.querySelector('[name="notes"]');
      if (notesInput) notesInput.value = "";
      const photoInputAfter = $("proofPhoto");
      if (photoInputAfter) photoInputAfter.value = "";
      if (typeEl) typeEl.focus();

      await refreshUI();
    } catch (e) {
      console.error(e);
      setStatusMsg("Save failed.");
      toast("Save failed");
    } finally {
      disableSaves(false);
    }
  };

  if (form) form.addEventListener("submit", handleSave);
  if (saveEntryBtn) saveEntryBtn.addEventListener("click", handleSave);
  if (saveBtnFooter) saveBtnFooter.addEventListener("click", handleSave);

  await refreshUI();
});
