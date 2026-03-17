// ---- Page detect (GLOBAL) ----
const PAGE = location.pathname.includes("more") ? "more" : "main";
window.__PAGE__ = PAGE;
console.log("PAGE MODE:", PAGE);
const IS_MAIN = PAGE === "main";
const IS_MORE = PAGE === "more";

let rangeMode = "day";
let currentRefType = "RO";
let summaryRange = (window.__WEEK_WHICH__ === "last" || window.__WEEK_WHICH__ === "lastWeek") ? "lastWeek" : "thisWeek"; // "thisWeek" | "lastWeek"

function setSummaryRange(next) {
  summaryRange = (next === "lastWeek") ? "lastWeek" : "thisWeek";
  window.__WEEK_WHICH__ = summaryRange;
  if (PAGE === "main") refreshUI(CURRENT_ENTRIES);
}

function setRefType(t) {
  currentRefType = t === "STOCK" ? "STOCK" : "RO";
  const ro = document.getElementById("refTypeRO");
  const stk = document.getElementById("refTypeSTK");
  ro?.classList.toggle("active", currentRefType === "RO");
  stk?.classList.toggle("active", currentRefType === "STOCK");
}

function setStatusMsg(msg){
  const s = $("statusMsg");
  if (s) s.textContent = msg;
}

function setDataWarning(msg) {
  const el = document.getElementById("dataWarning");
  if (!el) return;
  el.textContent = msg || "";
  el.style.display = msg ? "block" : "none";
}

function toast(msg){
  const t = document.getElementById("toast");
  if(!t) return;
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1400);
}

let UNDO_STATE = null; // { onUndo, timer }

function showUndoBar({ text, onUndo, ttlMs = 8000 }) {
  const bar = document.getElementById("undoBar");
  const txt = document.getElementById("undoText");
  const btn = document.getElementById("undoBtn");
  const dismiss = document.getElementById("undoDismissBtn");
  if (!bar || !txt || !btn || !dismiss) return;

  if (UNDO_STATE?.timer) clearTimeout(UNDO_STATE.timer);
  UNDO_STATE = { onUndo, timer: null };

  txt.textContent = text || "Deleted.";
  bar.style.display = "block";

  const hide = () => {
    bar.style.display = "none";
    if (UNDO_STATE?.timer) clearTimeout(UNDO_STATE.timer);
    UNDO_STATE = null;
  };

  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await onUndo?.();
      hide();
    } catch (e) {
      console.error("UNDO FAILED", e);
      alert("Undo failed: " + (e?.message || e));
    } finally {
      btn.disabled = false;
    }
  };

  dismiss.onclick = hide;

  UNDO_STATE.timer = setTimeout(hide, ttlMs);
}

function withTimeout(promise, ms = 4000, label = "timeout") {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms))
  ]);
}

function num(v){
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
}

