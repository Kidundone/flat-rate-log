const SUPABASE_URL = "https://lfnydhidbwfyfjafazdy.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmbnlkaGlkYndmeWZqYWZhemR5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgzNTk0MDYsImV4cCI6MjA4MzkzNTQwNn0.ES4tEeUgtTrPjYR64SGHDeQJps7dFdTmF7IRUhPZwt4";
const STOCK_PREFIX_RULES = [];
const OCR_TEXT_CACHE = new Map();
const OCR_CLASSIFICATION_CACHE = new Map();

function getStockPrefixRules() {
  if (Array.isArray(window.STOCK_PREFIX_RULES)) return window.STOCK_PREFIX_RULES;
  if (typeof STOCK_PREFIX_RULES !== "undefined" && Array.isArray(STOCK_PREFIX_RULES)) return STOCK_PREFIX_RULES;
  return [];
}

function unmappedClassification() {
  return {
    brand: "Unmapped",
    store: null,
    campus: null,
    matched_on: null,
  };
}

async function lookupPatternMappings(patterns) {
  for (const p of (patterns || [])) {
    const { data } = await sb()
      .from("pattern_mappings")
      .select("*")
      .eq("pattern_type", p.type)
      .eq("pattern_value", p.value)
      .maybeSingle();

    if (data) {
      return {
        brand: data.brand,
        store: data.store,
        campus: data.campus,
        matched_on: p.matched_on || `${p.type}:${p.value}`,
      };
    }
  }

  return null;
}

function extractStructuredPatterns({ ro, stock, vin }) {
  const patterns = [];

  if (vin && String(vin).length >= 3) {
    patterns.push({
      type: "VIN",
      value: String(vin).slice(0, 3).toUpperCase(),
    });
  }

  if (stock) {
    const prefix = String(stock).replace(/[^A-Z]/gi, "").slice(0, 3).toUpperCase();
    if (prefix) {
      patterns.push({
        type: "STK",
        value: prefix,
      });
    }
  }

  if (ro) {
    const prefix = String(ro).replace(/[^A-Z]/gi, "").slice(0, 1).toUpperCase();
    if (prefix) {
      patterns.push({
        type: "RO",
        value: prefix,
      });
    }
  }

  return patterns;
}

async function classifyEntryUniversal({ ro, stock, vin }) {
  const patterns = extractStructuredPatterns({ ro, stock, vin });
  const classification = await lookupPatternMappings(patterns);
  return classification || unmappedClassification();
}

