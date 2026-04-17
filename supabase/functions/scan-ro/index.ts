import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const { imageBase64, mediaType = "image/jpeg" } = await req.json();
    if (!imageBase64) {
      return new Response(JSON.stringify({ error: "imageBase64 required" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: imageBase64 },
              },
              {
                type: "text",
                text: `You are reading an automotive dealership document. It may be HANDWRITTEN. Read it carefully.

STEP 1 — Identify the document type:
- "Repair Order" (RO): titled "Repair Order", "Service RO", "Work Order". Has a labeled RO# or R.O. number.
- "Get Ready" / "Detail Sheet" / "Pre-Delivery": titled "Get Ready", "Detail", "Pre-Delivery Inspection", "PDI". These do NOT have an RO number — they have a Stock number and VIN instead.

STEP 2 — Extract only what the LABEL says:

1. RO number — ONLY if the document is a Repair Order AND the number is EXPLICITLY labeled "RO#", "R.O.", "Repair Order #", or "Work Order #". Do NOT guess. If it is a Get Ready or Detail form, set ro to null.

2. Stock number — look for a label that says "Stock", "Stock#", "STK", "STK#", or "Stock No". The value is usually alphanumeric like "SLV13231A" or "P12345". Employee numbers, phone numbers, and unlabeled numbers are NOT stock numbers.

3. VIN — a full 17-character VIN, or a "VIN Verification" field that shows the last 6–8 digits (e.g. "360036"). Do not confuse this with other numbers.

Return ONLY this JSON, nothing else:
{"ro": null, "vin": "360036", "stk": "SLV13231A"}

Use null for any value not present or not clearly labeled. Do not guess unlabeled numbers.`,
              },
            ],
          },
        ],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      throw new Error(`Claude API error: ${claudeRes.status} ${errText}`);
    }

    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.[0]?.text?.trim() || "{}";

    let parsed: { ro?: string | null; vin?: string | null; stk?: string | null } = {};
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      parsed = {};
    }

    return new Response(
      JSON.stringify({
        ro: parsed.ro || null,
        vin: parsed.vin || null,
        stk: parsed.stk || null,
      }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err?.message || err) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
