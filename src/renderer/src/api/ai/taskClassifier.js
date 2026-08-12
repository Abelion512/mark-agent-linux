import { fetchAI, cleanAndParse } from './core'

// Router model sengaja kecil dan deterministik supaya keputusan mode tidak mahal.
const ROUTER_MODEL_CONFIG = {
  aiProvider: 'gemini-web',
  geminiWebModel: 'gemini-flash-lite',
  temperature: 0
}

// Prompt ini hanya memutuskan mode kerja, bukan mengerjakan task utama.
const ROUTER_PROMPT = `
You are MARK's task router. Decide how the app should handle the user's latest request.

Return direct when the request is casual chat, a simple question, a one-shot answer, a greeting, or a simple command that does not need durable progress.

Return ephemeral when the request has a few steps but should finish in the current session without persisted checkpoints.

Return durable when the work is long, multi-step, produces or edits artifacts, needs progress tracking, may continue after interruption/restart, or the user asks to work step by step until finished.

Judge intent semantically. The user may speak in Indonesian, English, slang, mixed language, or any other language. Do not rely on keywords.

Never choose durable only because the user says "buat/create/make". Choose durable only when persistence or step-level progress is useful.
`.trim()

const ROUTER_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['direct', 'ephemeral', 'durable'] },
    confidence: { type: 'number' },
    reason: { type: 'string' },
    estimatedSteps: { type: 'number' },
    needsArtifact: { type: 'boolean' },
    requiresCheckpoint: { type: 'boolean' },
    requiresResume: { type: 'boolean' }
  },
  required: [
    'mode',
    'confidence',
    'reason',
    'estimatedSteps',
    'needsArtifact',
    'requiresCheckpoint',
    'requiresResume'
  ],
  additionalProperties: false
}

function fallbackDirect(reason = 'router_failed') {
  // Fail closed ke direct supaya kegagalan router tidak memblokir chat biasa.
  return {
    mode: 'direct',
    confidence: 0,
    reason,
    estimatedSteps: 1,
    needsArtifact: false,
    requiresCheckpoint: false,
    requiresResume: false
  }
}

function normalizeRouterResult(data) {
  if (!data || !['direct', 'ephemeral', 'durable'].includes(data.mode)) {
    return fallbackDirect('invalid_router_json')
  }

  return {
    mode: data.mode,
    confidence: Number.isFinite(Number(data.confidence)) ? Number(data.confidence) : 0.5,
    reason: data.reason || '',
    estimatedSteps: Math.max(1, Math.round(Number(data.estimatedSteps) || 1)),
    needsArtifact: Boolean(data.needsArtifact),
    requiresCheckpoint: Boolean(data.requiresCheckpoint),
    requiresResume: Boolean(data.requiresResume)
  }
}

export async function classifyTaskMode(userInput, options = {}) {
  // Jalur ini dipanggil sebelum loop ReAct utama.
  if (!userInput || options.disableTools || options.isAutonomous || options.isSystem) {
    return fallbackDirect('system_or_no_tool_mode')
  }

  const messages = [
    { role: 'system', content: ROUTER_PROMPT },
    { role: 'user', content: String(userInput) }
  ]

  try {
    const response = await fetchAI(
      messages,
      options.signal || null,
      true,
      ROUTER_SCHEMA,
      ROUTER_MODEL_CONFIG
    )
    return normalizeRouterResult(cleanAndParse(response.content))
  } catch (error) {
    console.warn('[taskClassifier] Router failed, using direct fallback:', error)
    return fallbackDirect(error?.message || 'router_failed')
  }
}