function extractOcrPatterns(ocrText) {
  const upper = String(ocrText || "").toUpperCase();
  const out = [];
  const seen = new Set();
  const add = (type, value, matched_on = null) => {
    const v = String(value || "").toUpperCase().trim();
    if (!v) return;
    const key = `${type}:${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type, value: v, matched_on: matched_on || key });
  };

  const vinHits = upper.match(/[A-HJ-NPR-Z0-9]{17}/g) || [];
  for (const token of vinHits.slice(0, 3)) {
    const wmi = token.slice(0, 3);
    add("VIN", wmi, `OCR:VIN:${wmi}`);
  }

  const words = upper.match(/[A-Z0-9]{3,}/g) || [];
  for (const token of words.slice(0, 24)) {
    const letters = token.replace(/[^A-Z]/g, "");
    if (letters.length >= 3) {
      const prefix = letters.slice(0, 3);
      add("STK", prefix, `OCR:STK:${prefix}`);
    }
  }

  return out;
}

async function classifyEntryFromOCR(ocrText) {
  const patterns = extractOcrPatterns(ocrText);
  if (!patterns.length) return unmappedClassification();
  const classification = await lookupPatternMappings(patterns);
  return classification || unmappedClassification();
}

async function classifyEntryWithFallback({ ro, stock, vin, photoPath }) {
  let classification = await classifyEntryUniversal({ ro, stock, vin });

  if (classification.brand !== "Unmapped") {
    return classification;
  }

  if (!photoPath) {
    return classification;
  }

  if (OCR_CLASSIFICATION_CACHE.has(photoPath)) {
    return OCR_CLASSIFICATION_CACHE.get(photoPath);
  }

  try {
    const ocrText = await runOCR(photoPath);
    if (!ocrText) return classification;
    const retry = await classifyEntryFromOCR(ocrText);
    if (retry.brand !== "Unmapped") {
      classification = retry;
      OCR_CLASSIFICATION_CACHE.set(photoPath, classification);
    }
  } catch (err) {
    console.error("OCR fallback classification failed", err);
  }

  return classification;
}

async function classifyDealerUniversal({ ro, stock, vin, photoPath }) {
  const classification = await classifyEntryWithFallback({ ro, stock, vin, photoPath });
  if (!classification || classification.brand === "Unmapped") return "Unknown";
  return classification.brand;
}

const GENERIC_PREFIX_BRAND = Object.freeze({
  A: "Acura",
  B: "Audi",
  C: "Chevrolet",
  F: "Ford",
  H: "Honda",
  K: "Kia",
  L: "Lexus",
  M: "Mazda",
  N: "Nissan",
  S: "Subaru",
  T: "Toyota",
  V: "Volkswagen",
});

const SPECIAL_PREFIX_RULES = Object.freeze([
  { prefix: "SL", type: "Service Loaner" },
  { prefix: "XS", type: "Dealer Trade - New" },
  { prefix: "DT", type: "Dealer Trade" },
  { prefix: "P", type: "Curb Purchase" },
]);

let USER_PREFIX_RULES = [];

async function loadUserPrefixRules() {
  const { data, error } = await sb()
    .from("dealer_prefix_rules")
    .select("*");

  if (error) {
    console.error("Failed loading rules", error);
    return [];
  }

  return (data || []).sort((a,b)=>b.prefix.length - a.prefix.length);
}

function normalizeStock(stock) {
  if (!stock) return null;

  const clean = stock.toUpperCase().replace(/[^A-Z0-9]/g, "");

  // Handle reused stock ending in A
  if (clean.length > 2 && clean.endsWith("A")) {
    return clean.slice(0, -1);
  }

  return clean;
}

function classifyStock(stock, rules) {
  if (!stock) return null;

  const normalized = normalizeStock(stock);
  if (!normalized) return null;

  for (const rule of (rules || [])) {
    if (normalized.startsWith(rule.prefix.toUpperCase())) {
      return {
        brand: rule.brand || "Unknown",
        vehicle_type: rule.vehicle_type || "Unknown",
        prefix: rule.prefix
      };
    }
  }

  return null;
}

const BRAND_KEYWORDS = Object.freeze([
  { match: ["VOLKSWAGEN", "VW"], brand: "Volkswagen" },
  { match: ["AUDI"], brand: "Audi" },
  { match: ["SUBARU"], brand: "Subaru" },
  { match: ["ACURA"], brand: "Acura" },
  { match: ["HONDA"], brand: "Honda" },
  { match: ["TOYOTA"], brand: "Toyota" },
  { match: ["FORD"], brand: "Ford" },
  { match: ["CHEVROLET", "CHEVY"], brand: "Chevrolet" },
  { match: ["NISSAN"], brand: "Nissan" },
  { match: ["BMW"], brand: "BMW" },
  { match: ["JEEP"], brand: "Jeep" },
  { match: ["RAM"], brand: "Ram" },
  { match: ["KIA"], brand: "Kia" },
  { match: ["HYUNDAI"], brand: "Hyundai" },
  { match: ["LEXUS"], brand: "Lexus" },
  { match: ["MAZDA"], brand: "Mazda" },
  { match: ["GMC"], brand: "GMC" },
]);

function detectBrandFromText(text) {
  if (!text) return null;

  const upper = String(text).toUpperCase();

  for (const rule of BRAND_KEYWORDS) {
    for (const keyword of rule.match) {
      if (upper.includes(keyword)) {
        return rule.brand;
      }
    }
  }

  return null;
}

function detectFromStock(stockNumber) {
  if (!stockNumber) return null;

  const clean = normalizeStock(stockNumber);
  if (!clean) return null;
  const rules = (USER_PREFIX_RULES.length ? USER_PREFIX_RULES : getStockPrefixRules())
    .slice()
    .sort((a, b) => b.prefix.length - a.prefix.length);

  for (const rule of rules) {
    const prefix = String(rule.prefix || "").toUpperCase();
    if (prefix && clean.startsWith(prefix)) {
      const brand = rule.brand !== "Unknown" ? rule.brand : null;
      const type = rule.type || rule.vehicle_type || "Unknown";
      return { brand, type };
    }
  }

  for (const rule of SPECIAL_PREFIX_RULES) {
    const prefix = String(rule.prefix || "").toUpperCase();
    if (!prefix) continue;
    if (clean.startsWith(prefix) || clean.slice(1).startsWith(prefix)) {
      const firstChar = clean.charAt(0);
      const genericBrand = GENERIC_PREFIX_BRAND[firstChar] || null;
      return { brand: genericBrand, type: rule.type || "Unknown" };
    }
  }

  const firstChar = clean.charAt(0);
  const genericBrand = GENERIC_PREFIX_BRAND[firstChar] || null;
  if (genericBrand) {
    return { brand: genericBrand, type: "Unknown" };
  }

  return null;
}

function detectBrand({ ro = "", stock = "", ocrText = "" }) {
  const stockHit = detectFromStock(stock || ro);
  if (stockHit?.brand) return stockHit.brand;

  const textHit = detectBrandFromText(ocrText);
  if (textHit) return textHit;

  return "Unknown";
}

function normalizeText(s = "") {
  return String(s)
    .replace(/\r/g, "\n")
    .replace(/[|]/g, "I")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

function up(s = "") {
  return String(s || "").toUpperCase().trim();
}

function last8(vin = "") {
  const clean = up(vin).replace(/[^A-Z0-9]/g, "");
  return clean.length >= 8 ? clean.slice(-8) : "";
}

const OCR_HEADER_REGION = Object.freeze({ x: 0.03, y: 0.02, width: 0.94, height: 0.18 });
const OCR_TEMPLATES = Object.freeze({
  ro: {
    vin: { x: 900, y: 120, width: 700, height: 120 },
    stock: { x: 1080, y: 320, width: 420, height: 120 },
  },
  get_ready: {
    stock: { x: 220, y: 150, width: 260, height: 90 },
    vin6: { x: 540, y: 150, width: 260, height: 90 },
  },
});
const OCR_MIN_IMAGE_WIDTH = 800;
const OCR_MIN_BRIGHTNESS = 38;
const OCR_MIN_EDGE_SCORE = 10;
const OCR_QUALITY_SAMPLE_MAX = 256;
let OCR_WORKER_PROMISE = null;
let OCR_WORKER_QUEUE = Promise.resolve();

function detectSheetType(text) {
  const t = up(text);
  if (t.includes("NEW - PRE-OWNED GET READY") || t.includes("GET READY")) return "get_ready";
  if (t.includes("WORKORDER") || t.includes("FLOW MOTORS OF WINSTON-SALEM")) return "ro";
  return "unknown";
}

function extractVin(text) {
  const upper = up(text);
  const matches = upper.match(/[A-HJ-NPR-Z0-9]{17}/g) || [];
  if (matches[0]) return matches[0];
  const compact = upper.replace(/[^A-HJ-NPR-Z0-9]/g, "");
  const compactMatches = compact.match(/[A-HJ-NPR-Z0-9]{17}/g) || [];
  if (compactMatches[0]) return compactMatches[0];
  return "";
}

function extractBareStock(text) {
  const ignore = new Set([
    "STK",
    "STOCK",
    "VIN",
    "LAST",
    "MILES",
    "SALESPERSON",
    "GET",
    "READY",
    "WORKORDER",
    "FLOW",
    "MOTORS",
    "OF",
    "WINSTON",
    "SALEM",
  ]);
  const tokens = (up(text).match(/[A-Z0-9]{3,12}/g) || [])
    .filter((token) => !ignore.has(token))
    .sort((a, b) => {
      const score = (token) => {
        let total = 0;
        if (/[0-9]/.test(token)) total += 4;
        if (/[A-Z]/.test(token)) total += 2;
        if (/^[A-Z0-9]+$/.test(token)) total += 1;
        return total;
      };
      return score(b) - score(a);
    });
  return tokens[0] || "";
}

function extractLast6(text) {
  const compact = up(text).replace(/[^A-Z0-9]/g, "");
  const matches = compact.match(/[A-Z0-9]{6}/g) || [];
  return matches[0] || "";
}

function extractStockFromRo(text) {
  const patterns = [
    /STK[:\s#-]*([A-Z0-9]{3,12})/i,
    /STOCK[:\s#-]*([A-Z0-9]{3,12})/i,
  ];
  for (const rx of patterns) {
    const m = text.match(rx);
    if (m?.[1]) return up(m[1]);
  }
  return extractBareStock(text);
}

function extractStockFromGetReady(text) {
  const patterns = [
    /STOCK\s*#\s*([A-Z0-9]{3,12})/i,
    /MILES\s+([A-Z0-9]{3,12})\s+SALESPERSON/i,
  ];
  for (const rx of patterns) {
    const m = text.match(rx);
    if (m?.[1]) return up(m[1]);
  }
  return extractBareStock(text);
}

function extractVinLast6FromGetReady(text) {
  const patterns = [
    /VIN\s*\(LAST\s*6\)\s*([A-Z0-9]{6})/i,
    /VIN\s+LAST\s*6\s+([A-Z0-9]{6})/i,
  ];
  for (const rx of patterns) {
    const m = text.match(rx);
    if (m?.[1]) return up(m[1]);
  }
  return extractLast6(text);
}

function parseRoText(text) {
  const vin = extractVin(text);
  const stock = extractStockFromRo(text);

  return {
    sheet_type: "ro",
    stock_suggestion: stock || null,
    vin_suggestion: vin || null,
    vin8_suggestion: vin ? last8(vin) : null,
    work_suggestion: null,
    confidence: vin || stock ? 0.9 : 0.15,
  };
}

function parseGetReadyText(text) {
  const stock = extractStockFromGetReady(text);
  const vinLast6 = extractVinLast6FromGetReady(text);

  return {
    sheet_type: "get_ready",
    stock_suggestion: stock || null,
    vin_suggestion: null,
    vin8_suggestion: vinLast6 || null,
    work_suggestion: null,
    confidence: stock || vinLast6 ? 0.85 : 0.2,
  };
}

function parseUnknownText(text) {
  const vin = extractVin(text);
  const stock = extractStockFromRo(text) || extractStockFromGetReady(text);

  return {
    sheet_type: "unknown",
    stock_suggestion: stock || null,
    vin_suggestion: vin || null,
    vin8_suggestion: vin ? last8(vin) : null,
    work_suggestion: null,
    confidence: vin || stock ? 0.5 : 0.1,
  };
}

async function ensureImageBlob(imageUrlOrBlob) {
  if (!imageUrlOrBlob) throw new Error("OCR image missing");
  if (imageUrlOrBlob instanceof Blob) {
    if (!imageUrlOrBlob.size) throw new Error("OCR image missing");
    return imageUrlOrBlob;
  }
  if (typeof imageUrlOrBlob === "string") {
    try {
      const res = await fetch(imageUrlOrBlob);
      if (!res.ok) throw new Error("OCR image missing");
      const blob = await res.blob();
      if (!blob?.size) throw new Error("OCR image missing");
      return blob;
    } catch (err) {
      throw new Error("OCR image missing");
    }
  }
  throw new Error("Unsupported OCR image source");
}

async function assertUsableOcrImage(imageBlob) {
  if (!(imageBlob instanceof Blob) || !imageBlob.size) {
    throw new Error("OCR image missing");
  }

  const bitmap = await createImageBitmap(imageBlob);
  try {
    if (bitmap.width < OCR_MIN_IMAGE_WIDTH) {
      throw new Error("Image too small");
    }

    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, OCR_QUALITY_SAMPLE_MAX / longest);
    const sampleWidth = Math.max(32, Math.round(bitmap.width * scale));
    const sampleHeight = Math.max(32, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;

    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!ctx) throw new Error("Image analysis unavailable");
    ctx.drawImage(bitmap, 0, 0, sampleWidth, sampleHeight);

    const imageData = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
    const px = imageData.data;
    const luma = new Float32Array(sampleWidth * sampleHeight);
    let brightnessSum = 0;

    for (let i = 0, p = 0; i < px.length; i += 4, p += 1) {
      const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      luma[p] = y;
      brightnessSum += y;
    }

    const brightness = brightnessSum / luma.length;
    if (brightness < OCR_MIN_BRIGHTNESS) {
      throw new Error("Image too dark");
    }

    let edgeSum = 0;
    let edgeCount = 0;
    for (let y = 0; y < sampleHeight - 1; y += 1) {
      for (let x = 0; x < sampleWidth - 1; x += 1) {
        const idx = y * sampleWidth + x;
        edgeSum += Math.abs(luma[idx] - luma[idx + 1]);
        edgeSum += Math.abs(luma[idx] - luma[idx + sampleWidth]);
        edgeCount += 2;
      }
    }

    const edgeScore = edgeCount ? edgeSum / edgeCount : 0;
    if (edgeScore < OCR_MIN_EDGE_SCORE) {
      throw new Error("Image too blurry");
    }
  } finally {
    bitmap.close?.();
  }
}

function resolveCropRegion(region, width, height) {
  const scale = (value, total) => {
    if (!Number.isFinite(Number(value))) return 0;
    const n = Number(value);
    return n > 0 && n <= 1 ? Math.round(n * total) : Math.round(n);
  };

  const x = Math.max(0, Math.min(width - 1, scale(region?.x, width)));
  const y = Math.max(0, Math.min(height - 1, scale(region?.y, height)));
  const w = Math.max(1, Math.min(width - x, scale(region?.width, width)));
  const h = Math.max(1, Math.min(height - y, scale(region?.height, height)));

  return { x, y, width: w, height: h };
}

async function cropBlobToRegion(fileOrBlob, region) {
  const bitmap = await createImageBitmap(fileOrBlob);
  try {
    const rect = resolveCropRegion(region, bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Crop canvas unavailable");

    ctx.drawImage(
      bitmap,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height
    );

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85)
    );
    if (!blob) throw new Error("Crop blob failed");
    return blob;
  } finally {
    bitmap.close?.();
  }
}

async function getOcrWorker() {
  if (!window.Tesseract?.createWorker) {
    throw new Error("Tesseract worker unavailable");
  }
  if (!OCR_WORKER_PROMISE) {
    OCR_WORKER_PROMISE = window.Tesseract.createWorker("eng");
  }
  return OCR_WORKER_PROMISE;
}

function enqueueOcrWorkerJob(job) {
  const next = OCR_WORKER_QUEUE
    .catch(() => {})
    .then(job);
  OCR_WORKER_QUEUE = next.catch(() => {});
  return next;
}

async function recognizeCrop(imageBlob, region) {
  const crop = await cropBlobToRegion(imageBlob, region);
  const result = await enqueueOcrWorkerJob(async () => {
    const worker = await getOcrWorker();
    return worker.recognize(crop);
  });
  return normalizeText(result?.data?.text || "");
}

function combineOcrText(parts) {
  return normalizeText((parts || []).filter(Boolean).join("\n"));
}

async function runRoFieldOcr(imageBlob, headerText = "") {
  const vinText = await recognizeCrop(imageBlob, OCR_TEMPLATES.ro.vin);
  const stockText = await recognizeCrop(imageBlob, OCR_TEMPLATES.ro.stock);
  const combined = combineOcrText([headerText, `VIN ${vinText}`, `STK ${stockText}`]);
  const vin = extractVin(vinText) || extractVin(combined);
  const stock = extractStockFromRo(stockText) || extractStockFromRo(combined);

  return {
    raw_text: combined,
    sheet_type: "ro",
    stock_suggestion: stock || null,
    vin_suggestion: vin || null,
    vin8_suggestion: vin ? last8(vin) : null,
    work_suggestion: null,
    confidence: vin || stock ? 0.9 : 0.15,
  };
}

async function runGetReadyFieldOcr(imageBlob, headerText = "") {
  const stockText = await recognizeCrop(imageBlob, OCR_TEMPLATES.get_ready.stock);
  const vinLast6Text = await recognizeCrop(imageBlob, OCR_TEMPLATES.get_ready.vin6);
  const combined = combineOcrText([headerText, `STOCK ${stockText}`, `VIN LAST 6 ${vinLast6Text}`]);
  const stock = extractStockFromGetReady(stockText) || extractStockFromGetReady(combined);
  const vinLast6 = extractVinLast6FromGetReady(vinLast6Text) || extractVinLast6FromGetReady(combined);

  return {
    raw_text: combined,
    sheet_type: "get_ready",
    stock_suggestion: stock || null,
    vin_suggestion: null,
    vin8_suggestion: vinLast6 || null,
    work_suggestion: null,
    confidence: stock || vinLast6 ? 0.85 : 0.2,
  };
}

async function runOcrOnImage(imageUrlOrBlob) {
  const imageBlob = await ensureImageBlob(imageUrlOrBlob);
  await assertUsableOcrImage(imageBlob);
  const headerText = await recognizeCrop(imageBlob, OCR_HEADER_REGION);
  const sheetType = detectSheetType(headerText);

  if (sheetType === "ro") return await runRoFieldOcr(imageBlob, headerText);
  if (sheetType === "get_ready") return await runGetReadyFieldOcr(imageBlob, headerText);

  const roCandidate = await runRoFieldOcr(imageBlob, headerText);
  if (roCandidate.stock_suggestion || roCandidate.vin_suggestion) {
    return {
      ...roCandidate,
      sheet_type: "unknown",
      confidence: Math.max(Number(roCandidate.confidence || 0), 0.5),
    };
  }

  const getReadyCandidate = await runGetReadyFieldOcr(imageBlob, headerText);
  if (getReadyCandidate.stock_suggestion || getReadyCandidate.vin8_suggestion) {
    return {
      ...getReadyCandidate,
      sheet_type: "unknown",
      confidence: Math.max(Number(getReadyCandidate.confidence || 0), 0.5),
    };
  }

  const raw = combineOcrText([headerText, roCandidate.raw_text, getReadyCandidate.raw_text]);
  return { raw_text: raw, ...parseUnknownText(raw) };
}

async function runOCR(photoPath) {
  if (!photoPath) return "";
  if (OCR_TEXT_CACHE.has(photoPath)) return OCR_TEXT_CACHE.get(photoPath);

  const signedUrl = await getSignedPhotoUrl(photoPath);
  const ocrResult = await runOcrOnImage(signedUrl);
  const ocrText = ocrResult?.raw_text || "";
  OCR_TEXT_CACHE.set(photoPath, ocrText);
  return ocrText;
}

async function runOCRAndClassify(row) {
  try {
    if (!row?.id || !row?.photo_path) return;
    await markEntryProcessingOcr(row.id);

    let payload = { ...(row || {}) };
    if (!payload.ro_number && !payload.ref && !payload.ro && !payload.stock && !payload.stock_number && !payload.vin8) {
      const { data: fresh, error } = await sb()
        .from("work_logs")
        .select("*")
        .eq("id", row.id)
        .maybeSingle();
      if (error) throw error;
      payload = {
        ...payload,
        ...fresh,
      };
    }

    const signedUrl = await getSignedPhotoUrl(payload.photo_path || null);
    const ocrResult = await runOcrOnImage(signedUrl);
    const ocrText = ocrResult?.raw_text || "";
    OCR_TEXT_CACHE.set(payload.photo_path, ocrText);

    const classification = await classifyEntryWithFallback({
      ro: payload.ro_number || null,
      stock: payload.stock_number || payload.stock || ocrResult?.stock_suggestion || payload.ref || payload.ro_number || null,
      vin: payload.vin8 || null,
      photoPath: payload.photo_path || null,
    });
    const dealer = classification.brand !== "Unmapped" ? classification.brand : "UNKNOWN";
    const updatePatch = {
      dealer,
      updated_at: new Date().toISOString(),
    };

    if (classification.brand !== "Unmapped") {
      updatePatch.brand = classification.brand;
      updatePatch.store_code = classification.store;
      updatePatch.campus = classification.campus;
    }

    await updateWorkLogWithFallback(sb(), row.id, updatePatch);
    await saveOcrResult(row.id, {
      raw_text: ocrResult?.raw_text || "",
      sheet_type: ocrResult?.sheet_type || null,
      stock_suggestion: ocrResult?.stock_suggestion || null,
      vin_suggestion: ocrResult?.vin_suggestion || null,
      vin8_suggestion: ocrResult?.vin8_suggestion || null,
      work_suggestion: ocrResult?.work_suggestion || null,
      confidence: ocrResult?.confidence ?? null,
    });

    console.log("Dealer updated:", dealer);

    if (window.__PAGE__ === "main") {
      const rows = await safeLoadEntries();
      await refreshUI(rows);
    }
  } catch (err) {
    if (row?.id) {
      try {
        await markOcrFailed(row.id, err);
      } catch (markErr) {
        console.error("OCR failure state update failed:", markErr);
      }
    }
    console.error("OCR failed:", err);
  }
}

async function resolveDealerForLog(log) {
  const classification = await classifyEntryWithFallback({
    ro: log?.ro_number || log?.ref || log?.ro || "",
    stock: log?.stock_number || log?.stock || "",
    vin: log?.vin8 || "",
    photoPath: log?.photo_path || null,
  });

  if (classification.brand !== "Unmapped") return classification.brand;
  return "UNKNOWN";
}

async function backfillDealersFromPhotos(logs) {
  let sourceLogs = Array.isArray(logs) ? logs : null;
  if (!sourceLogs) {
    const empId = getEmpId();
    if (!empId) throw new Error("Employee # required");
    sourceLogs = await apiListLogs(empId);
  }

  const targetLogs = sourceLogs.filter(
    (log) => log?.id && (!log.dealer || String(log.dealer).toUpperCase() === "UNKNOWN")
  );
  let updated = 0;

  for (const log of targetLogs) {
    try {
      const dealer = await resolveDealerForLog(log);

      await updateWorkLogWithFallback(sb(), log.id, {
        dealer,
        updated_at: new Date().toISOString(),
      });

      updated += 1;
      console.log("Updated:", log.id, dealer);
    } catch (e) {
      console.error("Failed:", log.id, e);
    }

    await new Promise(r => setTimeout(r, 200)); // small throttle
  }

  await safeLoadEntries();
  return { total: targetLogs.length, updated };
}

window.__FR = window.__FR || {};
window.__FR.backfillDealersFromPhotos = backfillDealersFromPhotos;
window.__FR.resolveDealerForLog = resolveDealerForLog;
window.__FR.loadUserPrefixRules = loadUserPrefixRules;
window.__FR.runOcrOnImage = runOcrOnImage;
