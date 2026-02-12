window.BUILD = "20260107a-hotfix1";
console.log("__FR_MARKER_20260121");

(async () => {
  if ("serviceWorker" in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
  }
  if (window.caches) {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  }
  console.log("[SW] fully removed");
})();

const USE_BACKEND = true;
// --- Supabase ---
const SUPABASE_URL = window.__SUPABASE_CONFIG__?.url;
const SUPABASE_ANON_KEY = window.__SUPABASE_CONFIG__?.anonKey;

const createClient = (globalThis.supabase && globalThis.supabase.createClient)
  ? globalThis.supabase.createClient
  : (globalThis.createClient || null);

if (!createClient) {
  console.error("Supabase createClient not found. Check the supabase-js script tag.");
}

window.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    flowType: "pkce",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

const sb = window.sb;
window.__FR = window.__FR || {};
window.__FR.sb = window.sb;
console.log("__FR_READY_20260121", !!window.__FR.sb);
window.__FR.supabase = window.supabase;

async function finalizeAuthFromUrl(sb) {
  try {
    const url = new URL(location.href);
    const code = url.searchParams.get("code");
    if (!code) return;
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (error) console.error("exchangeCodeForSession", error);
    url.searchParams.delete("code");
    history.replaceState({}, "", url.toString());
  } catch (e) {
    console.error("auth callback finalize failed", e);
  }
}

async function initAuth() {
  const statusEl = document.getElementById("authStatus");

  const setStatus = (txt) => {
    if (statusEl) statusEl.textContent = txt;
  };

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("auth timeout")), 4000)
  );

  try {
    const { data } = await Promise.race([sb.auth.getSession(), timeout]);
    const user = data?.session?.user;

    if (user) {
      setStatus("Signed in");
      window.CURRENT_UID = user.id;
    } else {
      setStatus("Not signed in");
      window.CURRENT_UID = null;
    }
  } catch (e) {
    console.warn("auth init failed", e);
    setStatus("Not signed in");
    window.CURRENT_UID = null;
  }
}

async function sendMagicLink(email) {
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: "https://kidundone.github.io/flat-rate-log/more.html"
    }
  });

  if (error) throw error;
}

async function verifyEmailCode(email, code) {
  const token = String(code || "").trim();
  const { data, error } = await sb.auth.verifyOtp({
    email,
    token,
    type: "email",
  });
  if (error) throw error;
  return data;
}

function wireAuthUI(sb) {
  const emailEl = document.getElementById("authEmail");
  const codeEl  = document.getElementById("authCode");
  const sendBtn = document.getElementById("authSendLink");
  const verBtn  = document.getElementById("authVerifyCode");
  const outBtn  = document.getElementById("authSignOut");

  if (!sendBtn || !outBtn) return;

  sendBtn.addEventListener("click", async () => {
    if (sendBtn.dataset.busy === "1") return;
    sendBtn.dataset.busy = "1";
    sendBtn.disabled = true;

    const email = (emailEl?.value || "").trim();
    try {
      if (!email) return alert("Enter email");
      await sendMagicLink(email);
      alert("Magic link sent. Open it on THIS device.");
    } catch (e) {
      alert("Sign-in failed: " + (e?.message || e));
    } finally {
      sendBtn.disabled = false;
      sendBtn.dataset.busy = "0";
    }
  });

  verBtn?.addEventListener("click", async () => {
    const email = (emailEl?.value || "").trim();
    const code  = (codeEl?.value || "").trim();
    if (!email) return alert("Enter email");
    if (!code) return alert("Enter the 6-digit code");

    try {
      await verifyEmailCode(email, code);
      await initAuth();
      alert("Signed in.");
    } catch (e) {
      alert("Verify failed: " + (e?.message || e));
    }
  });

  outBtn.addEventListener("click", async () => {
    await sb.auth.signOut();
    await initAuth();
  });

  sb.auth.onAuthStateChange(() => initAuth());
}

const PHOTO_BUCKET = "proofs"; // private

function setPhotoUploadTarget(path) {
  const bucketEl = document.getElementById("photoBucketName");
  if (bucketEl) bucketEl.textContent = PHOTO_BUCKET;
  const pathEl = document.getElementById("photoPathPreview");
  if (pathEl) pathEl.textContent = path || "—";
}

async function requireUserId(sb) {
  const { data } = await sb.auth.getUser();
  const uid = data?.user?.id;
  if (!uid) throw new Error("Sign in required");
  return uid;
}

async function getProofSignedUrl(sb, photoPath) {
  const { data, error } = await sb.storage
    .from("proofs")
    .createSignedUrl(photoPath, 60);

  if (error) throw error;
  return data.signedUrl;
}

async function uploadProofPhoto({ sb, empId, logId, file }) {
  const uid = await requireUserId(sb);

  const ext = (file.type === "image/png") ? "png" : "jpg";
  const path = `${uid}/${empId}/${logId}.${ext}`;

  const { error } = await sb.storage
    .from("proofs")
    .upload(path, file, {
      contentType: file.type || "image/jpeg",
      upsert: true,
    });

  if (error) throw error;
  await sb.from("work_logs").update({ photo_path: path }).eq("id", logId);
  return path;
}

async function sbListRows(empId) {
  if (!empId) return [];
  const uid = await requireUserId(sb);
  const q = sb
    .from("work_logs")
    .select("*")
    .eq("user_id", uid)
    .eq("employee_number", empId)
    .or("is_deleted.is.null,is_deleted.eq.false")
    .order("work_date", { ascending: false })
    .order("created_at", { ascending: false });
  const { data, error } = await q;

  if (error) throw error;
  return data || [];
}

async function probeEmpHasRows(empId) {
  if (!empId) return false;
  const uid = await requireUserId(sb);
  const { count, error } = await sb
    .from("work_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", uid)
    .eq("employee_number", empId)
    .or("is_deleted.is.null,is_deleted.eq.false");
  if (error) return false;
  return Number(count || 0) > 0;
}

async function sbDeleteProofPhoto(photoPath) {
  if (!photoPath) return;
  const { error } = await sb.storage.from(PHOTO_BUCKET).remove([photoPath]);
  if (error) throw error;
}

