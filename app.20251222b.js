const DB_NAME = "frlog";
const DB_VERSION = 6; // bump this

const STORES = {
  entries: "entries",
  types: "types_v2",      // <-- change from "types"
  weekflags: "weekflags",
  payroll: "payroll"
};

const $ = (id) => document.getElementById(id);
const EMP_KEY = "frlog_emp";
let ACTIVE_EMP = (typeof localStorage !== "undefined" ? localStorage.getItem(EMP_KEY) : "") || "";

console.log("BUILD", "delta-fix-20251222b", new Date().toISOString());

let rangeMode = "day";

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
function round1(n){
  return Math.round((Number(n) || 0) * 10) / 10;
}
function round2(n){
  return Math.round((Number(n) || 0) * 100) / 100;
}
function formatHours(n){
  const x = round1(n);
  return (x % 1 === 0) ? String(x.toFixed(0)) : String(x.toFixed(1));
}
function formatDayLabel(dayKey){
  if (!dayKey) return "";
  const [y, m, d] = String(dayKey).split("-").map(Number);
  if (!y || !m || !d) return "";
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function getEmpId(){
  const inp = $("empId");
  const val = inp ? (inp.value || "").trim() : "";
  return val || ACTIVE_EMP || "";
}
function setActiveEmp(empId){
  ACTIVE_EMP = (empId || "").trim();
  try { localStorage.setItem(EMP_KEY, ACTIVE_EMP); } catch {}
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

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const upgradeTxn = e.target.transaction;

      if (!db.objectStoreNames.contains(STORES.entries)) {
        const os = db.createObjectStore(STORES.entries, { keyPath: "id" });
        os.createIndex("createdAt", "createdAt", { unique: false });
        os.createIndex("dayKey", "dayKey", { unique: false });
        os.createIndex("ro", "ro", { unique: false });
        os.createIndex("type", "type", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.types)) {
        const os = db.createObjectStore(STORES.types, { keyPath: "id" });
        os.createIndex("empId", "empId", { unique: false });
        os.createIndex("empId_nameLower", ["empId", "nameLower"], { unique: true });
      }

      // Migrate legacy types store -> types_v2 (leave old store; it becomes unused)
      if (
        upgradeTxn &&
        db.objectStoreNames.contains("types") &&
        STORES.types !== "types"
      ) {
        try {
          const oldStore = upgradeTxn.objectStore("types");
          const newStore = upgradeTxn.objectStore(STORES.types);
          const migrate = oldStore.getAll();
          migrate.onsuccess = () => {
            const items = (migrate.result || []).map((item) => ({
              ...item,
              empId: String(item.empId || "").trim(),
              nameLower: String(item.name || "").trim().toLowerCase()
            }));
            items.forEach((item) => {
              try { newStore.put(item); }
              catch (err) { console.warn("types_v2 migrate skip", err); }
            });
          };
        } catch (err) {
          console.error("types migration failed", err);
        }
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

async function tx(storeName, mode = "readonly") {
  const db = await openDB();
  const t = db.transaction(storeName, mode);
  const store = t.objectStore(storeName);

  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Transaction aborted"));
  });

  return { db, t, store, done };
}

async function getAll(storeName) {
  const { db, store, done } = await tx(storeName, "readonly");
  try {
    const items = await new Promise((resolve, reject) => {
      const r = store.getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
    await done; // wait for txn
    return items;
  } finally {
    db.close();
  }
}

async function get(storeName, key) {
  const { db, store, done } = await tx(storeName, "readonly");
  try {
    const item = await new Promise((resolve, reject) => {
      const r = store.get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
    await done; // wait for txn
    return item;
  } finally {
    db.close();
  }
}

async function put(storeName, item) {
  const { db, store, done } = await tx(storeName, "readwrite");
  try {
    await new Promise((resolve, reject) => {
      const r = store.put(item);
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(r.error);
    });
    await done; // IMPORTANT: wait for commit
  } finally {
    db.close();
  }
}

async function del(storeName, key) {
  const { db, store, done } = await tx(storeName, "readwrite");
  try {
    await new Promise((resolve, reject) => {
      const r = store.delete(key);
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(r.error);
    });
    await done;
  } finally {
    db.close();
  }
}

async function clearStore(storeName) {
  const { db, store, done } = await tx(storeName, "readwrite");
  try {
    await new Promise((resolve, reject) => {
      const r = store.clear();
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(r.error);
    });
    await done;
  } finally {
    db.close();
  }
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

function matchesSearch(e, q){
  if (!q) return true;
  const hay = [
    e.ref || e.ro || "",
    e.vin8 || "",
    e.type || e.typeText || "",
    e.notes || ""
  ].join(" ").toLowerCase();
  return hay.includes(q);
}

function weekdayLabel(i){
  // i: 0..6 where 0 = Monday
  return ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][i] || "";
}

function computeWeekBreakdown(entries, weekStart){
  const days = [];
  for (let i = 0; i < 7; i++){
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    const key = dateKey(d);
    const dayEntries = entries.filter(e => e.dayKey === key);
    const totals = computeTotals(dayEntries);
    days.push({ i, key, totals, count: totals.count });
  }
  return days;
}

function renderWeekBreakdown(days){
  const card = document.getElementById("weekBreakdownCard");
  const list = document.getElementById("weekBreakdownList");
  if (!card || !list) return;

  if (!days || !days.length){
    card.style.display = "none";
    return;
  }

  card.style.display = "block";

  const picked = window.__WEEK_DAY_PICK__ || ""; // dayKey or ""
  list.innerHTML = days.map(d => {
    const active = picked === d.key;
    return `
      <div class="item" data-daykey="${d.key}" style="${active ? "outline:2px solid rgba(47,125,255,.7);" : ""}">
        <div class="itemTop">
          <div>
            <div class="mono">${weekdayLabel(d.i)} • ${d.key}</div>
            <div class="small muted">${d.count} entries</div>
          </div>
          <div class="right">
            <div class="mono">${d.totals.hours.toFixed(1)} hrs</div>
            <div style="margin-top:6px;">${formatMoney(d.totals.dollars)}</div>
          </div>
        </div>
      </div>
    `;
  }).join("");

  // Tap to filter list by that day; tap again to clear
  list.querySelectorAll(".item[data-daykey]").forEach(el => {
    el.addEventListener("click", () => {
      const dk = el.getAttribute("data-daykey") || "";
      window.__WEEK_DAY_PICK__ = (window.__WEEK_DAY_PICK__ === dk) ? "" : dk;
      refreshUI();
    });
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
function startOfMonthLocal(d=new Date()){
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonthLocal(d=new Date()){
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
function inMonth(dayKeyStr, monthStart){
  const [yy,mm,dd] = String(dayKeyStr || "").split("-").map(Number);
  if (!yy || !mm || !dd) return false;
  const s = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1);
  const e = endOfMonthLocal(monthStart);
  const v = new Date(yy, mm - 1, dd);
  return v >= s && v <= e;
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

function filterEntriesByEmp(entries, empId){
  const id = String(empId ?? ACTIVE_EMP ?? "").trim();
  if (!id) return [];
  return entries.filter(e => String(e.empId || "").trim() === id);
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

function toCSV(entries){
  const header = ["empId","createdAt","dayKey","refType","ref","vin8","type","hours","rate","earnings","notes","hasPhoto"];
  const escape = (v) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const rows = entries.map(e => ([
    e.empId || "",
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

function renderList(entries, mode){
  const list = $("entryList");
  if (!list) return;
  list.innerHTML = "";

  const dayKey = todayKeyLocal();
  const byRange = (mode === "today") ? entries.filter(e => e.dayKey === dayKey) : entries;

  const pickedDay = (mode === "week") ? (window.__WEEK_DAY_PICK__ || "") : "";
  const ranged = pickedDay ? byRange.filter(e => e.dayKey === pickedDay) : byRange;

  const q = (document.getElementById("searchBox")?.value || "").trim().toLowerCase();
  const visible = ranged.filter(e => matchesSearch(e, q));
  const capped = visible.slice(0, 60);

  if (capped.length === 0) {
    const msg = q ? `No entries match "${escapeHtml(q)}".` : "No entries match your search.";
    list.innerHTML = `<div class="muted">${msg}</div>`;
    return;
  }

  const buildEntry = (e) => {
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
    if (e.photoDataUrl) {
      const btn = div.querySelector('button[data-action="view-photo"]');
      if (btn) btn.addEventListener("click", () => openPhotoModal(e));
    }
    return div;
  };

  const isWeekRange = (window.__RANGE_MODE__ || rangeMode) === "week";
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

  const empId = getEmpId();
  const allEntries = await getAll(STORES.entries);
  const entries = filterEntriesByEmp(allEntries, empId);
  entries.sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  window.__RANGE_ENTRIES__ = entries;

  const mode = window.__RANGE_MODE__ || rangeMode || "day";
  rangeMode = mode;

  let filtered = filterByMode(entries, mode);

  if (mode === "week") {
    // optional day filter inside week
    const pick = window.__WEEK_DAY_PICK__ || "";
    if (pick) filtered = filtered.filter(e => e.dayKey === pick);

    // render week breakdown (always uses full week, not the picked day)
    const ws0 = startOfWeekLocal(new Date());
    const days = computeWeekBreakdown(entries.filter(e => inWeek(e.dayKey, ws0)), ws0);
    renderWeekBreakdown(days);
  } else {
    // hide week breakdown when not in week mode
    const card = document.getElementById("weekBreakdownCard");
    if (card) card.style.display = "none";
    window.__WEEK_DAY_PICK__ = ""; // reset when leaving week mode
  }

  window.__RANGE_FILTERED__ = filtered;
  const totals = computeTotals(filtered);

  const r1 = (n) => (Math.round(Number(n || 0) * 10) / 10).toFixed(1);

  const title =
    mode === "day" ? "Today" :
    mode === "week" ? "This Week" :
    mode === "month" ? "This Month" : "All Time";

  setText("rangeTitle", title);
  setText("rangeHours", r1(totals.hours));
  setText("rangeDollars", formatMoney(totals.dollars));
  setText("rangeCount", String(totals.count));
  setText("rangeAvgHrs", r1(totals.avgHrs));
  setText("rangeSub", rangeSubLabel(mode));

  // Today
  const dayKey = todayKeyLocal();
  const today = computeToday(entries, dayKey);
  setText("todayHours", round1(today.hours));
  setText("todayDollars", formatMoney(today.dollars));
  setText("todayCount", String(today.count));

  // Week
  const ws = startOfWeekLocal(new Date());
  const we = endOfWeekLocal(new Date());
  const week = computeWeek(entries, ws);

  setText("weekHours", round1(week.hours));
  setText("weekDollars", formatMoney(week.dollars));
  setText("weekRange", `${dateKey(ws)} → ${dateKey(we)}`);

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
  renderList(filtered, listMode);

  if (mode === "week") {
    renderWeekBreakdown(computeWeekBreakdown(filtered, ws));
  } else {
    renderWeekBreakdown([]);
    window.__WEEK_DAY_PICK__ = "";
  }

  // stash last week calc for export (delta always set)
  window.__WEEK_STATE__ = { ws, we, week, flagged, delta };
}

async function registerSW() {
  if (!("serviceWorker" in navigator)) return;

  try {
    const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    // check for updates every time the app opens
    reg.update();

    // if a new SW takes control, reload once to use fresh assets
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });

    console.log("SW registered:", reg.scope);
  } catch (e) {
    console.error("SW register failed:", e);
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

function entryRefLabel(e){
  const ref = e.ref || e.ro || e.stock || e.roStock || "";
  const kind = e.refType || e.refKind || "";
  return kind ? `${kind} ${ref}` : `${ref}`;
}

function entryPhotoUrl(e){
  return e.photoDataUrl || e.proofPhotoDataUrl || e.photo || null;
}

function formatWhen(iso){
  try { return new Date(iso).toLocaleString(); } catch { return iso || ""; }
}

function renderPhotoGallery(entries){
  const el = document.getElementById("photoGallery");
  if (!el) return;

  const withPhotos = (entries || [])
    .filter(e => e && (e.photoDataUrl || e.proofPhotoDataUrl || e.photo))
    .sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  if (!withPhotos.length) {
    el.innerHTML = `<div class="muted">No saved entry photos yet.</div>`;
    return;
  }

  el.innerHTML = withPhotos.slice(0, 60).map(e => {
    const title = `${(e.refType || "RO")} ${(e.ro || "").toString().toUpperCase()} • ${(e.typeText || "").toString()}`;
    const photoUrl = entryPhotoUrl(e);
    return `
      <img
        class="thumb"
        src="${photoUrl}"
        alt="${title.replace(/"/g,'')}"
        title="${title.replace(/"/g,'')}"
        data-full="${photoUrl}"
      />
    `;
  }).join("");

  el.querySelectorAll("img[data-full]").forEach(img => {
    img.addEventListener("click", () => {
      const w = window.open();
      if (w) w.document.write(`<img src="${img.dataset.full}" style="max-width:100%;height:auto" />`);
    });
  });
}

async function renderPhotoGrid(){
  const entries = filterEntriesByEmp(await getAll(STORES.entries), getEmpId());
  renderPhotoGallery(entries);
}

async function exportAllCsvAdmin() {
  if (!(await requireAdmin())) return alert("Denied.");

  const entries = await getAll(STORES.entries);
  entries.sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  downloadText(`flat_rate_log_ALL_${todayKeyLocal()}.csv`, toCSV(entries), "text/csv");
}

function openPhotoViewer(e){
  const shell = document.getElementById("photoViewer");
  const img = document.getElementById("photoFull");
  const meta = document.getElementById("photoMeta");
  const dl = document.getElementById("downloadPhotoBtn");
  const copyBtn = document.getElementById("copyPhotoBtn");

  if (!shell || !img || !meta || !dl) return;

  const url = entryPhotoUrl(e);
  img.src = url;

  const label = entryRefLabel(e);
  const when = formatWhen(e.createdAt || e.ts || e.when);
  const type = e.typeText || e.type || "";
  meta.textContent = `${label} • ${type} • ${when}`;

  dl.href = url;

  copyBtn?.addEventListener("click", async () => {
    try{
      const blob = await (await fetch(url)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      toast("Copied.");
    } catch {
      toast("Copy failed.");
    }
  }, { once:true });

  shell.style.display = "block";
  shell.classList.add("open");
}

function closePhotoViewer(){
  const shell = document.getElementById("photoViewer");
  if (!shell) return;
  shell.classList.remove("open");
  shell.style.display = "none";
}

function initPhotosUI(){
  document.getElementById("closePhotoViewerBtn")?.addEventListener("click", closePhotoViewer);
  document.getElementById("photoViewer")?.addEventListener("click", (e) => {
    if (e.target?.id === "photoViewer") closePhotoViewer();
  });

  renderPhotoGrid();
}

/* -------------------- Boot -------------------- */
document.addEventListener("DOMContentLoaded", () => {
  initMoreTabs();
  document.getElementById("moreBtn")?.addEventListener("click", openMore);
  document.getElementById("closeMoreBtn")?.addEventListener("click", closeMore);

  document.getElementById("moreModal")?.addEventListener("click", (e) => {
    if (e.target && e.target.id === "moreModal") closeMore();
  });

  // EVERYTHING async stays inside this IIFE
  (async () => {
    registerSW();

    await ensureDefaultTypes();
    await renderTypeDatalist();
    await renderTypesListInMore();

    // wiring
    $("refreshBtn")?.addEventListener("click", refreshUI);
    $("filterSelect")?.addEventListener("change", refreshUI);
    $("searchBox")?.addEventListener("input", refreshUI);

    const empInput = document.getElementById("empId");
    if (empInput) {
      empInput.value = ACTIVE_EMP;
      empInput.addEventListener("input", async () => {
        setActiveEmp(empInput.value.trim());
        await ensureDefaultTypes();
        await renderTypeDatalist();
        await renderTypesListInMore();
        refreshUI();
      });
    }

    window.__RANGE_MODE__ = window.__RANGE_MODE__ || "day";

    const setRangeMode = (m) => {
      rangeMode = m;
      window.__RANGE_MODE__ = m;
      document.getElementById("rangeDayBtn")?.classList.toggle("active", m === "day");
      document.getElementById("rangeWeekBtn")?.classList.toggle("active", m === "week");
      document.getElementById("rangeMonthBtn")?.classList.toggle("active", m === "month");
      document.getElementById("rangeAllBtn")?.classList.toggle("active", m === "all");
      refreshUI();
    };

    document.getElementById("rangeDayBtn")?.addEventListener("click", () => setRangeMode("day"));
    document.getElementById("rangeWeekBtn")?.addEventListener("click", () => setRangeMode("week"));
    document.getElementById("rangeMonthBtn")?.addEventListener("click", () => setRangeMode("month"));
    document.getElementById("rangeAllBtn")?.addEventListener("click", () => setRangeMode("all"));
    setRangeMode(window.__RANGE_MODE__);

    const hoursInput = $("hours");
    const rateInput  = document.querySelector('input[name="rate"]');
    if (hoursInput) {
      hoursInput.addEventListener("input", () => hoursInput.dataset.touched = "1");
      hoursInput.addEventListener("blur", () => {
        const v = round1(num(hoursInput.value));
        if (Number.isFinite(v) && v > 0) {
          hoursInput.value = String(v);
        } else if (hoursInput.value) {
          hoursInput.value = "";
        }
      });
    }
    if (rateInput)  rateInput.addEventListener("input", () => rateInput.dataset.touched = "1");

    // exports + wipes live on More page
    $("exportCsvBtn")?.addEventListener("click", async () => {
      const entries = filterEntriesByEmp(await getAll(STORES.entries), getEmpId());
      entries.sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      downloadText(`flat_rate_log_${todayKeyLocal()}.csv`, toCSV(entries), "text/csv");
    });

    $("exportJsonBtn")?.addEventListener("click", async () => {
      const entries = filterEntriesByEmp(await getAll(STORES.entries), getEmpId());
      entries.sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      downloadText(`flat_rate_log_${todayKeyLocal()}.json`, JSON.stringify(entries, null, 2), "application/json");
    });

    $("wipeBtn")?.addEventListener("click", async () => {
      await wipeAllData();
      await ensureDefaultTypes();
      await renderTypeDatalist();
      await renderTypesListInMore();
      await refreshUI();
    });

    // flagged hours
    const saveFlaggedBtn = $("saveFlaggedBtn");
    if (saveFlaggedBtn) saveFlaggedBtn.addEventListener("click", async () => {
      const fh = $("flaggedHours");
      const val = fh ? Number(fh.value || 0) : 0;
      if (!Number.isFinite(val) || val < 0) return alert("Flagged hours must be a number >= 0.");
      await setThisWeekFlag(val);
      await refreshUI();
      alert("Flagged hours saved for this week.");
    });

    // payroll photo save
    const savePayrollPhotoBtn = $("savePayrollPhotoBtn");
    if (savePayrollPhotoBtn) {
      savePayrollPhotoBtn.addEventListener("click", async () => {
        const pick = $("payrollPhotoPick");
        const cam = $("payrollPhotoTake");
        const file =
          (cam && cam.files && cam.files[0]) ? cam.files[0] :
          (pick && pick.files && pick.files[0]) ? pick.files[0] : null;

        if (!file) return alert("Choose a payroll photo first.");
        const photoDataUrl = await fileToDataURL(file);
        await saveWeekPayroll({ photoDataUrl, ocrText: $("payrollOcrText") ? $("payrollOcrText").value : "" });
        await refreshPayrollUI();
        alert("Payroll photo saved for this week.");
      });
    }

    // photo gallery
    initPhotosUI();

    // ---------------- SAVE + CLEAR (single source of truth) ----------------
    let refType = "RO";
    const setRefType = (next) => {
      refType = next === "STOCK" ? "STOCK" : "RO";
      document.getElementById("refTypeRO")?.classList.toggle("active", refType === "RO");
      document.getElementById("refTypeSTK")?.classList.toggle("active", refType === "STOCK");
    };
    setRefType("RO");
    document.getElementById("refTypeRO")?.addEventListener("click", () => setRefType("RO"));
    document.getElementById("refTypeSTK")?.addEventListener("click", () => setRefType("STOCK"));

    const form = document.getElementById("logForm");
    const saveBtn = document.getElementById("saveBtn");        // Save Entry button id must be saveBtn
    const clearBtn = document.getElementById("clearBtn");      // Clear button id must be clearBtn

    function handleClear(ev) {
      if (ev) ev.preventDefault();
      document.getElementById("ref") && (document.getElementById("ref").value = "");
      document.getElementById("vin8") && (document.getElementById("vin8").value = "");
      document.getElementById("typeText") && (document.getElementById("typeText").value = "");
      document.getElementById("hours") && (document.getElementById("hours").value = "");
      const rateEl = document.querySelector('input[name="rate"]');
      if (rateEl) rateEl.value = "15";
      const notesEl = document.querySelector('textarea[name="notes"], input[name="notes"]');
      if (notesEl) notesEl.value = "";
      const photoEl = document.getElementById("proofPhoto");
      if (photoEl) photoEl.value = "";
      setStatusMsg("Cleared.");
    }

    async function handleSave(ev) {
      if (ev) ev.preventDefault();

      const disable = (on) => {
        if (saveBtn) saveBtn.disabled = on;
        const submitBtn = form?.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = on;
      };

      const empId = getEmpId();
      if (!empId) {
        toast("Employee # required");
        setStatusMsg("Employee # required");
        return;
      }
      setActiveEmp(empId);

      const ref = (document.getElementById("ref")?.value || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");
      const vin8 = (document.getElementById("vin8")?.value || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-HJ-NPR-Z0-9]/g, "")
        .slice(0, 8);
      const type = (document.getElementById("typeText")?.value || "").trim();
      const hours = round1(num(hoursInput?.value));
      const rate = getRate();
      const notes = getNotes();

      if (!ref)  { toast("RO/Stock required"); setStatusMsg("RO/Stock required"); return; }
      if (!/^[A-Z0-9-]{3,20}$/.test(ref)) {
        toast("Ref must be letters/numbers");
        setStatusMsg("Invalid RO/Stock #");
        return;
      }
      if (!type) { toast("Type required");     setStatusMsg("Type required");     return; }
      if (!Number.isFinite(hours) || hours <= 0) { toast("Hours must be greater than 0"); setStatusMsg("Invalid hours"); return; }
      if (!(rate > 0))  { toast("Rate must be > 0");  setStatusMsg("Rate must be > 0");  return; }

      disable(true);
      setStatusMsg("Saving...");

      try {
        const id = uuid();
        const createdAt = nowISO();
        const dayKey = todayKeyLocal();
        const weekStartKey = dateKey(startOfWeekLocal(new Date()));

        const photoEl = document.getElementById("proofPhoto");
        const photoFile = photoEl?.files?.[0] || null;
        const photoDataUrl = photoFile ? await fileToDataURL(photoFile) : null;

        const earnings = Number((hours * rate).toFixed(2));

        await put(STORES.entries, {
          id,
          createdAt,
          dayKey,
          weekStartKey,
          empId,
          refType,
          ref,
          ro: ref,
          vin8,
          typeText: type,
          type,
          hours,
          rate,
          earnings,
          notes,
          photoDataUrl
        });

        await upsertTypeDefaults(type, hours, rate);

        toast("Saved ✅");
        setStatusMsg("Saved.");

        await refreshUI();
        handleClear();
      } catch (e) {
        console.error(e);
        toast("Save failed");
        setStatusMsg("Save failed");
        alert("SAVE ERROR: " + (e?.message || e));
      } finally {
        disable(false);
      }
    }

    if (form) form.addEventListener("submit", handleSave);
    if (saveBtn) saveBtn.addEventListener("click", handleSave);
    if (clearBtn) clearBtn.addEventListener("click", handleClear);

    await refreshUI();
  })();
});
