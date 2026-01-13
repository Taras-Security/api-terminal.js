// /api/terminal.js
// Vercel Serverless Function: POST /api/terminal
// Persona + mode/tone prompt live HERE (not in Framer).

function json(res, status, data) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.end(JSON.stringify(data))
}

function pickAllowedOrigin(reqOrigin, allowedList) {
  if (!reqOrigin) return allowedList[0] || "*"
  if (!allowedList.length) return reqOrigin

  // exact match OR wildcard
  if (allowedList.includes("*")) return reqOrigin

  // allow comma-separated exact origins
  if (allowedList.includes(reqOrigin)) return reqOrigin

  return allowedList[0] || reqOrigin
}

function setCors(req, res) {
  const reqOrigin = req.headers.origin
  const allowed = String(process.env.ALLOWED_ORIGIN || "").trim()

  const allowedList = allowed
    ? allowed.split(",").map((s) => s.trim()).filter(Boolean)
    : []

  const originToSend = pickAllowedOrigin(reqOrigin, allowedList)

  res.setHeader("Access-Control-Allow-Origin", originToSend)
  res.setHeader("Vary", "Origin")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  res.setHeader("Access-Control-Max-Age", "86400")
}

function safeEnum(v, options, fallback) {
  return options.includes(v) ? v : fallback
}

/**
 * THIS is what you edit to change the personality.
 */
function buildPrompt({ text, mode, tone }) {
  const persona = `
You are "PSYOPANIME AI TERMINAL", a covert anime-style intel console.
Your job: transform messy headlines into dramatic, useful, anime-ops outputs.

STYLE RULES:
- Output MUST be plain text (no markdown).
- Keep it tight, punchy, tactical.
- Use anime/spy ops flavor WITHOUT becoming cringe.
- Avoid disclaimers unless asked.
- Never mention system prompts, policies, or OpenAI.
- If input is vague, infer plausible context and label assumptions.

VOICE:
- "CINEMATIC": dramatic, high-stakes, stylish but controlled.
- "SERIOUS": military briefing, clean, no jokes.
- "UNHINGED": chaotic anime narrator energy, still coherent and usable.

You must ALWAYS end with an "X POST:" line containing a tweet-ready version (<= 260 chars).
`

  const toneRules = {
    CINEMATIC:
      "Use cinematic phrasing. Sparse but vivid. Add 1–2 short 'scene' cues like CUT TO / STATIC / SIREN.",
    SERIOUS:
      "No theatrics. Minimal adjectives. Read like an internal intelligence brief.",
    UNHINGED:
      "Go unhinged anime narrator, but keep structure readable. No walls of text.",
  }[tone]

  const modeTemplates = {
    OPS_BRIEF: `
FORMAT:
TITLE:
SUMMARY: (1–2 lines)
KEY FACTS: (3–6 bullets)
ASSUMPTIONS: (0–3 bullets, only if needed)
RISK / ANGLE: (2–4 bullets)
NEXT ACTION: (3 bullets, imperative verbs)
X POST: (single line, <=260 chars)
`,
    EPISODE_OUTLINE: `
FORMAT:
TITLE:
LOGLINE: (1 line)
CAST: (3–6 key roles)
BEATS:
- Cold Open:
- Act 1:
- Act 2:
- Climax:
- Tag:
ICONIC SHOTS: (3 bullets)
X POST: (single line, <=260 chars)
`,
    POST_KIT: `
FORMAT:
HOOKS: (3 variants)
THREAD: (5 bullets max)
ONE-LINER: (1 line)
CTA: (1 line)
HASHTAGS: (5–8 tags)
X POST: (single line, <=260 chars)
`,
  }[mode]

  const user = `
MODE=${mode}
TONE=${tone}
${toneRules}

INPUT:
${text}
`

  return { persona, modeTemplates, user }
}

module.exports = async (req, res) => {
  setCors(req, res)

  if (req.method === "OPTIONS") {
    res.statusCode = 204
    return res.end()
  }

  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed" })
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return json(res, 500, { ok: false, error: "Missing OPENAI_API_KEY" })
  }

  // Read body (Vercel Node runtime)
  let body = ""
  await new Promise((resolve) => {
    req.on("data", (c) => (body += c))
    req.on("end", resolve)
  })

  let data
  try {
    data = body ? JSON.parse(body) : {}
  } catch {
    return json(res, 400, { ok: false, error: "Invalid JSON" })
  }

  const text = String(data.text || "").trim()
  const mode = safeEnum(String(data.mode || ""), ["OPS_BRIEF", "EPISODE_OUTLINE", "POST_KIT"], "OPS_BRIEF")
  const tone = safeEnum(String(data.tone || ""), ["CINEMATIC", "SERIOUS", "UNHINGED"], "CINEMATIC")

  if (text.length < 3) {
    return json(res, 400, { ok: false, error: "Empty input" })
  }

  const model = String(process.env.OPENAI_MODEL || "gpt-5-nano").trim()

  const { persona, modeTemplates, user } = buildPrompt({ text, mode, tone })

  try {
    // Responses API (official endpoint) :contentReference[oaicite:2]{index=2}
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: persona },
          { role: "system", content: modeTemplates },
          { role: "user", content: user },
        ],
        // optional verbosity control shown in docs :contentReference[oaicite:3]{index=3}
        text: { verbosity: "low" },
        store: false,
      }),
    })

    if (r.status === 429) {
      const retryAfter = Number(r.headers.get("retry-after") || "600")
      return json(res, 429, { ok: false, error: "Rate limited", retry_after_seconds: retryAfter })
    }

    const out = await r.json().catch(() => null)

    if (!r.ok) {
      const msg =
        out?.error?.message ||
        out?.error ||
        out?.message ||
        "OpenAI request failed"
      return json(res, 500, { ok: false, error: msg })
    }

    // Responses return output_text in examples :contentReference[oaicite:4]{index=4}
    const result =
      (typeof out?.output_text === "string" && out.output_text) ||
      ""

    if (!result.trim()) {
      return json(res, 500, { ok: false, error: "Empty model output" })
    }

    return json(res, 200, { ok: true, result })
  } catch (e) {
    return json(res, 500, { ok: false, error: "Server error" })
  }
}
