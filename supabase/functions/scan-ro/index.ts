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
                text: `You are reading an automotive shop document. This could be a Repair Order (RO), Get Ready form, Detail Sheet, Pre-Delivery Inspection, or any dealership work order. The writing may be HANDWRITTEN — read it carefully.

Extract ONLY these three values:

1. RO number or Job/Work Order number
   - Look for labels: "RO#", "R.O.", "Work Order", "Job #", "WO#", or a standalone number written near checkboxes/lines
   - On Get Ready / Detail sheets, there is often a number written in the upper-right or next to "DETAILDR" — that is the RO/job number
   - Examples: "40534", "RO: 12345", "W/O 98765"

2. Stock number
   - Look for labels: "Stock", "Stock#", "STK", "STK#", "Stk No"
   - Usually alphanumeric like "SLV13231A", "S12345", "P98765"

3. VIN or partial VIN
   - Full VIN is 17 characters
   - "VIN Verification" fields often show only the last 6–8 digits (like "360036")
   - Return whatever partial VIN is visible

Respond with ONLY a JSON object. No explanation, no markdown, just JSON:
{"ro": "40534", "vin": "360036", "stk": "SLV13231A"}

Use null for any value you cannot find or read. If a number is partially illegible, make your best guess.`,
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
