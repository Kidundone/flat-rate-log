function sb() {
  const cfg = window.__SUPABASE_CONFIG__;
  if (!cfg?.url || !cfg?.anonKey || !window.supabase) {
    throw new Error("Supabase config missing");
  }
  if (!window.__frtSupabase) {
    window.__frtSupabase = window.supabase.createClient(cfg.url, cfg.anonKey);
  }
  return window.__frtSupabase;
}

async function setUidFromSession(session) {
  window.CURRENT_UID = session?.user?.id || null;
  console.log("UID:", window.CURRENT_UID);
}

async function bootAuth() {
  console.log("bootAuth called");
  const { data, error } = await sb().auth.getSession();
  if (error) console.error("getSession error:", error);
  await setUidFromSession(data?.session || null);

  await initAuth();

  if (window.__AUTH_WIRED__) return;
  window.__AUTH_WIRED__ = true;

  sb().auth.onAuthStateChange(async (event, session) => {
    console.log("AUTH EVENT:", event);
    window.CURRENT_UID = session?.user?.id || null;
    await initAuth();

    if ((event === "INITIAL_SESSION" || event === "SIGNED_IN") && window.CURRENT_UID) {
      console.log("↩️ Loading entries after auth...");

      try {
        const rows = await safeLoadEntries();
        console.log("✅ safeLoadEntries returned:", rows?.length);

        if (window.__PAGE__ === "main") {
          await refreshUI(rows);
          console.log("✅ refreshUI complete");
        }
      } catch (e) {
        console.error("💥 LOAD FAILED:", e);
      }
    }
  });
}

async function initAuth() {
  const signedIn = !!window.CURRENT_UID;
  const statusEl  = document.getElementById("authStatus");
  const formEl    = document.getElementById("authForm");
  const signedInEl = document.getElementById("authSignedIn");
  const outBtn    = document.getElementById("authSignOut");

  if (statusEl) statusEl.textContent = signedIn ? "Signed in" : "";

  if (formEl)      formEl.style.display      = signedIn ? "none" : "";
  if (signedInEl)  signedInEl.style.display  = signedIn ? ""     : "none";
  if (outBtn)      outBtn.style.display       = signedIn ? ""     : "none";

  const nudge = document.getElementById("cloudNudge");
  if (nudge) nudge.style.display = signedIn ? "none" : "";
}

async function signIn(email, password) {
  const { error } = await sb().auth.signInWithPassword({
    email,
    password
  });

  if (error) return alert(error.message);
}

function wireAuthUI() {
  const client = sb();
  const emailEl = document.getElementById("authEmail");
  const passEl  = document.getElementById("authPassword");

  const signUpBtn = document.getElementById("authSignUp");
  const signInBtn = document.getElementById("authSignIn");
  const resetBtn  = document.getElementById("authReset");
  const outBtn    = document.getElementById("authSignOut");
  const statusEl  = document.getElementById("authStatus");

  if (!statusEl) return;

  signUpBtn?.addEventListener("click", async () => {
    const email = emailEl.value.trim();
    const password = passEl.value.trim();
    if (!email || !password) return alert("Email and password required");

    const { error } = await client.auth.signUp({ email, password });
    if (error) return alert(error.message);

    alert("Account created. You can now sign in.");
  });

  signInBtn?.addEventListener("click", async () => {
    const email = emailEl.value.trim();
    const password = passEl.value.trim();
    if (!email || !password) return alert("Email and password required");
    await signIn(email, password);
  });

  resetBtn?.addEventListener("click", async () => {
    const email = emailEl.value.trim();
    if (!email) return alert("Enter your email");

    const { error } = await client.auth.resetPasswordForEmail(email);
    if (error) return alert(error.message);

    alert("Password reset email sent.");
  });

  outBtn?.addEventListener("click", async () => {
    await client.auth.signOut();
    await initAuth();
  });

}

async function sbListRows(empId) {
  if (!empId) return [];
  const uid = await requireUserId(sb());
  if (!uid) return [];

  let q = sb()
    .from("work_logs")
    .select("*")
    .eq("user_id", uid)
    .eq("employee_number", empId)
    .or("is_deleted.is.null,is_deleted.eq.false");

  q = q
    .order("work_date", { ascending: false })
    .order("created_at", { ascending: false });
  const { data, error } = await q;

  if (error) throw error;
  return data || [];
}

