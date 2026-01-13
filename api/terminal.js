// /api/terminal.js
export default async function handler(req, res) {
  // ---- CORS (THIS is what your browser needs) ----
  const origin = req.headers.origin || "";
  const allowList = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  // If you set ALLOWED_ORIGINS, we’ll only allow those. If you didn’t, allow all.
  const allowedOrigin =
    allowList.length === 0 ? "*" :
    allowList.includes(origin) ? origin :
    allowList[0]; // fallback

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  // Preflight request (browser sends this BEFORE your POST)
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Health check
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "Endpoint is up. Use POST with JSON: { text, mode, tone }",
      example: { text: "hello", mode: "OPS_BRIEF", tone: "CINEMATIC" }
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // ---- Parse body ----
  let body = req.body;
  if (!body || typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch { body = {}; }
  }

  const text = String(body.text || "").trim();
  const mode = String(body.mode || "OPS_BRIEF").trim();
  const tone = String(body.tone || "CINEMATIC").trim();

  if (!text) {
    return res.status(400).json({ ok: false, error: "Missing 'text'" });
  }

  // ---- OpenAI call (Responses API) ----
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return res.status(500).json({ ok: false, error: "Missing OPENAI_API_KEY on server" });
  }

  // Persona / format control (edit this to taste)
  const instructions = [
    "You are PsyopAnime AI Terminal. Output must be anime / ops / intelligence themed.",
    "Stay fictional and entertainment-focused. Do NOT claim real-world intel.",
    "Always follow the requested MODE and TONE.",
    "",
    `MODE: ${mode}`,
    `TONE: ${tone}`,
    "",
    "Format:",
    "TITLE:",
    "SUMMARY:",
    "KEY FACTS:",
    "RISK / ANGLE:",
    "NEXT ACTION:",
    "",
    "For POST_KIT also include an 'X POST:' section (<= 280 chars)."
  ].join("\n");

  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5",
        instructions,
        input: text,
      }),
    });

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: data?.error?.message || data?.message || "OpenAI request failed",
        raw: data || null,
      });
    }

    // OpenAI Responses returns text in output_text
    // (docs show response.output_text usage) :contentReference[oaicite:1]{index=1}
    const result = String(data?.output_text || "").trim();

    return res.status(200).json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server crashed", detail: String(e) });
  }
}
