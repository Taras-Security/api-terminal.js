// /api/terminal.js
// Vercel Serverless Function (Node)
// Env vars:
// - OPENAI_API_KEY   (required)
// - OPENAI_MODEL     (optional, default "gpt-4.1-mini")
// - ALLOWED_ORIGIN   (optional, comma-separated, e.g. "https://your.framer.website,https://yourdomain.com")
// - TERMINAL_PERSONA (optional override)

const OPENAI_URL = "https://api.openai.com/v1/responses"

function parseAllowedOrigins() {
  const raw = (process.env.ALLOWED_ORIGIN || "").trim()
  if (!raw) return []
  return raw.split(",").map((s) => s.trim()).filter(Boolean)
}

function setCors(req, res) {
  const origins = parseAllowedOrigins()
  const origin = req.headers.origin

  // If no ALLOWED_ORIGIN set, you can either allow all or allow none.
  // For Framer, it's usually better to set ALLOWED_ORIGIN explicitly.
  if (!origins.length) {
    // permissive fallback
    res.setHeader("Access-Control-Allow-Origin", "*")
  } else if (origin && origins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Vary", "Origin")
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  res.setHeader("Access-Control-Max-Age", "86400")
}

function readJsonBody(req) {
  // Vercel usually parses JSON into req.body, but not always.
  if (req.body && typeof req.body === "object") return req.body
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body)
    } catch {
      return null
    }
  }
  return null
}

function buildInstructions({ mode, tone, personaOverride }) {
  const BASE_PERSONA =
    (personaOverride && String(personaOverride).trim()) ||
    (process.env.TERMINAL_PERSONA && process.env.TERMINAL_PERSONA.trim()) ||
    `
You are PSYOPANIME AI TERMINAL — an anime/news ops analyst that turns user input into anime-styled intel outputs.
You do NOT talk like a generic assistant. You write like a clandestine anime briefing system.
No “as an AI” disclaimers. No cringe. No filler.
Always produce useful structure. Keep it tight.

If the user gives a topic, you:
- Identify what happened
- Give the angle
- Give implications
- Give a hooky “X POST” at the end that matches the selected tone.
`.trim()

  const toneRules = {
    CINEMATIC:
      "Tone: cinematic, dramatic, clean. Sharp lines. Controlled hype. No clown emojis.",
    SERIOUS:
      "Tone: serious, factual, restrained. No hype. No memes unless requested.",
    UNHINGED:
      "Tone: unhinged, chaotic, funny, but still coherent and useful. Light meme energy allowed.",
  }[tone] || "Tone: cinematic, dramatic, clean."

  const modeRules = {
    OPS_BRIEF: `
Output format:
TITLE:
SUMMARY: (2–4 lines)
KEY FACTS: (bullets)
RISK / ANGLE: (bullets)
NEXT ACTION: (bullets)
X POST: (one post, <= 280 chars)
`.trim(),
    EPISODE_OUTLINE: `
Output format:
TITLE:
LOGLINE: (1–2 lines)
CAST: (3–6 roles)
ACT 1:
ACT 2:
ACT 3:
SETPIECES: (bullets)
FINAL HOOK: (1 line)
X POST: (<= 280 chars)
`.trim(),
    POST_KIT: `
Output format:
HOOK: (1 line)
CAPTION OPTIONS: (3 variants)
THREAD OUTLINE: (5 bullets max)
HASHTAGS: (up to 8)
IMAGE PROMPT: (1 short prompt)
X POST: (<= 280 chars)
`.trim(),
  }[mode] || "Output format: clean structured response + X POST."

  return `${BASE_PERSONA}\n\n${toneRules}\n\n${modeRules}`
}

function extractOutputText(respJson) {
  const output = respJson && respJson.output
  if (!Array.isArray(output)) return ""
  for (const item of output) {
    const content = item && item.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c && c.type === "output_text" && typeof c.text === "string") {
        return c.text
      }
    }
  }
  return ""
}

export default async function handler(req, res) {
  setCors(req, res)

  if (req.method === "OPTIONS") {
    return res.status(204).end()
  }

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message:
        "Endpoint is up. Use POST with JSON: { text, mode, tone }. Example: { text:'hello', mode:'OPS_BRIEF', tone:'CINEMATIC' }",
    })
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" })
  }

  const key = (process.env.OPENAI_API_KEY || "").trim()
  if (!key) {
    return res.status(500).json({
      ok: false,
      error: "Missing OPENAI_API_KEY in Vercel env vars.",
    })
  }

  const body = readJsonBody(req)
  if (!body) {
    return res.status(400).json({ ok: false, error: "Invalid JSON body." })
  }

  const text = String(body.text || "").trim()
  const mode = String(body.mode || "OPS_BRIEF").trim()
  const tone = String(body.tone || "CINEMATIC").trim()
  const personaOverride = body.persona ? String(body.persona) : ""

  if (!text) {
    return res.status(400).json({ ok: false, error: "Missing 'text'." })
  }
  if (text.length > 5000) {
    return res
      .status(400)
      .json({ ok: false, error: "Text too long (max 5000 chars)." })
  }

  const model = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim()
  const instructions = buildInstructions({ mode, tone, personaOverride })

  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        input: text,
        instructions,
        // keep outputs readable + consistent
        temperature: 0.8,
        text: { format: { type: "text" } },
        max_output_tokens: 900,
      }),
    })

    const raw = await r.text()
    let data = null
    try {
      data = JSON.parse(raw)
    } catch {
      // leave as null
    }

    if (!r.ok) {
      // pass through 429 cleanly (this is what your Framer cooldown reads)
      if (r.status === 429) {
        return res.status(429).json({
          ok: false,
          error: "Rate limited by model/provider. Retry shortly.",
          retry_after_seconds: 25,
          details: data || raw,
        })
      }

      return res.status(r.status).json({
        ok: false,
        error:
          (data && data.error && data.error.message) ||
          (data && data.message) ||
          `Upstream error (${r.status})`,
        details: data || raw,
      })
    }

    const outText = extractOutputText(data) || ""
    return res.status(200).json({
      ok: true,
      result: outText,
    })
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Server crashed while calling OpenAI.",
      details: String(e?.message || e),
    })
  }
}