async function probeEmpHasRows(empId) {
  if (!empId) return false;
  const uid = await requireUserId(sb());
  if (!uid) return false;
  const { count, error } = await sb()
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
  const { error } = await sb().storage.from(PHOTO_BUCKET).remove([photoPath]);
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

function isMissingColumnError(err, columnName) {
  const msg = `${err?.message || ""} ${err?.details || ""} ${err?.hint || ""}`.toLowerCase();
  return msg.includes(String(columnName || "").toLowerCase())
    && (msg.includes("column") || msg.includes("does not exist") || msg.includes("schema cache"));
}

function isDealerColumnMissingError(err) {
  return isMissingColumnError(err, "dealer");
}

async function updateWorkLogWithFallback(sbClient, logId, patch) {
  const body = { ...(patch || {}) };
  while (Object.keys(body).length > 0) {
    const { error } = await sbClient
      .from("work_logs")
      .update(body)
      .eq("id", logId);

    if (!error) return true;
    const missingField = Object.keys(body).find((k) => isMissingColumnError(error, k));
    if (!missingField) throw error;
    delete body[missingField];
  }
  return false;
}

async function saveEditedLog(logId, patch) {
  const empId = getEmpId();
  const file = getSelectedPhotoFile();
  if (file) {
    const uploaded = await uploadProofPhoto({
      sb: sb(),
      empId,
      logId,
      file,
      roNumber: patch.ro_number || null,
    });
    const newPath = uploaded?.path || null;
    patch.photo_path = newPath;
  }

  const runUpdate = (body) => sb()
    .from("work_logs")
    .update(body)
    .eq("id", logId)
    .select("id, photo_path")
    .maybeSingle();

  const { data, error } = await runUpdate(patch);
  if (error) throw error;

  window.SELECTED_PHOTO_FILE = null;
  SELECTED_PHOTO_FILE = null;
  const input = document.querySelector("#photoInput, input[type=file][data-photo]");
  if (input) input.value = "";

  return data;
}

async function sbProofPhotoUrl(photoPath) {
  return getSignedPhotoUrl(photoPath);
}

async function getPhotoUrl(photoPath) {
  return getSignedPhotoUrl(photoPath);
}

async function listEntriesWithPhotos(limit = 100) {
  const { data, error } = await sb()
    .from("work_logs")
    .select("*")
    .not("photo_path", "is", null)
    .order("id", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}


async function getSignedPhotoUrl(photoPath, expiresIn = 1800) {
  const { data, error } = await sb()
    .storage
    .from("proofs")
    .createSignedUrl(photoPath, expiresIn);

  if (error) throw error;
  return data?.signedUrl || null;
}

const LS_EMP = "fr_emp_id";

function getEmpId() {
  const raw =
    (document.getElementById("empId")?.value || localStorage.getItem("fr_emp_id") || "")
      .trim();

  // digits only
  const digits = raw.replace(/\D/g, "");

  if (!digits) return "";

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
    dealer: payload.dealer || null,
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
  const uid = await requireUserId(sb());
  if (!uid) return [];
  return sbListRows(empId);
}

// CREATE
async function apiCreateLog(payload, sourceEntry = null) {
  const uid = await requireUserId(sb());
  if (!uid) throw new Error("Sign in required");
  const empId = String(document.getElementById("empId").value || "").trim();
  if (!empId) throw new Error("Employee # required");

  const insertRow = {
    user_id: uid,
    employee_number: empId,
    work_date: payload.work_date,
    category: payload.category || "work",
    ro_number: payload.ro_number || null,
    dealer: payload.dealer || null,
    description: payload.description || null,
    flat_hours: Number(payload.flat_hours || 0),
    cash_amount: Number(payload.cash_amount || 0),
    location: payload.location || null,
    vin8: payload.vin8 || null,
    is_deleted: false,
    photo_path: null,
  };

  // 1) Create row first (no photo_path yet)
  let created = null;
  let e1 = null;
  let insertBody = { ...insertRow };
  while (Object.keys(insertBody).length > 0) {
    ({ data: created, error: e1 } = await sb()
      .from("work_logs")
      .insert([insertBody])
      .select("id,photo_path")
      .maybeSingle());
    if (!e1) break;

    const missingField = Object.keys(insertBody).find((k) => isMissingColumnError(e1, k));
    if (!missingField) break;
    delete insertBody[missingField];
  }

  if (e1) throw e1;
  const createdRow = created ?? null;
  if (!createdRow) throw new Error("Create failed: no row returned");

  return createdRow;
}

// UPDATE
async function apiUpdateLog(id, payload) {
  const empId = getEmpId();
  if (!empId) return null;
  const uid = await requireUserId(sb());
  if (!uid) return null;

  const updateFields = {
    work_date: payload.work_date,
    category: payload.category || "work",
    ro_number: payload.ro_number || null,
    description: payload.description || null,
    flat_hours: Number(payload.flat_hours || 0),
    cash_amount: Number(payload.cash_amount || 0),
    location: payload.location || null,
    vin8: payload.vin8 || null,
    updated_at: new Date().toISOString(),
  };

  // Update fields first
  let { data: updated, error: e1 } = await sb()
    .from("work_logs")
    .update(updateFields)
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
  const uid = window.CURRENT_UID;
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
    await softDeleteLog(sb(), id);
    LAST_DELETED = { id, at: Date.now() };

    const next = (Array.isArray(CURRENT_ENTRIES) ? CURRENT_ENTRIES : [])
      .filter((x) => String(x.id) !== String(id));
    await renderEntries(next);

    showUndoBar({
      text: "Entry deleted.",
      onUndo: async () => {
        await undoSoftDeleteLog(sb(), id);
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
    await undoSoftDeleteLog(sb(), LAST_DELETED.id);
    LAST_DELETED = null;

    if (window.__FR?.safeLoadEntries) await window.__FR.safeLoadEntries();
    else await safeLoadEntries();
    const bar = document.getElementById("undoBar");
    if (bar) bar.style.display = "none";
  } catch (e) {
    console.error("UNDO FAILED", e);
    alert("Undo failed: " + (e?.message || e));
  }
}

let CURRENT_ENTRIES = [];
window.STATE = window.STATE || {};
if (!Array.isArray(window.STATE.entries)) window.STATE.entries = [];

function syncStateEntries(entries) {
  window.STATE = window.STATE || {};
  window.STATE.entries = normalizeEntries(Array.isArray(entries) ? entries : []);
  return window.STATE.entries;
}

function normalizeEntryForApi(entry) {
  const roNumber = entry.ro || entry.ro_number || entry.ref || null;
  // Map the UI entry object into the active Supabase work_logs schema.
  return {
    work_date: entry.dayKey || entry.date || entry.work_date || (entry.createdAt ? dayKeyFromISO(entry.createdAt) : null), // MUST be "YYYY-MM-DD"
    category: entry.typeText || entry.type || entry.category || "work",
    ro_number: roNumber,
    dealer: entry.dealer || null,
    description: entry.notes || entry.desc || entry.description || null,
    flat_hours: Number(entry.hours || entry.flat || entry.flat_hours || 0),
    cash_amount: Number(entry.earnings || entry.cash || entry.cash_amount || 0),
    location: entry.location || null,
    vin8: entry.vin8 || null,
    photo_path: entry.photo_path || entry.photoPath || null,
    is_comeback: entry.isComeback || false,
  };
}

function normalizeToken(value) {
  return String(value || "").trim().toUpperCase();
}

function inferRefTypeFromLog(log) {
  const explicit = normalizeToken(log?.refType || log?.ref_type);
  if (explicit === "STOCK") return "STOCK";

  const currentRef = normalizeToken(log?.ro_number || log?.ref || log?.ro);
  const liveStock = normalizeToken(log?.stock);
  if (!currentRef && liveStock) return "STOCK";

  return "RO";
}

function normalizeSupabaseLog(r) {
  const refType = inferRefTypeFromLog(r);
  const entry = {
    id: r.id,
    work_date: r.work_date,
    created_at: r.created_at,
    updated_at: r.updated_at,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,

    // UI expects these names (based on your form)
    refType,
    ref: r.ro_number ?? r.stock ?? "",
    ro_number: r.ro_number ?? "",
    ro: r.ro_number ?? "",
    stock: r.stock ?? "",
    dealer: r.dealer ?? null,
    brand: r.brand ?? "Unmapped",
    store: r.store ?? null,
    campus: r.campus ?? null,

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
    vin: r.vin ?? "",
    vin8: r.vin8 ?? "",
    photo_path: r.photo_path ?? null,

    owner_key: r.owner_key ?? null,
    employee_number: r.employee_number ?? null,
    is_deleted: r.is_deleted ?? false,
    isComeback: r.is_comeback ?? false,
  };

  return entry;
}

function mapServerLogToEntry(r) {
  const createdAt = r.created_at || new Date().toISOString();
  const dayKey = r.work_date; // already YYYY-MM-DD
  const hours = Number(r.flat_hours ?? r.hours ?? 0);
  const rate = getDefaultRate();
  const ref = r.ro_number || r.stock || r.ref || r.ro || "";
  const refType = inferRefTypeFromLog(r);

  return {
    id: r.id, // do NOT generate uuid() or local ID
    empId: getEmpId(),
    createdAt,
    updatedAt: r.updated_at || r.updatedAt || createdAt,
    createdAtMs: Date.parse(createdAt) || Date.now(),
    dayKey,
    weekStartKey: dateKey(startOfWeekLocal(new Date(dayKey))),
    refType,
    ref,
    ro: r.ro_number || "",
    ro_number: r.ro_number || "",
    stock: r.stock || "",
    dealer: r.dealer || "UNKNOWN",
    brand: r.brand || null,
    store: r.store || r.store_code || null,
    store_code: r.store_code || r.store || null,
    campus: r.campus || null,
    classMatched: r.classMatched || null,
    vin: r.vin || "",
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

async function safeLoadEntries() {
  if (!window.CURRENT_UID) {
    console.warn("No UID - skipping loadEntries");
    return [];
  }

  const emp = getEmpId();
  if (!emp) {
    console.warn("No employee number - skipping loadEntries");
    return [];
  }

  try {
    const rows = await loadEntries();
    return rows;
  } catch (e) {
    console.error("loadEntries failed:", e);
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
}
function wireEmpIdReload() {
  const el = document.getElementById("empId");
  if (!el) return;

  const maybeReload = () => {
    const digits = (el.value || "").trim().replace(/\D/g, "");
    if (digits.length >= 5) {
      localStorage.setItem("fr_emp_id", digits);
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
  return backfillDayKeysForEmp(empId);
}

async function renderLogs(logs) {
  const entries = Array.isArray(logs) ? normalizeEntries(logs) : [];

  await refreshUI(entries);
}

async function renderEntries(rows) {
  const mapped = (rows || []).map(mapServerLogToEntry);
  CURRENT_ENTRIES = syncStateEntries(mapped);
  await renderLogs(mapped);
  return mapped;
}

async function loadEntries() {
  const empId = getEmpId();
  if (!empId) {
    console.warn("No employee number set. Returning empty.");
    return [];
  }

  const uid = await requireUserId(sb());
  if (!uid) {
    console.warn("No UID - skipping loadEntries");
    return [];
  }

  let query = sb()
    .from("work_logs")
    .select("*")
    .eq("user_id", uid)
    .eq("employee_number", empId)
    .or("is_deleted.is.null,is_deleted.eq.false");

  const res = await query
    .order("work_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (res.error) throw res.error;

  const rows = (res.data || []).map(normalizeSupabaseLog);
  return await renderEntries(rows);
}

/* ── Offline pending sync queue ──────────────────────────────────── */
const LS_PENDING = "fr_pending_sync";

function getPendingQueue() {
  try { return JSON.parse(localStorage.getItem(LS_PENDING) || "[]"); } catch { return []; }
}

function setPendingQueue(q) {
  localStorage.setItem(LS_PENDING, JSON.stringify(q || []));
}

function queuePendingEntry(entry, payload) {
  const q = getPendingQueue();
  q.push({ id: String(entry.id), entry, payload, queuedAt: new Date().toISOString() });
  setPendingQueue(q);
  updatePendingBadge();
}

function removePendingById(id) {
  setPendingQueue(getPendingQueue().filter(x => x.id !== String(id)));
  updatePendingBadge();
}

function updatePendingBadge() {
  const count = getPendingQueue().length;
  const el = document.getElementById("offlineBanner");
  if (!el) return;
  if (count > 0) {
    el.textContent = `${count} offline entr${count === 1 ? "y" : "ies"} waiting to sync`;
    el.style.display = "";
  } else if (!navigator.onLine) {
    el.textContent = "You're offline — entries may not save";
    el.style.display = "";
  } else {
    el.style.display = "none";
  }
}