async function attachPhotoToLog({ sb, logId, photoPath }) {
  const { data, error } = await sb
    .from("work_logs")
    .update({ photo_path: photoPath, updated_at: new Date().toISOString() })
    .eq("id", logId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function saveEditedLog(logId, patch) {
  const empId = getEmpId();
  const file = getSelectedPhotoFile();
  if (file) {
    const newPath = await uploadProofPhoto({ sb, empId, logId, file });
    patch.photo_path = newPath;
  }

  const { data, error } = await sb
    .from("work_logs")
    .update(patch)
    .eq("id", logId)
    .select("id, photo_path")
    .maybeSingle();

  if (error) throw error;

  window.SELECTED_PHOTO_FILE = null;
  SELECTED_PHOTO_FILE = null;
  const input = document.querySelector("#photoInput, input[type=file][data-photo]");
  if (input) input.value = "";

  return data;
}

async function sbProofPhotoUrl(photoPath) {
  return getProofSignedUrl(sb, photoPath);
}

async function getPhotoUrl(photoPath) {
  return getProofSignedUrl(sb, photoPath);
}

const LS_EMP = "fr_emp_id";

function getEmpId() {
  const raw =
    (document.getElementById("empId")?.value || localStorage.getItem("fr_emp_id") || "")
      .trim();

  // digits only
  const digits = raw.replace(/\D/g, "");

  // REQUIRE full employee # length (change 5 if yours differs)
  if (digits.length < 5) return "";

  // persist only when valid
  localStorage.setItem("fr_emp_id", digits);
  return digits;
}

function setEmpId(emp) {
  localStorage.setItem(LS_EMP, emp);
}

function mapEntryToRow(payload, userId) {
  return {
    user_id: userId,
    work_date: payload.work_date,
    category: payload.category || "work",
    ro_number: payload.ro_number || null,
    description: payload.description || null,
    flat_hours: Number(payload.flat_hours || 0),
    cash_amount: Number(payload.cash_amount || 0),
    location: payload.location || null,
    vin8: payload.vin8 || null,
    photo_path: payload.photo_path || null,
  };
}

// LIST
async function apiListLogs(empId) {
  if (!empId) {
    empId = getEmpId();
    if (!empId) return [];
  }
  const uid = await requireUserId(sb);
  if (!uid) return [];
  return sbListRows(empId);
}

// CREATE
async function apiCreateLog(payload) {
  await requireUserId(sb);
  const empId = String(document.getElementById("empId").value || "").trim();
  if (!empId) throw new Error("Employee # required");

  const uid = await requireUserId(sb);

  // 1) Create row first (no photo_path yet)
  const { data: created, error: e1 } = await sb
    .from("work_logs")
    .insert([{
      user_id: uid,
      employee_number: empId,
      work_date: payload.work_date,
      category: payload.category || "work",
      ro_number: payload.ro_number || null,
      description: payload.description || null,
      flat_hours: Number(payload.flat_hours || 0),
      cash_amount: Number(payload.cash_amount || 0),
      location: payload.location || null,
      vin8: payload.vin8 || null,
      is_deleted: false,
      photo_path: null,
    }])
    .select("id")
    .maybeSingle();

  if (e1) throw e1;
  const createdRow = created ?? null;
  if (!createdRow) throw new Error("Create failed: no row returned");

  return createdRow;
}

// UPDATE
async function apiUpdateLog(id, payload) {
  const empId = getEmpId();
  if (!empId) return null;
  const uid = await requireUserId(sb);
  if (!uid) return null;

  // Update fields first
  const { data: updated, error: e1 } = await sb
    .from("work_logs")
    .update({
      work_date: payload.work_date,
      category: payload.category || "work",
      ro_number: payload.ro_number || null,
      description: payload.description || null,
      flat_hours: Number(payload.flat_hours || 0),
      cash_amount: Number(payload.cash_amount || 0),
      location: payload.location || null,
      vin8: payload.vin8 || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", uid)
    .eq("employee_number", empId)
    .select("*")
    .limit(1);

  if (e1) throw e1;
  const updatedRow = updated?.[0] ?? null;
  if (!updatedRow) throw new Error("Update failed: no row returned");

  return updatedRow;
}

// --- Soft delete helpers ---
async function softDeleteLog(sb, id) {
  const uid = (await sb.auth.getUser()).data.user?.id;
  if (!uid) throw new Error("Not signed in");

  const { error } = await sb
    .from("work_logs")
    .update({ is_deleted: true, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", uid); // makes RLS happy

  if (error) throw error;
}

async function undoSoftDeleteLog(sb, id) {
  const { data, error } = await sb
    .from("work_logs")
    .update({ is_deleted: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id,is_deleted")
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Undo failed: row not found");
  return data;
}

let LAST_DELETED = null;

async function onDeleteClicked(btn, idOverride = null) {
  const id = String(
    idOverride
    || btn?.dataset?.del
    || btn?.getAttribute?.("data-del")
    || ""
  ).trim();
  if (!id) return;

  if (!confirm("Soft delete this entry?")) return;

  if (btn) {
    if (btn.dataset.busy === "1") return;
    btn.disabled = true;
    btn.dataset.busy = "1";
  }

  try {
    await softDeleteLog(sb, id);
    LAST_DELETED = { id, at: Date.now() };

    if (window.STATE?.entries) {
      window.STATE.entries = window.STATE.entries.filter(x => String(x.id) !== String(id));
      await renderEntries(window.STATE.entries);
    } else {
      await loadEntries();
    }

    showUndoBar({
      text: "Entry deleted.",
      onUndo: async () => {
        await undoSoftDeleteLog(sb, id);
        await safeLoadEntries();
      },
      ttlMs: 8000
    });
  } catch (e) {
    console.error("DELETE FAILED", e);
    alert("Delete failed: " + (e?.message || e));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.dataset.busy = "0";
    }
  }
}

async function onUndoDelete() {
  if (!LAST_DELETED) return;

  try {
    await undoSoftDeleteLog(sb, LAST_DELETED.id);
    LAST_DELETED = null;

    if (window.__FR?.safeLoadEntries) await window.__FR.safeLoadEntries();
    else await loadEntries();
    const bar = document.getElementById("undoBar");
    if (bar) bar.style.display = "none";
  } catch (e) {
    console.error("UNDO FAILED", e);
    alert("Undo failed: " + (e?.message || e));
  }
}

let BACKEND_ENTRIES = null;
let EDITING_ID = null; // null = creating new
let EDITING_ENTRY = null;
let isSaving = false;


function normalizeEntryForApi(entry) {
  // Map your existing entry object into the backend schema.
  // Edit these mappings to match your real fields.
  return {
    work_date: entry.dayKey || entry.date || entry.work_date || (entry.createdAt ? dayKeyFromISO(entry.createdAt) : null), // MUST be "YYYY-MM-DD"
    category: entry.typeText || entry.type || entry.category || "work",
    ro_number: entry.ref || entry.ro || entry.ro_number || null,
    description: entry.notes || entry.desc || entry.description || null,
    flat_hours: Number(entry.hours || entry.flat || entry.flat_hours || 0),
    cash_amount: Number(entry.earnings || entry.cash || entry.cash_amount || 0),
    location: entry.location || null,
    vin8: entry.vin8 || null,
    photo_path: entry.photo_path || entry.photoPath || null,
  };
}

function normalizeSupabaseLog(r) {
  return {
    id: r.id,
    work_date: r.work_date,
    created_at: r.created_at,
    updated_at: r.updated_at,

    // UI expects these names (based on your form)
    ref: r.ro_number ?? "",
    ro_number: r.ro_number ?? "",

    typeText: r.category ?? "",
    category: r.category ?? "",

    notes: r.description ?? "",
    description: r.description ?? "",

    // CRITICAL: map flat_hours -> hours (so existing UI math works)
    hours: Number(r.flat_hours ?? 0),
    flat_hours: Number(r.flat_hours ?? 0),

    cash: Number(r.cash_amount ?? 0),
    cash_amount: Number(r.cash_amount ?? 0),

    location: r.location ?? "",
    vin8: r.vin8 ?? "",
    photo_path: r.photo_path ?? null,

    owner_key: r.owner_key ?? null,
    employee_number: r.employee_number ?? null,
    is_deleted: r.is_deleted ?? false,
  };
}

function mapServerLogToEntry(r) {
  const createdAt = r.created_at || new Date().toISOString();
  const dayKey = r.work_date; // already YYYY-MM-DD
  const hours = Number(r.flat_hours || 0);
  const rate = 15; // or your default

  return {
    id: r.id, // do NOT generate uuid() or local ID
    empId: getEmpId(),
    createdAt,
    createdAtMs: Date.parse(createdAt) || Date.now(),
    dayKey,
    weekStartKey: dateKey(startOfWeekLocal(new Date(dayKey))),
    refType: "RO",
    ref: r.ro_number || "",
    ro: r.ro_number || "",
    vin8: r.vin8 || "",
    type: r.category || "work",
    typeText: r.category || "work",
    hours: round1(hours),
    rate: round2(rate),
    earnings: round2(hours * rate),
    notes: r.description || "",
    cash_amount: Number(r.cash_amount || 0),
    photoDataUrl: null,
    photo_path: r.photo_path || null,
    location: r.location || null,
  };
}

const DB_NAME = "frlog";
const DB_VERSION = 6; // bump this

const STORES = {
  entries: "entries",
  types: "types_v2",      // <-- change from "types"
  weekflags: "weekflags",
  payroll: "payroll"
};

const $ = (id) => document.getElementById(id);

// ---- Page detect (GLOBAL) ----
const PAGE = location.pathname.endsWith("/more.html") ? "more" : "main";
const IS_MAIN = PAGE === "main";
const IS_MORE = PAGE === "more";

let rangeMode = "day";
let currentRefType = "RO";
let summaryRange = (window.__WEEK_WHICH__ === "last" || window.__WEEK_WHICH__ === "lastWeek") ? "lastWeek" : "thisWeek"; // "thisWeek" | "lastWeek"

function setSummaryRange(next) {
  summaryRange = (next === "lastWeek") ? "lastWeek" : "thisWeek";
  window.__WEEK_WHICH__ = summaryRange;
  if (PAGE === "main") refreshUI();
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

// --- Photo selection (camera / library / files) ---
let SELECTED_PHOTO_FILE = null;

function setSelectedPhotoFile(file, label = "") {
  SELECTED_PHOTO_FILE = file || null;
  window.SELECTED_PHOTO_FILE = SELECTED_PHOTO_FILE;

  const lbl = document.getElementById("photoPickedLabel");
  if (lbl) {
    lbl.textContent = file
      ? `Selected: ${label || file.name} (${Math.round(file.size / 1024)} KB)`
      : "No photo";
  }
}

function setSelectedPhoto(file, label = "") {
  setSelectedPhotoFile(file, label);
}

function getSelectedPhotoFile() {
  if (window.SELECTED_PHOTO_FILE) return window.SELECTED_PHOTO_FILE;
  if (SELECTED_PHOTO_FILE) return SELECTED_PHOTO_FILE;
  const el = document.querySelector(
    "#photoInput, #proofPhoto, #photoPicker, #photoCamera, #photoFile, input[type=file][data-photo]"
  );
  return el?.files?.[0] || null;
}

function setPhotoLabelFromEntry(entry) {
  const lbl = document.getElementById("photoPickedLabel");
  if (!lbl) return;
  const hasPhoto = !!entry?.photo_path;
  lbl.textContent = hasPhoto ? "Photo attached" : "No photo";
  setPhotoUploadTarget(entry?.photo_path || "");
}

function clearPickedPhoto() {
  const cam = document.getElementById("photoCamera");
  const pick = document.getElementById("photoPicker");
  const file = document.getElementById("photoFile");
  if (cam) cam.value = "";
  if (pick) pick.value = "";
  if (file) file.value = "";
  setSelectedPhotoFile(null);
  setPhotoUploadTarget("");
}

function wirePhotoPickers() {
  const btnTake = document.getElementById("btnTakePhoto");
  const btnPick = document.getElementById("btnPickPhoto");
  const btnFile = document.getElementById("btnPickFile");

  const inCamera = document.getElementById("photoCamera");
  const inPicker = document.getElementById("photoPicker");
  const inFile   = document.getElementById("photoFile");

  if (!inCamera || !inPicker || !inFile) return;

  // IMPORTANT: accept attrs help iOS show correct picker
  inCamera.setAttribute("accept", "image/*");
  inCamera.setAttribute("capture", "environment");

  inPicker.setAttribute("accept", "image/*");
  inFile.setAttribute("accept", "image/*");

  // Buttons must trigger input click from a user gesture
  btnTake?.addEventListener("click", (e) => { e.preventDefault(); inCamera.click(); });
  btnPick?.addEventListener("click", (e) => { e.preventDefault(); inPicker.click(); });
  btnFile?.addEventListener("click", (e) => { e.preventDefault(); inFile.click(); });

  // Change handlers (this is what you’re missing/broken)
  inCamera.addEventListener("change", () => setSelectedPhoto(inCamera.files?.[0] || null, "camera"));
  inPicker.addEventListener("change", () => setSelectedPhoto(inPicker.files?.[0] || null, "library"));
  inFile.addEventListener("change",   () => setSelectedPhoto(inFile.files?.[0]   || null, "file"));
}

function num(v){
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
}

function setRangeMode(m) {
  rangeMode = m;
  window.__RANGE_MODE__ = m;

  document.getElementById("rangeDayBtn")?.classList.toggle("active", m === "day");
  document.getElementById("rangeWeekBtn")?.classList.toggle("active", m === "week");
  document.getElementById("rangeMonthBtn")?.classList.toggle("active", m === "month");
  document.getElementById("rangeAllBtn")?.classList.toggle("active", m === "all");

  const row = document.getElementById("weekWhichRow");
  if (row) row.style.display = (m === "week") ? "inline-flex" : "none";

  if (PAGE === "main") refreshUI();
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
async function safeLoadEntries() {
  try {
    const rows = await loadEntries();
    return rows;
  } catch (e) {
    return [];
  }
}
window.__FR = window.__FR || {};
window.__FR.safeLoadEntries = safeLoadEntries;
function initEmpIdBoot() {
  const el = document.getElementById("empId");
  if (!el) return;

  const saved = (localStorage.getItem("fr_emp_id") || "").trim();
  if (saved && !el.value) el.value = saved;

  // If we already have a valid empId, load immediately
  if ((el.value || "").trim().replace(/\D/g, "").length >= 5) {
    safeLoadEntries();
  }
}
function wireEmpIdReload() {
  const el = document.getElementById("empId");
  if (!el) return;

  const maybeReload = () => {
    const digits = (el.value || "").trim().replace(/\D/g, "");
    if (digits.length >= 5) {
      localStorage.setItem("fr_emp_id", digits);
      safeLoadEntries();
    }
  };

  el.addEventListener("blur", maybeReload);
  el.addEventListener("change", maybeReload);

  // Optional: if you want it to auto-load as they type (only once valid)
  el.addEventListener("input", () => {
    const digits = (el.value || "").trim().replace(/\D/g, "");
    if (digits.length === 5) maybeReload();
  });
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
              catch {} 
            });
          };
        } catch (err) {
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

function normalizeEntries(entries) {
  return (entries || []).map((e) => {
    if (typeof e?.createdAtMs === "number") return e;
    const parsed = e?.createdAt ? Date.parse(e.createdAt) : (e?.date ? Date.parse(e.date) : NaN);
    return { ...e, createdAtMs: Number.isFinite(parsed) ? parsed : Date.now() };
  });
}

async function getAll(storeName) {
  if (storeName === STORES.entries && USE_BACKEND) {
    return normalizeEntries(Array.isArray(BACKEND_ENTRIES) ? BACKEND_ENTRIES : []);
  }
  const { db, store, done } = await tx(storeName, "readonly");
  try {
    const items = await new Promise((resolve, reject) => {
      const r = store.getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
    await done; // wait for txn
    return storeName === STORES.entries ? normalizeEntries(items) : items;
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

async function compressImageFile(file, {
  maxWidth = 1280,
  quality = 0.75,
  mime = "image/jpeg",
} = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      let { width, height } = img;

      if (width > maxWidth) {
        height = Math.round(height * (maxWidth / width));
        width = maxWidth;
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error("Compression failed"));
          const out = new File([blob], "proof.jpg", { type: mime });
          resolve(out);
        },
        mime,
        quality
      );

      URL.revokeObjectURL(url);
    };

    img.onerror = () => reject(new Error("Image load failed"));
    img.src = url;
  });
}

async function compressImageFileToDataUrl(file, maxW = 1200, quality = 0.75) {
  const dataUrl = await fileToDataURL(file);
  const img = await fileToImageFromDataUrl(dataUrl);

  const scale = Math.min(1, maxW / img.width);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, w, h);

  return canvas.toDataURL("image/jpeg", quality);
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

function loadPaidMap() {
  try { return JSON.parse(localStorage.getItem("paidHoursByWeek") || "{}"); }
  catch { return {}; }
}

function savePaidMap(map) {
  localStorage.setItem("paidHoursByWeek", JSON.stringify(map));
}

function setPaidHoursForThisWeek(value) {
  const map = loadPaidMap();
  map[weekKey(new Date())] = Number(value) || 0;
  savePaidMap(map);
  if (typeof refreshUI === "function") refreshUI();
}

function getPaidHoursForWeekStart(startDate) {
  const map = loadPaidMap();
  return Number(map[weekKey(startDate)]) || 0;
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

async function backfillDayKeysForEmp(empId){
  const all = await getAll(STORES.entries);
  const mine = filterEntriesByEmp(all, empId);
  const needsFix = mine.filter(e => !e.dayKey || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(e.dayKey)));
  if (!needsFix.length) return 0;

  for (const e of needsFix) {
    const fixed = dayKeyFromISO(e.createdAt);
    if (!fixed) continue;
    e.dayKey = fixed;
    e.weekStartKey = dateKey(startOfWeekLocal(new Date(fixed)));
    await put(STORES.entries, e);
  }
  return needsFix.length;
}

async function backfillDayKeysForEmpCursor(empId, { batch = 150 } = {}) {
  const id = String(empId || "").trim();
  if (!id) return 0;

  const db = await openDB();
  let changed = 0;

  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.entries, "readwrite");
      const store = tx.objectStore(STORES.entries);

      const req = store.openCursor();
      let processed = 0;

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();

        const e = cursor.value;

        if (String(e?.empId || "").trim() === id) {
          const okDayKey = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(e.dayKey || ""));
          if (!okDayKey) {
            const fixed = dayKeyFromISO(e.createdAt);
            if (fixed) {
              e.dayKey = fixed;

              const ws = startOfWeekFromDateKey(fixed);
              e.weekStartKey = dateKey(ws);

              cursor.update(e);
              changed += 1;
            }
          }
        }

        processed += 1;

        if (processed % batch === 0) {
          setTimeout(() => cursor.continue(), 0);
        } else {
          cursor.continue();
        }
      };

      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error || new Error("backfill aborted"));
    });

    return changed;
  } finally {
    db.close();
  }
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

  const pool = (window.STATE?.entries) || [];
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
}

