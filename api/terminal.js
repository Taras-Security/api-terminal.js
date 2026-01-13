// api/terminal.js
// Vercel Serverless Function
export default async function handler(req, res) {
  // ---------- CORS ----------
  const origin = req.headers.origin || "";
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

  const originAllowed =
    !origin || // non-browser (curl/postman) has no origin
    allowed.includes("*") ||
    allowed.includes(origin);

  // Always vary on Origin so caches don't poison responses
  res.setHeader("Vary", "Origin");

  if (origin && originAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  // If you want to allow credentials later, you'd also set:
  // res.setHeader("Access-Control-Allow-Credentials", "true");

  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    // Preflight must succeed or your browser will show “Failed to fetch”
    return res.status(204).end();
  }

  // Block unknown origins (browser only)
  if (origin && !originAllowed) {
    return res.status(403).json({
      ok: false,
      error: "CORS blocked: origin not allowed",
      origin,
      hint: "Add this origin to ALLOWED_ORIGINS in Vercel env vars (comma-separated).",
    });
  }

  // ---------- HEALTHCHECK ----------
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "Endpoint is up. Use POST with JSON: { text, mode, tone }",
      example: { text: "hello", mode: "OPS_BRIEF", tone: "CINEMATIC" },
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // ---------- PARSE BODY ----------
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch {}
  }

  const text = (body?.text || "").toString().trim();
  const mode = (body?.mode || "OPS_BRIEF").toString().trim();
  const tone = (body?.tone || "CINEMATIC").toString().trim();

  if (!text) {
    return res.status(400).json({ ok: false, error: "Missing 'text'." });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: "Missing OPENAI_API_KEY env var." });
  }

  // ---------- PROMPT / PERSONA ----------
  const system = `
You are PSYOPANIME AI TERMINAL.
You output in a crisp, anime-ops intelligence style.

RULES:
- Always respond in the format for the selected MODE.
- Keep it punchy, structured, and thematic (anime intel / episode framing / post kit).
- Do not mention that you are an AI model. Do not mention policies.
- If user input is vague, infer reasonable details but label assumptions clearly.

MODES:
OPS_BRIEF:
- TITLE:
- SUMMARY:
- KEY FACTS: (3–6 bullets)
- RISK / ANGLE: (2–4 bullets)
- NEXT ACTION: (2–4 bullets)

EPISODE_OUTLINE:
- EP TITLE:
- COLD OPEN (2–4 lines)
- ACT 1 / ACT 2 / ACT 3 (each 3–6 bullets)
- CLIFFHANGER (1–2 lines)

POST_KIT:
- HOOK (1 line)
- MAIN POST (max ~6 lines)
- ALT HOOKS (3 bullets)
- HASHTAGS (5–10)
- X POST: (<=280 chars if possible)
`.trim();

  const user = `
MODE: ${mode}
TONE: ${tone}

INPUT:
${text}
`.trim();

  // ---------- CALL OPENAI (Responses API) ----------
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5-nano",
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        // keep outputs reasonable
        max_output_tokens: 700,
      }),
    });

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: data?.error?.message || data?.error || "OpenAI request failed",
        status: r.status,
        raw: data,
      });
    }

    // Extract text across common shapes (future-proof)
    const pickText = (d) => {
      if (!d) return "";
      if (typeof d.output_text === "string") return d.output_text;
      if (Array.isArray(d.output)) {
        let out = "";
        for (const item of d.output) {
          const content = item?.content;
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c?.type === "output_text" && typeof c?.text === "string") out += c.text;
              if (c?.type === "text" && typeof c?.text === "string") out += c.text;
            }
          }
        }
        if (out.trim()) return out.trim();
      }
      // chat-completions fallback
      const cc = d?.choices?.[0]?.message?.content;
      if (typeof cc === "string") return cc;
      return "";
    };

    const result = pickText(data);

    return res.status(200).json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Server exception calling OpenAI",
      detail: String(e?.message || e),
    });
  }
}
