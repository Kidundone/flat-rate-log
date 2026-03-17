const PHOTO_BUCKET = "proofs"; // private

function setPhotoUploadTarget(path) {
  const bucketEl = document.getElementById("photoBucketName");
  if (bucketEl) bucketEl.textContent = PHOTO_BUCKET;
  const pathEl = document.getElementById("photoPathPreview");
  if (pathEl) pathEl.textContent = path || "—";
}

async function requireUserId(sb) {
  const uid = window.CURRENT_UID;
  if (!uid) return null;
  return uid;
}

async function getProofSignedUrl(sb, photoPath) {
  const { data, error } = await sb.storage
    .from("proofs")
    .createSignedUrl(photoPath, 60);

  if (error) throw error;
  return data.signedUrl;
}

async function uploadProofPhoto({ sb, empId, logId, file, roNumber = null }) {
  const uid = await requireUserId(sb);
  if (!uid) throw new Error("Sign in required");

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
  const dealerGuess = await classifyDealerUniversal({
    ro: roNumber || null,
    stock: null,
    vin: null,
  });
  const resolvedDealer = dealerGuess && dealerGuess !== "Unknown" ? dealerGuess : null;

  if (resolvedDealer) {
    try {
      await updateWorkLogWithFallback(sb, logId, {
        dealer: resolvedDealer,
        updated_at: new Date().toISOString(),
      });
    } catch (dealerErr) {
      console.error("Dealer seed update failed", dealerErr);
    }
  }

  // Run OCR classification in background; do not block photo upload/save flow.
  runOCRAndClassify({
    id: logId,
    ro_number: roNumber || null,
    photo_path: path,
  }).catch((ocrErr) => console.error("OCR failed:", ocrErr));

  return { path, dealer: resolvedDealer };
}

async function runOCR(photoPath) {
  if (!photoPath) return "";
  if (OCR_TEXT_CACHE.has(photoPath)) return OCR_TEXT_CACHE.get(photoPath);

  const signedUrl = await getProofSignedUrl(sb, photoPath);
  const tesseract = window.Tesseract;
  let ocrText = "";

  if (tesseract?.recognize) {
    const result = await tesseract.recognize(signedUrl, "eng");
    ocrText = result?.data?.text || "";
  } else if (tesseract?.createWorker) {
    const created = await tesseract.createWorker("eng");
    const worker = created?.data || created;
    try {
      const result = await worker.recognize(signedUrl);
      ocrText = result?.data?.text || "";
    } finally {
      await worker.terminate();
    }
  } else {
    throw new Error("Tesseract not available");
  }

  OCR_TEXT_CACHE.set(photoPath, ocrText);
  return ocrText;
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

async function entryPhotoUrl(entry) {
  return getPhotoUrl(entry?.photo_path);
}

function entryHasPhoto(entry) {
  return !!entry?.photo_path;
}

async function getRecentPhotoEntriesByEmp(empId, limit = 24) {
  const id = String(empId || "").trim();
  if (!id) return [];
  const all = normalizeEntries(Array.isArray(CURRENT_ENTRIES) ? CURRENT_ENTRIES : []);
  return all
    .filter((e) => String(e?.empId || "").trim() === id && entryHasPhoto(e))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .slice(0, limit);
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