async function renderLogs(logs) {
  const entries = Array.isArray(logs) ? normalizeEntries(logs) : [];
  await refreshUI(entries);
}

async function renderEntries(rows) {
  const mapped = (rows || []).map(mapServerLogToEntry);
  BACKEND_ENTRIES = mapped;
  await renderLogs(mapped);
  return mapped;
}

async function loadEntries() {
  const empId = getEmpId();
  if (!empId) throw new Error("Employee # required");

  const uid = await requireUserId(sb);

  const res = await sb
    .from("work_logs")
    .select("*")
    .eq("user_id", uid)
    .eq("employee_number", empId)
    .or("is_deleted.is.null,is_deleted.eq.false")
    .order("work_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (res.error) throw res.error;

  const rows = (res.data || []).map(normalizeSupabaseLog);
  window.STATE = window.STATE || {};
  window.STATE.entries = rows;
  return await renderEntries(rows);
}

async function saveEntry(entry) {
  if (!USE_BACKEND) {
    await put(STORES.entries, entry);
    await refreshUI();
    return;
  }

  const payload = normalizeEntryForApi(entry);
  const photoFile = getSelectedPhotoFile();
  const empId = getEmpId();
  const uid = empId ? await requireUserId(sb) : null;

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
    saved = await apiCreateLog(payload);
    photo_path = saved?.photo_path || payload.photo_path || null;
    if (photoFile) {
      toast("Uploading photo...");
      try {
        const newPath = await uploadProofPhoto({ sb, empId, logId: saved.id, file: photoFile });
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
    const { error } = await sb
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

  // Refresh after photo upload so it shows up immediately
  await loadEntries();
  if (photoStatus === "fail") toast("Saved (photo failed)");
  else if (photoStatus === "ok") toast("Saved + Photo");
  else toast("Saved");
  handleClear();
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
    const photoEl = document.getElementById("proofPhoto")
      || document.getElementById("photoPicker")
      || document.getElementById("photoCamera")
      || document.getElementById("photoFile");
    const notesEl = document.querySelector('textarea[name="notes"]');

    const ref = (refEl?.value || "").trim();
    const vin8 = (vinEl?.value || "").trim().toUpperCase();
    const typeName = (typeEl?.value || "").trim();
    const hoursVal = num(hoursEl?.value);
    const rateVal = num(rateEl?.value) || 15;
    const notes = (notesEl?.value || "").trim();

    if (!ref) { toast("Ref required"); return; }
    if (!typeName) { toast("Type required"); return; }
    if (!hoursVal || hoursVal <= 0) { toast("Hours must be > 0"); return; }

    const photoFile = getSelectedPhotoFile() || photoEl?.files?.[0] || null;
    const createdAt = (isEditing && baseEntry.createdAt) ? baseEntry.createdAt : nowISO();
    const createdAtMs = (isEditing && Number.isFinite(baseEntry.createdAtMs)) ? baseEntry.createdAtMs : Date.now();
    const dayKey = (isEditing && baseEntry.dayKey) ? baseEntry.dayKey : dayKeyFromISO(createdAt);
    let photoDataUrl = null;
    if (!USE_BACKEND) {
      try {
        photoDataUrl = photoFile ? await compressImageFileToDataUrl(photoFile, 1200, 0.75) : null;
      } catch (e) {
        toast("Photo save failed");
        return;
      }
      if (isEditing && !photoDataUrl) photoDataUrl = baseEntry.photoDataUrl || null;
    }
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
      vin8,
      type: typeName,
      typeText: typeName,
      hours: round1(hoursVal),
      rate: round2(rateVal),
      earnings: round2(hoursVal * rateVal),
      notes,
      photoDataUrl,
      location: baseEntry.location ?? null
    };

    await saveEntry(entry);
    setSelectedPhotoFile(null);
    document.getElementById("photoPicker") && (document.getElementById("photoPicker").value = "");
    document.getElementById("photoCamera") && (document.getElementById("photoCamera").value = "");
    document.getElementById("photoFile") && (document.getElementById("photoFile").value = "");
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
    .sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||""));

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
              <div class="small">VIN8: <span class="mono">${escapeHtml(e.vin8||"-")}</span> • ${formatWhen(e.createdAt)}</div>
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
          <div class="small">Day: <span class="mono">${escapeHtml(e.dayKey||dayKeyFromISO(e.createdAt)||"-")}</span> • VIN8: <span class="mono">${escapeHtml(e.vin8||"-")}</span> • ${formatWhen(e.createdAt)}</div>
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
    ? ["empId","createdAt","dayKey","refType","ref","vin8","type","hours","rate","earnings","notes","hasPhoto"]
    : ["createdAt","dayKey","refType","ref","vin8","type","hours","rate","earnings","notes","hasPhoto"];

  const escape = (v) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const rows = (entries || []).map(e => {
    const row = includeEmp
      ? [e.empId, e.createdAt, e.dayKey, e.refType || "RO", e.ref || e.ro, e.vin8, e.type, e.hours, e.rate, e.earnings, e.notes, e.photoDataUrl ? "yes" : "no"]
      : [e.createdAt, e.dayKey, e.refType || "RO", e.ref || e.ro, e.vin8, e.type, e.hours, e.rate, e.earnings, e.notes, e.photoDataUrl ? "yes" : "no"];
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

  const visible = applySearch(ranged, q);
  const capped = visible.slice(0, 60);

  if (capped.length === 0) {
    const msg = q ? `No entries match "${escapeHtml(q)}".` : "No entries match your search.";
    list.innerHTML = `<div class="muted">${msg}</div>`;
    return;
  }

  const buildEntry = (e) => {
    const row = document.createElement("div");
    row.className = "item";
    const ts = new Date(e.createdAt).toLocaleString();
    const refLabel = e.refType === "STOCK" ? "STK" : "RO";
    const refVal = escapeHtml(e.ref || e.ro || "-");
    const refDisplay = `${refLabel}: ${refVal}`;
    const editBtn = `<button class="btn" data-action="edit" data-id="${e.id}">Edit</button>`;
    const deleteBtn = `<button class="btn danger" data-del="${e.id}">Delete</button>`;
    const viewPhotoBtn = entryHasPhoto(e)
      ? `<button class="btn" data-action="view-photo" data-id="${e.id}">View Photo</button>`
      : "";
    const actionButtons = [editBtn, deleteBtn, viewPhotoBtn].filter(Boolean).join(" ");
    row.innerHTML = `
      <div class="itemTop">
        <div>
          <div><span class="mono">${refDisplay}</span> <span class="muted">(${escapeHtml(e.type)})</span></div>
          <div class="small">VIN8: <span class="mono">${escapeHtml(e.vin8 || "-")}</span> • ${ts}</div>
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
    if (entryHasPhoto(e)) {
      const btn = row.querySelector('button[data-action="view-photo"]');
      if (btn) btn.addEventListener("click", () => openPhoto(e));
    }
    return row;
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
  const entries = (window.STATE && window.STATE.entries) || [];
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
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  const empId = getEmpId();
  const allEntries = Array.isArray(entriesOverride)
    ? normalizeEntries(entriesOverride)
    : await getAll(STORES.entries);
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

async function saveFlaggedHours(){
  const fh = document.getElementById("flaggedHours");
  const val = fh ? Number(fh.value || 0) : 0;
  if (!Number.isFinite(val) || val < 0) return alert("Flagged hours must be a number >= 0.");
  await setThisWeekFlag(val);
  alert("Flagged hours saved for this week.");
}

async function wipeLocalOnly(){
  await clearStore(STORES.entries);
  await clearStore(STORES.types);
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
  if (_photosRequested) await renderPhotoGrid(true, { updateStatus: true });
  else clearPhotoGallery();
}

function entryRefLabel(e){
  const ref = e.ref || e.ro || e.stock || e.roStock || "";
  const kind = e.refType || e.refKind || "";
  return kind ? `${kind} ${ref}` : `${ref}`;
}

async function entryPhotoUrl(entry) {
  return getPhotoUrl(entry?.photo_path);
}

function entryHasPhoto(entry) {
  return !!entry?.photo_path;
}

function formatWhen(iso){
  try { return new Date(iso).toLocaleString(); } catch { return iso || ""; }
}

async function getRecentPhotoEntriesByEmp(empId, limit = 24) {
  const id = String(empId || "").trim();
  if (!id) return [];

  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const out = [];
      const tx = db.transaction(STORES.entries, "readonly");
      const store = tx.objectStore(STORES.entries);

      let source = store;
      try {
        source = store.index("createdAt");
      } catch {}

      const req = source.openCursor ? source.openCursor(null, "prev") : null;
      if (!req) return resolve([]);

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(out);

        const e = cursor.value;
        const matchEmp = String(e?.empId || "").trim() === id;
        const hasPhoto = entryHasPhoto(e);
        if (e && hasPhoto && matchEmp) {
          out.push(e);
          if (out.length >= limit) return resolve(out);
        }
        cursor.continue();
      };

      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error || new Error("txn abort"));
    });
  } finally {
    db.close();
  }
}

function setGalleryStatus(msg){
  const el = document.getElementById("galleryStatus");
  if (el) el.textContent = msg || "";
}

let _photosRequested = false;

function clearPhotoGallery(){
  const el = document.getElementById("photoGallery");
  if (el) el.innerHTML = "";
  setGalleryStatus("");
  _photosRequested = false;
}

async function renderPhotoGallerySafe(entries){
  const el = document.getElementById("photoGallery");
  if (!el) return 0;

  if (!entries || !entries.length) {
    el.innerHTML = `<div class="muted">No photos found for this employee.</div>`;
    return 0;
  }

  el.innerHTML = "";
  let count = 0;
  for (const e of entries) {
    const photoUrl = await entryPhotoUrl(e);
    if (!photoUrl) continue;

    const img = document.createElement("img");
    img.className = "thumb";
    applyPhotoLoadGuard(img, e.photo_path);
    img.src = photoUrl;
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("click", () => openPhotoViewer(e));
    el.appendChild(img);
    count += 1;
  }

  if (!count) {
    el.innerHTML = `<div class="muted">No photos found for this employee.</div>`;
  }

  return count;
}

async function renderPhotoGrid(allowAll = false, opts = {}){
  const empId = getEmpId();
  if (!empId) {
    clearPhotoGallery();
    setGalleryStatus("Enter Employee # to load photos.");
    return 0;
  }

  try {
    const limit = opts.limit || 24;
    const entries = await getRecentPhotoEntriesByEmp(empId, limit);
    const count = await renderPhotoGallerySafe(entries);

    if (opts.updateStatus) {
      if (count > 0) setGalleryStatus(`Loaded ${count} photo${count === 1 ? "" : "s"}.`);
      else setGalleryStatus("No photos found for this employee.");
    }

    return count;
  } catch (e) {
    if (opts.updateStatus) setGalleryStatus("Failed to load photos.");
    return 0;
  }
}

async function renderReview(){
  const empId = getEmpId();
  if (!empId) { setStatusMsg("Enter Employee # to review work."); return; }

  const range = document.getElementById("reviewRange")?.value || "week";
  const group = document.getElementById("reviewGroup")?.value || "day";
  const q = (document.getElementById("reviewSearch")?.value || "").trim().toLowerCase();

  const all = filterEntriesByEmp(await getAll(STORES.entries), empId)
    .sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||""));

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

  if (q) slice = slice.filter(e => matchSearch(e, q));

  const totals = computeTotals(slice);
  const meta = document.getElementById("reviewMeta");
  if (meta) meta.textContent = `${slice.length} entries • ${formatHours(totals.hours)} hrs • ${formatMoney(totals.dollars)}`;

  const list = document.getElementById("reviewList");
  if (!list) return;

  list.innerHTML = "";
  if (!slice.length) { list.innerHTML = `<div class="muted">No entries match.</div>`; return; }

  if (group === "day") {
    const groups = groupByDay(slice);
    for (const g of groups) {
      const t = computeTotals(g.entries);
      const head = document.createElement("div");
      head.className = "item";
      head.innerHTML = `
        <div class="itemTop">
          <div class="mono">${g.dayKey}</div>
          <div class="right mono">${formatHours(t.hours)} hrs • ${formatMoney(t.dollars)}</div>
        </div>`;
      list.appendChild(head);

      for (const e of g.entries) {
        const row = document.createElement("div");
        row.className = "item";
        row.innerHTML = `
          <div class="itemTop">
            <div>
              <div class="mono">${escapeHtml(e.refType||"RO")}: ${escapeHtml(e.ref||e.ro||"-")} <span class="muted">(${escapeHtml(e.type||"")})</span></div>
              <div class="small">VIN8: <span class="mono">${escapeHtml(e.vin8||"-")}</span> • ${formatWhen(e.createdAt)}</div>
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
        list.appendChild(row);
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
          <div class="mono">${escapeHtml(e.refType||"RO")}: ${escapeHtml(e.ref||e.ro||"-")} <span class="muted">(${escapeHtml(e.type||"")})</span></div>
          <div class="small">${escapeHtml(e.dayKey||dayKeyFromISO(e.createdAt)||"-")} • VIN8: <span class="mono">${escapeHtml(e.vin8||"-")}</span> • ${formatWhen(e.createdAt)}</div>
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
    list.appendChild(row);
  }
}

async function exportAllCsvAdmin() {
  if (!(await requireAdmin())) return alert("Denied.");

  const entries = await getAll(STORES.entries);
  entries.sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  downloadText(`flat_rate_log_ALL_${todayKeyLocal()}.csv`, toCSV(entries), "text/csv");
}

async function openPhotoViewer(e){
  const shell = document.getElementById("photoViewer");
  const meta = document.getElementById("photoMeta");
  const dl = document.getElementById("downloadPhotoBtn");
  const card = shell?.querySelector(".card");
  const downloadRow = dl?.closest?.(".row");
  const img = ensurePhotoImg(
    "photoFull",
    card,
    "width:100%; border-radius:16px; margin-top:10px;",
    downloadRow
  );

  if (!shell || !img || !meta || !dl) return;

  if (!e?.photo_path) return toast("No photo saved.");

  const url = await getPhotoUrl(e.photo_path);

  applyPhotoLoadGuard(img, e.photo_path);
  img.src = url;
  dl.href = url;

  const label = `${e.ro || e.ref || ""}`.trim();
  meta.textContent = `${label} • ${e.work_date || e.dayKey || ""}`;

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

  clearPhotoGallery();

  const loadBtn = document.getElementById("loadPhotosBtn");
  if (loadBtn) {
    loadBtn.addEventListener("click", async () => {
      const empId = getEmpId();
      if (!empId) {
        alert("Enter Employee # first.");
        return;
      }

      setGalleryStatus("Loading...");
      loadBtn.disabled = true;
      try {
        const photos = await getRecentPhotoEntriesByEmp(empId, 24);
        const count = await renderPhotoGallerySafe(photos);
        _photosRequested = true;
        setGalleryStatus(`Loaded ${count} photo(s).`);
      } catch (e) {
        _photosRequested = false;
        setGalleryStatus("Load failed.");
        alert("Photo load failed: " + (e?.message || e));
      } finally {
        loadBtn.disabled = false;
      }
    });
  }

  document.getElementById("clearGalleryBtn")?.addEventListener("click", () => {
    clearPhotoGallery();
    setGalleryStatus("");
    closePhotoViewer();
  });
}

/* -------------------- Boot -------------------- */
document.addEventListener("DOMContentLoaded", () => {
  (async () => {
    let bootLoaded = false;
    const bootEmpId = getEmpId();
    if (bootEmpId) bootLoaded = true;

    if (window.sb) {
      await finalizeAuthFromUrl(window.sb);

      // only wire auth UI if the elements exist
      if (document.getElementById("authSendLink")) {
        wireAuthUI(window.sb);
      }

      await initAuth();
    }

    await ensureDefaultTypes();
    await (async () => {
      try {
        if (!bootLoaded) await loadEntries();
      } catch (e) {
      } finally {
        // MUST bind UI no matter what
        wirePhotoPickers?.();
        setSelectedPhotoFile?.(null);
        setPhotoUploadTarget?.("");
      }
    })();

    // ================= MAIN PAGE ONLY =================
    if (PAGE === "main") {
      if (typeof handleSave !== "function") {
        return;
      }

      await renderTypeDatalist();
      await renderTypesListInMore();

      document.getElementById("filterSelect")?.addEventListener("change", refreshUI);
      document.getElementById("refreshBtn")?.addEventListener("click", refreshUI);

      const sIn = document.getElementById("searchInput");
      const sClr = document.getElementById("clearSearchBtn");
      if (sIn) sIn.addEventListener("input", () => refreshUI());
      if (sClr) sClr.addEventListener("click", () => { if (sIn) sIn.value = ""; refreshUI(); });

      document.getElementById("rangeDayBtn")?.addEventListener("click", () => setRangeMode("day"));
      document.getElementById("rangeWeekBtn")?.addEventListener("click", () => setRangeMode("week"));
      document.getElementById("rangeMonthBtn")?.addEventListener("click", () => setRangeMode("month"));
      document.getElementById("rangeAllBtn")?.addEventListener("click", () => setRangeMode("all"));

      const syncWeekBtns = () => {
        document.getElementById("weekThisBtn")?.classList.toggle("active", summaryRange === "thisWeek");
        document.getElementById("weekLastBtn")?.classList.toggle("active", summaryRange === "lastWeek");
      };

      document.getElementById("weekThisBtn")?.addEventListener("click", () => {
        setSummaryRange("thisWeek");
        syncWeekBtns();
      });

      document.getElementById("weekLastBtn")?.addEventListener("click", () => {
        setSummaryRange("lastWeek");
        syncWeekBtns();
      });

      syncWeekBtns();
      setRangeMode(window.__RANGE_MODE__ || "day");

      document.getElementById("refTypeRO")?.addEventListener("click", () => setRefType("RO"));
      document.getElementById("refTypeSTK")?.addEventListener("click", () => setRefType("STOCK"));
      setRefType(document.getElementById("refTypeSTK")?.classList.contains("active") ? "STOCK" : "RO");

      const hoursInput = $("hours");
      const rateInput  = document.querySelector('input[name="rate"]');

      if (hoursInput) {
        hoursInput.addEventListener("input", () => hoursInput.dataset.touched = "1");
        hoursInput.addEventListener("blur", () => {
          const v = round1(num(hoursInput.value));
          if (Number.isFinite(v) && v > 0) hoursInput.value = String(v);
          else if (hoursInput.value) hoursInput.value = "";
        });
      }
      if (rateInput) rateInput.addEventListener("input", () => rateInput.dataset.touched = "1");

      document.getElementById("closePhotoBtn")?.addEventListener("click", closePhotoModal);
      document.getElementById("photoModal")?.addEventListener("click", (e) => {
        if (e.target && e.target.id === "photoModal") closePhotoModal();
      });

      const logForm = document.getElementById("logForm");

      // HOTFIX: wire Save exactly once (avoid double/triple save)
      if (logForm && typeof handleSave === "function") {
        if (!logForm.dataset.saveWired) {
          logForm.dataset.saveWired = "1";

          logForm.addEventListener("submit", function (e) {
            e.preventDefault();

            // prevent re-entry (double submit)
            if (window.__saving) return;
            window.__saving = true;

            Promise.resolve(handleSave())
              .catch(() => {})
              .finally(() => { window.__saving = false; });
          });
        }
      }
      document.getElementById("clearBtn")?.addEventListener("click", handleClear);
      document.getElementById("cancelEditBtn")?.addEventListener("click", handleClear);

      // --- Rapid Log UX: toggle details + enable Save when required fields filled ---
      function updateSaveEnabled(){
        const empOk  = !!getEmpId();
        const refOk  = !!(document.getElementById("ref")?.value || "").trim();
        const typeOk = !!(document.getElementById("typeText")?.value || "").trim();
        const hrsOk  = num(document.getElementById("hours")?.value) > 0;

        const btn = document.getElementById("saveBtn");
        if (btn) btn.disabled = !(empOk && refOk && typeOk && hrsOk);
      }

      const detailsBtn = document.getElementById("toggleDetailsBtn");
      const detailsPanel = document.getElementById("detailsPanel");

      // Init collapsed
      if (detailsBtn && detailsPanel) {
        detailsPanel.style.display = "none";
        detailsBtn.textContent = "More details";

        detailsBtn.addEventListener("click", () => {
          const isOpen = detailsPanel.style.display !== "none";
          detailsPanel.style.display = isOpen ? "none" : "block";
          detailsBtn.textContent = isOpen ? "More details" : "Less";
        });
      }

      // Enable Save as user types
      ["empId","ref","typeText","hours"].forEach((id) => {
        const el = document.getElementById(id);
        el?.addEventListener("input", updateSaveEnabled);
        el?.addEventListener("change", updateSaveEnabled);
      });
      updateSaveEnabled();

      // Enter key: submit the form (NOT handleSave directly)
      // This avoids double-save and respects your existing submit handler.
      ["ref","typeText","hours"].forEach((id) => {
        document.getElementById(id)?.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const btn = document.getElementById("saveBtn");
          if (btn && !btn.disabled) btn.click(); // triggers your existing handler path
        });
      });

      document.getElementById("historyBtn")?.addEventListener("click", () => { showHistory(true); renderHistory(); });
      document.getElementById("exportCsvMainBtn")?.addEventListener("click", exportCSV);
      document.getElementById("closeHistoryBtn")?.addEventListener("click", () => showHistory(false));
      document.getElementById("histRange")?.addEventListener("change", renderHistory);
      document.getElementById("histGroup")?.addEventListener("change", renderHistory);
      document.getElementById("historySearchInput")?.addEventListener("input", () => renderHistory());

      initPhotosUI();
      initEmpIdBoot();
      wireEmpIdReload();
      await refreshUI();
      return;
    }

    // ================= MORE PAGE ONLY =================
    if (PAGE === "more") {
      const wrapMoreClick = (id, handler) => {
        const el = document.getElementById(id);
        if (!el || typeof handler !== "function") return;

        el.addEventListener("click", async (ev) => {
          try {
            const r = handler.call(el, ev);
            if (r?.then) await r;
          } catch {}
        });
      };

      wrapMoreClick("exportCsvBtn", exportCSV);
      wrapMoreClick("exportJsonBtn", exportJSON);
      wrapMoreClick("saveFlaggedBtn", saveFlaggedHours);
      wrapMoreClick("wipeBtn", wipeLocalOnly);
      document.getElementById("refreshBtn")?.addEventListener("click", () => {
        if (!_photosRequested) {
          setGalleryStatus("Tap Load Photos first.");
          return;
        }
        renderPhotoGrid(true, { updateStatus: true });
      });

      document.getElementById("wipeAllBtn")?.addEventListener("click", wipeAllData);

      document.getElementById("reviewRefreshBtn")?.addEventListener("click", renderReview);
      document.getElementById("reviewRange")?.addEventListener("change", renderReview);
      document.getElementById("reviewGroup")?.addEventListener("change", renderReview);
      document.getElementById("reviewSearch")?.addEventListener("input", () => {
        clearTimeout(window.__REVIEW_T__);
        window.__REVIEW_T__ = setTimeout(renderReview, 150);
      });

      document.getElementById("repairBtn")?.addEventListener("click", async () => {
        const empId = getEmpId();
        if (!empId) return alert("Enter Employee # first.");

        setStatusMsg("Repairing… keep this page open.");
        try {
          const fixed = await backfillDayKeysForEmpCursor(empId, { batch: 150 });
          alert(`Repair complete. Fixed ${fixed} entries.`);
        } catch (e) {
          alert("Repair failed: " + (e?.message || e));
        }
        finally {
          setStatusMsg("");
        }
      });

      initPhotosUI();
      initEmpIdBoot();
      wireEmpIdReload();
      await renderReview();
      return;
    }
  })();
});
