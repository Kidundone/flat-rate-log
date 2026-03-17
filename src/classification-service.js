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

function detectSheetType(text) {
  const t = up(text);
  if (t.includes("NEW - PRE-OWNED GET READY") || t.includes("GET READY")) return "get_ready";
  if (t.includes("WORKORDER") || t.includes("FLOW MOTORS OF WINSTON-SALEM")) return "ro";
  return "unknown";
}

function extractVin(text) {
  const matches = up(text).match(/[A-HJ-NPR-Z0-9]{17}/g) || [];
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
  return "";
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
  return "";
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
  return "";
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

async function runOcrOnImage(imageUrlOrBlob) {
  if (!window.Tesseract) throw new Error("Tesseract not loaded");

  const result = await window.Tesseract.recognize(imageUrlOrBlob, "eng", {
    logger: () => {}
  });

  const raw = normalizeText(result?.data?.text || "");
  const sheetType = detectSheetType(raw);

  if (sheetType === "ro") return { raw_text: raw, ...parseRoText(raw) };
  if (sheetType === "get_ready") return { raw_text: raw, ...parseGetReadyText(raw) };
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