function setRangeMode(m, opts = {}) {
  rangeMode = m;
  window.__RANGE_MODE__ = m;

  document.getElementById("rangeDayBtn")?.classList.toggle("active", m === "day");
  document.getElementById("rangeWeekBtn")?.classList.toggle("active", m === "week");
  document.getElementById("rangeMonthBtn")?.classList.toggle("active", m === "month");
  document.getElementById("rangeAllBtn")?.classList.toggle("active", m === "all");

  const row = document.getElementById("weekWhichRow");
  if (row) row.style.display = (m === "week") ? "inline-flex" : "none";

  if (PAGE === "main" && !opts.skipRefresh) refreshUI(CURRENT_ENTRIES);
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
function bootEmp() {
  const empId = getEmpId();
  const input = document.getElementById("empId");
  if (input && empId) input.value = empId;
}

function setActiveEmp(empId){
  setEmpId(empId);
}
function uuid(){
  return crypto.randomUUID ? crypto.randomUUID() : `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[c]));
}

const MEMORY_STORES = {
  [STORES.entries]: new Map(),
  [STORES.types]: new Map(),
  [STORES.weekflags]: new Map(),
  [STORES.payroll]: new Map(),
};

function cloneStoreValue(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function getStoreMap(storeName) {
  if (!MEMORY_STORES[storeName]) MEMORY_STORES[storeName] = new Map();
  return MEMORY_STORES[storeName];
}

function getWeekEnding(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";

  const day = d.getDay(); // 0=Sun
  const diff = 5 - day;   // Friday payroll assumption

  d.setDate(d.getDate() + diff);

  return d.toISOString().slice(0,10);
}

function normalizeEntries(entries) {
  return (entries || []).map((e) => {
    const parsed = e?.createdAt ? Date.parse(e.createdAt) : (e?.date ? Date.parse(e.date) : NaN);
    const createdAtMs = (typeof e?.createdAtMs === "number")
      ? e.createdAtMs
      : (Number.isFinite(parsed) ? parsed : Date.now());

    const dayKey = e?.dayKey || dayKeyFromISO(e?.createdAt || e?.date) || "";
    const entry = {
      ...e,
      createdAtMs,
      dayKey: dayKey || e?.dayKey || "",
    };

    entry.weekEnding = entry.dayKey ? getWeekEnding(entry.dayKey) : (entry.weekEnding || "");
    return entry;
  });
}

async function getAll(storeName) {
  if (storeName === STORES.entries) {
    return normalizeEntries(Array.isArray(CURRENT_ENTRIES) ? CURRENT_ENTRIES : []);
  }
  const items = Array.from(getStoreMap(storeName).values()).map(cloneStoreValue);
  return storeName === STORES.entries ? normalizeEntries(items) : items;
}

async function get(storeName, key) {
  return cloneStoreValue(getStoreMap(storeName).get(key) || null);
}

async function put(storeName, item) {
  if (storeName === STORES.entries) {
    const next = cloneStoreValue(item);
    const rows = Array.isArray(CURRENT_ENTRIES) ? [...CURRENT_ENTRIES] : [];
    const idx = rows.findIndex((r) => String(r?.id) === String(next?.id));
    if (idx >= 0) rows[idx] = next;
    else rows.push(next);
    CURRENT_ENTRIES = syncStateEntries(rows);
    return;
  }
  const map = getStoreMap(storeName);
  const key = item?.id ?? item?.weekStartKey ?? crypto.randomUUID?.() ?? String(Date.now());
  map.set(key, cloneStoreValue(item));
}

async function del(storeName, key) {
  if (storeName === STORES.entries) {
    CURRENT_ENTRIES = syncStateEntries(
      (Array.isArray(CURRENT_ENTRIES) ? CURRENT_ENTRIES : [])
        .filter((r) => String(r?.id) !== String(key))
    );
    return;
  }
  getStoreMap(storeName).delete(key);
}

async function clearStore(storeName) {
  if (storeName === STORES.entries) CURRENT_ENTRIES = syncStateEntries([]);
  getStoreMap(storeName).clear();
}

function applySearch(entries, q){
  const s = String(q || "").trim().toLowerCase();
  if (!s) return entries;
  return entries.filter(e => {
    const hay = [
      e.ref, e.ro, e.vin8, e.type, e.typeText, e.notes
    ].map(x => String(x || "").toLowerCase()).join(" ");
    return hay.includes(s);
  });
}

function populateDealerFilter(entries) {
  const select = document.getElementById("dealerFilter");
  if (!select) return;

  const prev = select.value || "all";
  const dealers = [...new Set((entries || []).map((e) => String(e?.dealer || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  select.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = "All Dealers";
  select.appendChild(allOpt);

  for (const d of dealers) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    select.appendChild(opt);
  }

  select.value = dealers.includes(prev) || prev === "all" ? prev : "all";
}

function applyDealerFilter(entries) {
  const select = document.getElementById("dealerFilter");
  const selected = select?.value || "all";
  if (selected === "all") return entries;
  return (entries || []).filter((e) => (e?.dealer || "UNKNOWN") === selected);
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
      refreshUI(CURRENT_ENTRIES);
    });
  });
}

// Week math: choose week start. Most payroll weeks start Monday.
// If yours starts Sunday, set WEEK_START = 0.
const WEEK_START = 1; // 0=Sun, 1=Mon

function startOfWeek(date, weekStart = WEEK_START) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0..6
  const diff = (day - weekStart + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function weekRangeFor(key, now = new Date()) {
  const thisStart = startOfWeek(now);
  const thisEnd = addDays(thisStart, 7); // exclusive
  if (key === "thisWeek") return { start: thisStart, end: thisEnd };

  const lastStart = addDays(thisStart, -7);
  const lastEnd = thisStart; // exclusive
  return { start: lastStart, end: lastEnd };
}

function inRange(tsMs, start, end) {
  return tsMs >= start.getTime() && tsMs < end.getTime();
}

function weekKey(date) {
  // key by start-of-week date in YYYY-MM-DD
  const s = startOfWeek(date);
  const y = s.getFullYear();
  const m = String(s.getMonth() + 1).padStart(2, "0");
  const d = String(s.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const PAY_STUBS_KEY = "frPayStubsByWeek";

function loadPaidMap() {
  try { return JSON.parse(localStorage.getItem("paidHoursByWeek") || "{}"); }
  catch { return {}; }
}

function savePaidMap(map) {
  localStorage.setItem("paidHoursByWeek", JSON.stringify(map));
}

function setPaidHoursForWeekKey(weekStartKey, value) {
  const map = loadPaidMap();
  map[String(weekStartKey || "")] = Number(value) || 0;
  savePaidMap(map);
}

function getPaidRecordForWeekStart(startDate) {
  const key = weekKey(startDate);
  const map = loadPaidMap();
  if (!Object.prototype.hasOwnProperty.call(map, key)) return null;
  return Number(map[key]) || 0;
}

function setPaidHoursForThisWeek(value) {
  setPaidHoursForWeekKey(weekKey(new Date()), value);
  if (typeof refreshUI === "function") refreshUI(CURRENT_ENTRIES);
}

function getPaidHoursForWeekStart(startDate) {
  const v = getPaidRecordForWeekStart(startDate);
  return v == null ? 0 : v;
}

function loadPayStubMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(PAY_STUBS_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function savePayStubMap(map) {
  localStorage.setItem(PAY_STUBS_KEY, JSON.stringify(map || {}));
}

function getPayStubForWeekKey(weekStartKey) {
  const key = String(weekStartKey || "").trim();
  if (!key) return null;
  const map = loadPayStubMap();
  const row = map[key];
  return row && typeof row === "object" ? row : null;
}

function upsertPayStubEntry(entry) {
  const key = String(entry?.weekStartKey || "").trim();
  if (!key) return;
  const map = loadPayStubMap();
  map[key] = {
    weekStartKey: key,
    weekEnding: String(entry?.weekEnding || ""),
    hoursPaid: Number(entry?.hoursPaid || 0),
    amountPaid: Number(entry?.amountPaid || 0),
    updatedAt: nowISO(),
  };
  savePayStubMap(map);
  setPaidHoursForWeekKey(key, Number(entry?.hoursPaid || 0));
}

function parseDateInputValue(ymd) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mon = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mon - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mon - 1 || dt.getDate() !== d) return null;
  return dt;
}

function weekStartKeyFromDateInput(ymd) {
  const dt = parseDateInputValue(ymd);
  if (!dt) return "";
  return dateKey(startOfWeekLocal(dt));
}

function weekEndingForWeekStartKey(weekStartKey) {
  const dt = parseDateInputValue(weekStartKey);
  if (!dt) return "";
  return dateKey(endOfWeekLocal(dt));
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

function dayKeyFromISO(iso){
  // Use local time consistently
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfWeekFromDateKey(dayKeyStr){
  const [yy,mm,dd] = dayKeyStr.split("-").map(Number);
  const d = new Date(yy, mm-1, dd);
  return startOfWeekLocal(d);
}

function getLastWeekRange(){
  const now = new Date();
  const thisWs = startOfWeekLocal(now);
  const lastWs = new Date(thisWs);
  lastWs.setDate(lastWs.getDate() - 7);
  const lastWe = endOfWeekLocal(lastWs);
  return { ws: lastWs, we: lastWe };
}

function matchSearch(e, q){
  if (!q) return true;
  const s = q.toLowerCase();
  return [
    e.ref, e.ro, e.vin8, e.type, e.typeText, e.notes
  ].some(v => String(v||"").toLowerCase().includes(s));
}

function entryRoValue(e) {
  return String(e?.ro || e?.ref || e?.ro_number || "").trim();
}

function parseRoNumericSuffix(roValue) {
  const numericPart = String(roValue || "").replace(/^\D+/, "");
  if (!numericPart) return null;
  const n = Number.parseInt(numericPart, 10);
  return Number.isFinite(n) ? n : null;
}

function compareEntriesByRo(a, b) {
  const aRo = entryRoValue(a);
  const bRo = entryRoValue(b);
  const aNum = parseRoNumericSuffix(aRo);
  const bNum = parseRoNumericSuffix(bRo);

  if (aNum != null && bNum != null && aNum !== bNum) return aNum - bNum;

  const lex = aRo.localeCompare(bRo, undefined, { numeric: true, sensitivity: "base" });
  if (lex !== 0) return lex;

  return (a.createdAt || "").localeCompare(b.createdAt || "");
}

function sortEntriesByRo(entries) {
  return (entries || []).sort(compareEntriesByRo);
}

function groupByDay(entries){
  const map = new Map();
  for (const e of entries) {
    const k = e.dayKey || dayKeyFromISO(e.createdAt) || "unknown";
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  const keys = Array.from(map.keys()).sort((a,b)=>b.localeCompare(a));
  return keys.map(k => ({ dayKey: k, entries: map.get(k) }));
}

function groupEntriesByWeek(entries){
  const groups = {};

  (entries || []).forEach(e => {
    const week = e.weekEnding || "unknown";
    if (!groups[week]) groups[week] = [];
    groups[week].push(e);
  });

  return groups;
}

function groupEntriesByBrand(entries) {
  const grouped = {};

  for (const entry of entries) {
    const brand = entry.detected_brand || "Unknown";

    if (!grouped[brand]) grouped[brand] = [];
    grouped[brand].push(entry);
  }

  return grouped;
}

function groupByDealer(entries){
  const grouped = groupEntriesByBrand(entries || []);
  const keys = Object.keys(grouped).sort((a, b) => a.localeCompare(b));
  return keys.map((k) => ({ dealer: k, entries: grouped[k] || [] }));
}

function entryRefLabel(e){
  const ref = e.ref || e.ro || e.stock || e.roStock || "";
  const kind = e.refType || e.refKind || "";
  return kind ? `${kind} ${ref}` : `${ref}`;
}

function formatWhen(iso){
  try { return new Date(iso).toLocaleString(); } catch { return iso || ""; }
}
