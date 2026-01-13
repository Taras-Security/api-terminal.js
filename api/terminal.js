// api/terminal.js (Vercel Serverless Function - Node.js)

function parseAllowedOrigins(raw) {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

function setCors(req, res) {
  const origin = req.headers.origin || ""
  const allowed = parseAllowedOrigins(process.env.ALLOWED_ORIGINS)

  // If you set ALLOWED_ORIGINS, reflect only approved origins.
  // If you don't set it, allow all (not recommended).
  const allowOrigin =
    allowed.length === 0 ? "*" : allowed.includes(origin) ? origin : ""

  if (allowOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin)
    res.setHeader("Vary", "Origin")
  }

  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  res.setHeader("Access-Control-Max-Age", "86400")
}

function clampMode(mode) {
  return ["OPS_BRIEF", "EPISODE_OUTLINE", "POST_KIT"].includes(mode)
    ? mode
    : "OPS_BRIEF"
}

function clampTone(tone) {
  return ["CINEMATIC", "SERIOUS", "UNHINGED"].includes(tone)
    ? tone
    : "CINEMATIC"
}

function buildInstructions(mode, tone) {
  const toneRules =
    tone === "CINEMATIC"
      ? "Write like a high-stakes cinematic intel terminal. Punchy. Vivid. Minimal fluff."
      : tone === "SERIOUS"
        ? "Write like professional analysis. Clear, grounded, concise."
        : "Write like chaotic internet ops. Still structured. No slurs, no threats, no doxxing."

  const modeRules =
    mode === "OPS_BRIEF"
      ? [
          "Output format:",
          "TITLE: <short>",
          "SUMMARY: 2–4 lines",
          "KEY FACTS: 3–6 bullets",
          "RISK / ANGLE: 2–4 bullets",
          "NEXT ACTION: 2–4 bullets",
          "",
          "Keep it tight. No hashtags unless relevant."
        ].join("\n")
      : mode === "EPISODE_OUTLINE"
        ? [
            "Output format:",
            "LOGLINE: 1 line",
            "BEATS: 6–10 numbered beats (1–2 lines each)",
            "SCENES: 5–8 scene headings with 1–2 lines each",
            "ENDING: 1–2 lines",
            "",
            "No filler. Make it usable."
          ].join("\n")
        : [
            "Output format:",
            "X POST: <single post text, <= 280 chars if possible>",
            "ALT POSTS: 2 alternatives",
            "REPLIES: 3 short reply lines",
            "HOOKS: 3 hook ideas",
            "",
            "Make sure the first line literally starts with 'X POST:' so the UI can extract it."
          ].join("\n")

  return [
    "You are the PsyopAnime AI Terminal.",
    "Generate a structured output from the user's input.",
    toneRules,
    modeRules
  ].join("\n\n")
}

function extractTextFromResponses(data) {
  // Responses API returns an `output` array of items (messages) with `content` blocks.
  // We collect content blocks that contain text.
  const out = []
  const items = Array.isArray(data?.output) ? data.output : []

  for (const item of items) {
    const content = Array.isArray(item?.content) ? item.content : []
    for (const c of content) {
      if (typeof c?.text === "string") out.push(c.text)
    }
  }

  // Some SDKs expose `output_text`, but don’t rely on it in raw REST parsing.
  if (out.length) return out.join("\n").trim()
  if (typeof data?.output_text === "string") return data.output_text.trim()
  return ""
}

module.exports = async (req, res) => {
  setCors(req, res)

  if (req.method === "OPTIONS") {
    return res.status(204).end()
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" })
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return res
      .status(500)
      .json({ ok: false, error: "Missing OPENAI_API_KEY" })
  }

  const body = req.body || {}
  const input = String(body.input ?? body.text ?? "").trim()
  const mode = clampMode(String(body.mode || ""))
  const tone = clampTone(String(body.tone || ""))

  if (!input) {
    return res.status(400).json({ ok: false, error: "Missing input" })
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini"
  const maxTokens = Number(process.env.MAX_OUTPUT_TOKENS || 700)

  try {
    // Responses API: POST /v1/responses with model, input, instructions, max_output_tokens :contentReference[oaicite:1]{index=1}
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        instructions: buildInstructions(mode, tone),
        input,
        max_output_tokens: maxTokens,
        // store: false, // optional if supported on your account
      })
    })

    const data = await r.json().catch(() => null)

    if (!r.ok) {
      const msg =
        (data && (data.error?.message || data.error || data.message)) ||
        `OpenAI error (${r.status})`
      return res.status(500).json({ ok: false, error: msg })
    }

    // The response object contains `output` items we parse into text. 
    const result = extractTextFromResponses(data) || ""
    return res.status(200).json({ ok: true, result })
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Network failure" })
  }
}

