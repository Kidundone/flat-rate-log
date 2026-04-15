import { setTimeout as sleep } from "node:timers/promises";

const baseUrl = process.env.APP_BASE_URL || "http://127.0.0.1:4173";
const driverUrl = process.env.WD_URL || "http://127.0.0.1:4444";

let sessionId = null;

async function webdriver(path, { method = "GET", body } = {}) {
  const res = await fetch(`${driverUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`WebDriver ${method} ${path} failed: ${res.status} ${text}`);
  }
  return data;
}

async function createSession() {
  const data = await webdriver("/session", {
    method: "POST",
    body: {
      capabilities: {
        alwaysMatch: {
          browserName: "safari",
          acceptInsecureCerts: true,
        },
      },
    },
  });

  sessionId = data.value?.sessionId || data.sessionId;
  if (!sessionId) throw new Error("WebDriver sessionId missing");
  return sessionId;
}

async function destroySession() {
  if (!sessionId) return;
  try {
    await webdriver(`/session/${sessionId}`, { method: "DELETE" });
  } catch {}
  sessionId = null;
}

async function execute(script, args = []) {
  const data = await webdriver(`/session/${sessionId}/execute/sync`, {
    method: "POST",
    body: { script, args },
  });
  return data.value;
}

async function navigate(url) {
  await webdriver(`/session/${sessionId}/url`, {
    method: "POST",
    body: { url },
  });
}

async function waitFor(script, timeoutMs = 20000, intervalMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await execute(script)) return;
    } catch {}
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for condition: ${script}`);
}

async function smokeMainPage() {
  await navigate(`${baseUrl}/index.html`);
  await waitFor("return document.readyState === 'complete' && window.__PAGE__ === 'main' && !!document.getElementById('saveBtn');");
  await waitFor("return !!window.__FR && window.__FR.buildTag === 'weekend-stable' && window.__FR.activeDataPath === 'supabase';");

  const details = await execute(`
    return {
      page: window.__PAGE__,
      buildTag: window.__FR?.buildTag || null,
      activeDataPath: window.__FR?.activeDataPath || null,
      hasSupabaseClient: !!window.__FR?.sb,
      hasSaveBtn: !!document.getElementById('saveBtn'),
      hasEmpId: !!document.getElementById('empId'),
      hasQuickPhotoButton: !!document.getElementById('btnPickPhoto'),
      hasDetailsToggle: !!document.getElementById('toggleDetailsBtn')
    };
  `);

  const formState = await execute(`
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (!el) return false;
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    set('empId', '12345');
    set('typeText', 'BrowserSmoke');
    set('hours', '1.0');
    const btn = document.getElementById('saveBtn');
    return {
      saveDisabled: !!btn?.disabled,
      refValue: document.getElementById('ref')?.value || null,
      typeValue: document.getElementById('typeText')?.value || null,
      hoursValue: document.getElementById('hours')?.value || null
    };
  `);

  if (formState.saveDisabled) {
    throw new Error("Main page smoke failed: save button stayed disabled after valid input");
  }

  return { details, formState };
}

async function smokeMorePage() {
  await navigate(`${baseUrl}/more.html`);
  await waitFor("return document.readyState === 'complete' && window.__PAGE__ === 'more' && !!document.getElementById('missingWorkSummary');");

  return await execute(`
    return {
      page: window.__PAGE__,
      buildTag: window.__FR?.buildTag || null,
      activeDataPath: window.__FR?.activeDataPath || null,
      hasPayStubWeekEnding: !!document.getElementById('payStubWeekEnding'),
      hasSavePayStubBtn: !!document.getElementById('savePayStubBtn'),
      hasRepairBtn: !!document.getElementById('repairBtn'),
      hasMissingWorkSummary: !!document.getElementById('missingWorkSummary'),
      hasMissingWorkList: !!document.getElementById('missingWorkList')
    };
  `);
}

async function main() {
  await createSession();
  try {
    const mainPage = await smokeMainPage();
    const morePage = await smokeMorePage();
    console.log(JSON.stringify({ ok: true, mainPage, morePage }, null, 2));
  } finally {
    await destroySession();
  }
}

main().catch(async (err) => {
  console.error(err.stack || String(err));
  await destroySession();
  process.exit(1);
});
