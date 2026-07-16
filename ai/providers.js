// Drift AI — provider adapters. Plain net.fetch + one hand-rolled SSE parser,
// no vendor SDKs. The internal message model is Anthropic-shaped content blocks
// (the richest: parallel tool calls with ids, streamed args); each adapter
// translates request body, SSE events and tool results to/from that shape.
// Three families cover everything: a native Anthropic adapter, an OpenAI Chat
// Completions adapter (OpenAI, OpenRouter, Gemini-compat, Ollama, LM Studio,
// custom) and the ChatGPT/Codex Responses adapter.

const { randomUUID } = require('crypto')

// net.fetch rides Chromium's proxy-aware network stack; plain fetch is the
// fallback outside Electron (tests).
let net = null
try { net = require('electron').net } catch {}
const doFetch = (url, opts) => (net && net.fetch ? net.fetch(url, opts) : fetch(url, opts))

let VERSION = '0.0.0'
try { VERSION = require('../package.json').version } catch {}
const UA = 'drift-browser/' + VERSION

const LABELS = {
  anthropic: 'Anthropic', openai: 'OpenAI', chatgpt: 'ChatGPT', openrouter: 'OpenRouter',
  gemini: 'Gemini', ollama: 'Ollama', lmstudio: 'LM Studio', custom: 'Custom', mock: 'Mock'
}
const labelFor = (id) => LABELS[id] || id

// Static model lists returned whenever the live /models endpoint can't be
// reached (offline, no key yet, provider hiccup).
const FALLBACK_MODELS = {
  anthropic: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
  openai: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-nano'],
  chatgpt: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  gemini: ['gemini-3.5-flash', 'gemini-3.1-flash-lite'],
  openrouter: [],
  ollama: [],
  lmstudio: [],
  custom: []
}

const toModel = (id) => ({ id, label: id })

// ---------- shared helpers ----------

const isAbort = (err, signal) => !!(err && (err.name === 'AbortError' || (signal && signal.aborted)))

function mkEmit(onEvent) {
  return (ev) => {
    if (typeof onEvent !== 'function') return
    try { onEvent(ev) } catch {}
  }
}

// Normalize a message's content to a block array (a bare string is one text block).
function asBlocks(content) {
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

function textOf(content) {
  return asBlocks(content).filter((b) => b.type === 'text').map((b) => b.text || '').join(' ')
}

// tool_result content is a string in the canonical shape, but image-bearing
// results (screenshots) arrive as a block array — flatten those to text for the
// providers that only accept a string tool output.
function toolResultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => (b.type === 'text' ? (b.text || '') : (b.type === 'image' ? '[image]' : ''))).join('\n')
  }
  return content == null ? '' : String(content)
}

// One SSE parser for every adapter: reader + streaming decoder, split on \n,
// event boundary at a blank line, ':' lines are comments/keep-alives, 'data:'
// prefix stripped. Yields each event's concatenated data payload. AbortError is
// a clean stop — the generator just returns.
async function* sseEvents(res, signal) {
  if (!res || !res.body || typeof res.body.getReader !== 'function') return
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8', { stream: true })
  let buffer = ''
  let dataLines = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') {
          if (dataLines.length) { yield dataLines.join('\n'); dataLines = [] }
          continue
        }
        if (line[0] === ':') continue
        if (line.slice(0, 5) === 'data:') {
          let d = line.slice(5)
          if (d[0] === ' ') d = d.slice(1)
          dataLines.push(d)
        }
        // other SSE fields (event:, id:, retry:) carry no payload we need — the
        // data JSON's own 'type' identifies the event.
      }
    }
    if (dataLines.length) yield dataLines.join('\n')
  } catch (err) {
    if (isAbort(err, signal)) return
    throw err
  } finally {
    try { reader.cancel() } catch {}
  }
}

// Read a failed response body into a concise, key-free error message.
async function httpError(provider, res) {
  let msg = ''
  try {
    const body = await res.text()
    try {
      const j = JSON.parse(body)
      msg = (j.error && (j.error.message || (typeof j.error === 'string' ? j.error : ''))) || j.message || ''
    } catch { msg = body }
  } catch {}
  msg = String(msg || '').trim().slice(0, 300)
  return new Error(provider + ' request failed (' + res.status + (msg ? ': ' + msg : '') + ')')
}

function createProviders(deps) {
  const store = deps && deps.store
  const refreshChatGPT = deps && deps.refreshChatGPT

  // ---------- descriptors ----------

  // Local runtimes have no stored secret — "connected" is the last detectLocal
  // result, so a successful Detect makes them pickable in the model menu.
  const localState = { ollama: null, lmstudio: null }

  function descriptors() {
    const has = (name) => !!store.getSecret(name)
    // A custom endpoint may be keyless (llama.cpp, LiteLLM) — a saved base URL
    // is what makes it usable, with or without a key.
    const customBase = !!(((store.getMeta() || {}).custom || {}).baseUrl)
    const list = [
      { id: 'anthropic', label: 'Anthropic', kind: 'key', connected: has('anthropic') },
      { id: 'openai', label: 'OpenAI', kind: 'key', connected: has('openai') },
      { id: 'chatgpt', label: 'ChatGPT', kind: 'oauth', connected: has('chatgpt') },
      { id: 'openrouter', label: 'OpenRouter', kind: 'oauth', connected: has('openrouter') },
      { id: 'gemini', label: 'Google Gemini', kind: 'key', connected: has('gemini') },
      { id: 'ollama', label: 'Ollama', kind: 'local', connected: !!(localState.ollama && localState.ollama.up) },
      { id: 'lmstudio', label: 'LM Studio', kind: 'local', connected: !!(localState.lmstudio && localState.lmstudio.up) },
      { id: 'custom', label: 'Custom', kind: 'custom', connected: has('custom') || customBase }
    ]
    if (process.env.DRIFT_AI_MOCK === '1') list.push({ id: 'mock', label: 'Mock', kind: 'key', connected: true })
    return list
  }

  // OpenAI-compatible endpoint config for a provider id, or null if unusable.
  function resolveCompat(id) {
    if (id === 'openai') return { base: 'https://api.openai.com/v1', key: store.getSecret('openai') }
    if (id === 'openrouter') {
      return {
        base: 'https://openrouter.ai/api/v1',
        key: store.getSecret('openrouter'),
        extra: { 'HTTP-Referer': 'https://driftwebbrowser.com', 'X-Title': 'Drift' }
      }
    }
    if (id === 'gemini') return { base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: store.getSecret('gemini') }
    if (id === 'ollama') return { base: 'http://localhost:11434/v1', key: 'ollama', noToolChoice: true }
    if (id === 'lmstudio') return { base: 'http://localhost:1234/v1', key: 'lmstudio' }
    if (id === 'custom') {
      const c = (store.getMeta() && store.getMeta().custom) || {}
      const base = String(c.baseUrl || '').replace(/\/+$/, '')
      if (!base) return null
      return { base, key: store.getSecret('custom') }
    }
    return null
  }

  function compatHeaders(cfg, extra) {
    const h = { 'User-Agent': UA }
    if (cfg.key) h.Authorization = 'Bearer ' + cfg.key
    if (cfg.extra) Object.assign(h, cfg.extra)
    if (extra) Object.assign(h, extra)
    return h
  }

  // ---------- model listing ----------

  async function listModels(id, opts) {
    const signal = opts && opts.signal
    const fb = FALLBACK_MODELS[id] || []
    try {
      if (id === 'anthropic') return await anthropicModels(signal, fb)
      // The Codex backend has no public models endpoint — use the static lineup.
      if (id === 'chatgpt') return fb.map(toModel)
      if (id === 'mock') return [{ id: 'mock-1', label: 'Mock model' }]
      const cfg = resolveCompat(id)
      if (!cfg) return fb.map(toModel)
      // Skip a doomed request when a key is required and missing. OpenRouter's
      // list is public and custom endpoints may be keyless — both still fetch.
      if ((id === 'openai' || id === 'gemini') && !cfg.key) return fb.map(toModel)
      return await compatModels(cfg, signal, fb)
    } catch {
      return fb.map(toModel)
    }
  }

  async function anthropicModels(signal, fb) {
    const key = store.getSecret('anthropic')
    if (!key) return fb.map(toModel)
    const res = await doFetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'User-Agent': UA, 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal
    })
    if (!res.ok) throw new Error('models ' + res.status)
    const j = await res.json()
    const arr = j && Array.isArray(j.data) ? j.data : []
    const out = arr.map((m) => ({ id: m.id, label: m.display_name || m.id })).filter((m) => m.id)
    return out.length ? out : fb.map(toModel)
  }

  async function compatModels(cfg, signal, fb) {
    const res = await doFetch(cfg.base + '/models', { headers: compatHeaders(cfg), signal })
    if (!res.ok) throw new Error('models ' + res.status)
    const j = await res.json()
    const arr = j && Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : (j && j.models) || [])
    const out = arr.map((m) => ({ id: m.id || m.name, label: m.id || m.name })).filter((m) => m.id)
    return out.length ? out : fb.map(toModel)
  }

  // ---------- local detection ----------

  async function detectLocal(opts) {
    const signal = opts && opts.signal
    const probe = async (base) => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 1200)
      const onAbort = () => ctrl.abort()
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      try {
        const res = await doFetch(base + '/v1/models', { headers: { 'User-Agent': UA }, signal: ctrl.signal })
        if (!res.ok) return { up: false, models: [] }
        const j = await res.json()
        const arr = j && Array.isArray(j.data) ? j.data : []
        return { up: true, models: arr.map((m) => m.id).filter(Boolean) }
      } catch {
        return { up: false, models: [] }
      } finally {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
      }
    }
    const [ollama, lmstudio] = await Promise.all([
      probe('http://localhost:11434'),
      probe('http://localhost:1234')
    ])
    localState.ollama = ollama
    localState.lmstudio = lmstudio
    return { ollama, lmstudio }
  }

  // ---------- streaming ----------

  async function stream(opts) {
    try {
      return await dispatch(opts)
    } catch (err) {
      // Abort during the initial request (before any bytes) is a clean stop.
      if (isAbort(err, opts && opts.signal)) return { content: [], stopReason: 'end_turn', usage: { input: 0, output: 0 } }
      throw err
    }
  }

  function dispatch(opts) {
    const id = opts.providerId
    if (id === 'mock') return runMock(opts)
    if (id === 'anthropic') return runAnthropic(opts)
    if (id === 'chatgpt') return runChatGPT(opts)
    const cfg = resolveCompat(id)
    if (!cfg) throw new Error('Unknown provider: ' + id)
    return runOpenAICompat(id, cfg, opts)
  }

  // --- Anthropic ---

  function toAnthropicBlock(b) {
    if (!b || typeof b !== 'object') return b
    if (b.type === 'image') {
      return { type: 'image', source: { type: 'base64', media_type: b.media_type || 'image/jpeg', data: b.data } }
    }
    if (b.type === 'tool_result') {
      const out = { type: 'tool_result', tool_use_id: b.tool_use_id }
      out.content = Array.isArray(b.content) ? b.content.map(toAnthropicBlock) : b.content
      if (b.is_error) out.is_error = true
      return out
    }
    return b // text and tool_use are already Anthropic-shaped
  }

  function toAnthropicMessages(messages) {
    return (messages || []).map((m) => ({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.map(toAnthropicBlock) : m.content
    }))
  }

  const mapAnthropicStop = (r) => (r === 'tool_use' ? 'tool_use' : r === 'max_tokens' ? 'max_tokens' : 'end_turn')

  async function runAnthropic(opts) {
    const key = store.getSecret('anthropic')
    if (!key) throw new Error('Anthropic: no API key — add one in settings')
    const body = {
      model: opts.model,
      max_tokens: opts.maxTokens || 4096,
      stream: true,
      messages: toAnthropicMessages(opts.messages)
    }
    if (opts.system) body.system = opts.system
    if (opts.tools && opts.tools.length) {
      body.tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
    }
    // NEVER send temperature/top_p/top_k/thinking — current models 400 on them.
    const res = await doFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: opts.signal
    })
    if (!res.ok) throw await httpError('Anthropic', res)
    return consumeAnthropic(res, opts)
  }

  async function consumeAnthropic(res, opts) {
    const emit = mkEmit(opts.onEvent)
    const blocks = [] // sparse, keyed by content block index
    let stopReason = 'end_turn'
    const usage = { input: 0, output: 0 }
    try {
      for await (const data of sseEvents(res, opts.signal)) {
        let ev
        try { ev = JSON.parse(data) } catch { continue }
        const t = ev.type
        if (t === 'message_start') {
          const u = ev.message && ev.message.usage
          if (u && u.input_tokens != null) usage.input = u.input_tokens
        } else if (t === 'content_block_start') {
          const cb = ev.content_block || {}
          if (cb.type === 'text') blocks[ev.index] = { type: 'text', text: '' }
          else if (cb.type === 'tool_use') {
            blocks[ev.index] = { type: 'tool_use', id: cb.id, name: cb.name, input: {}, json: '' }
            emit({ type: 'tool_start', name: cb.name })
          } else blocks[ev.index] = { type: cb.type }
        } else if (t === 'content_block_delta') {
          const b = blocks[ev.index]
          const d = ev.delta || {}
          if (d.type === 'text_delta') { if (b) b.text += d.text || ''; emit({ type: 'text', delta: d.text || '' }) }
          else if (d.type === 'input_json_delta') { if (b) b.json += d.partial_json || '' }
          else if (d.type === 'thinking_delta') emit({ type: 'thinking', delta: d.thinking || '' })
        } else if (t === 'content_block_stop') {
          const b = blocks[ev.index]
          if (b && b.type === 'tool_use') {
            try { b.input = b.json ? JSON.parse(b.json) : {} } catch { b.input = {} }
            delete b.json
          }
        } else if (t === 'message_delta') {
          if (ev.delta && ev.delta.stop_reason) stopReason = mapAnthropicStop(ev.delta.stop_reason)
          if (ev.usage && ev.usage.output_tokens != null) usage.output = ev.usage.output_tokens
        } else if (t === 'error') {
          throw new Error('Anthropic: ' + ((ev.error && ev.error.message) || 'stream error'))
        }
      }
    } catch (err) {
      if (!isAbort(err, opts.signal)) throw err
    }
    return { content: finalizeBlocks(blocks), stopReason, usage }
  }

  function finalizeBlocks(blocks) {
    const out = []
    for (const b of blocks) {
      if (!b) continue
      if (b.type === 'text') { if (b.text) out.push({ type: 'text', text: b.text }) }
      else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input || {} })
    }
    return out
  }

  // --- OpenAI-compatible Chat Completions (OpenAI, OpenRouter, Gemini, Ollama, LM Studio, custom) ---

  function toOpenAIMessages(system, messages) {
    const out = []
    if (system) out.push({ role: 'system', content: system })
    for (const m of (messages || [])) {
      if (m.role === 'assistant') {
        let text = ''
        const toolCalls = []
        for (const b of asBlocks(m.content)) {
          if (b.type === 'text') text += b.text || ''
          else if (b.type === 'tool_use') {
            toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } })
          }
        }
        const msg = { role: 'assistant', content: text || (toolCalls.length ? null : '') }
        if (toolCalls.length) msg.tool_calls = toolCalls
        out.push(msg)
        continue
      }
      // user message: tool_result blocks become their own role:'tool' messages,
      // text/image blocks become one user message. Tool outputs can only be
      // strings in this API, so an image-bearing result (a screenshot) sends a
      // pointer as the tool output and the actual image as a user message part.
      const parts = []
      for (const b of asBlocks(m.content)) {
        if (b.type === 'tool_result') {
          const images = Array.isArray(b.content) ? b.content.filter((x) => x && x.type === 'image') : []
          out.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            content: images.length ? 'The captured image is attached below.' : toolResultText(b.content)
          })
          for (const im of images) {
            parts.push({ type: 'image_url', image_url: { url: 'data:' + (im.media_type || 'image/jpeg') + ';base64,' + im.data } })
          }
        } else if (b.type === 'text') {
          parts.push({ type: 'text', text: b.text || '' })
        } else if (b.type === 'image') {
          parts.push({ type: 'image_url', image_url: { url: 'data:' + (b.media_type || 'image/jpeg') + ';base64,' + b.data } })
        }
      }
      if (parts.length) {
        const content = parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('') : parts
        out.push({ role: 'user', content })
      }
    }
    return out
  }

  function toOpenAITools(tools) {
    return (tools || []).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema || { type: 'object', properties: {} } }
    }))
  }

  const mapOpenAIStop = (r) => (r === 'tool_calls' ? 'tool_use' : r === 'length' ? 'max_tokens' : 'end_turn')

  async function runOpenAICompat(id, cfg, opts) {
    // OpenRouter needs the connected key; local runtimes ship a dummy key;
    // custom may be keyless (a local llama.cpp/LiteLLM).
    if ((id === 'openai' || id === 'openrouter' || id === 'gemini') && !cfg.key) {
      throw new Error(labelFor(id) + ': not connected — add a key or sign in')
    }
    const body = { model: opts.model, messages: toOpenAIMessages(opts.system, opts.messages), stream: true }
    // OpenAI's current model families reject max_tokens outright ("use
    // max_completion_tokens"); most compat servers only know max_tokens. Start
    // with the right one per endpoint and swap once if the server corrects us.
    let tokenParam = id === 'openai' ? 'max_completion_tokens' : 'max_tokens'
    if (opts.maxTokens) body[tokenParam] = opts.maxTokens
    if (opts.tools && opts.tools.length) {
      body.tools = toOpenAITools(opts.tools)
      if (!cfg.noToolChoice) body.tool_choice = 'auto'
    }
    const send = () => doFetch(cfg.base + '/chat/completions', {
      method: 'POST',
      headers: compatHeaders(cfg, { 'content-type': 'application/json', accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal: opts.signal
    })
    let res = await send()
    if (res.status === 400 && opts.maxTokens) {
      const errText = await res.clone().text().catch(() => '')
      if (/max_(completion_)?tokens/.test(errText)) {
        delete body[tokenParam]
        tokenParam = tokenParam === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
        body[tokenParam] = opts.maxTokens
        res = await send()
      }
    }
    if (!res.ok) throw await httpError(labelFor(id), res)
    return consumeOpenAI(res, opts, labelFor(id))
  }

  async function consumeOpenAI(res, opts, label) {
    const emit = mkEmit(opts.onEvent)
    let text = ''
    const calls = [] // sparse, keyed by tool_call index
    let stopReason = 'end_turn'
    const usage = { input: 0, output: 0 }
    try {
      for await (const data of sseEvents(res, opts.signal)) {
        if (data === '[DONE]') break
        let ev
        try { ev = JSON.parse(data) } catch { continue }
        if (ev.error) throw new Error(label + ': ' + ((ev.error && ev.error.message) || 'stream error'))
        if (ev.usage) {
          if (ev.usage.prompt_tokens != null) usage.input = ev.usage.prompt_tokens
          if (ev.usage.completion_tokens != null) usage.output = ev.usage.completion_tokens
        }
        const choice = ev.choices && ev.choices[0]
        if (!choice) continue
        const d = choice.delta || {}
        if (typeof d.content === 'string' && d.content) { text += d.content; emit({ type: 'text', delta: d.content }) }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const i = tc.index != null ? tc.index : calls.length
            let c = calls[i]
            if (!c) c = calls[i] = { id: tc.id || ('call_' + i), name: '', args: '', started: false }
            if (tc.id) c.id = tc.id
            if (tc.function) {
              if (tc.function.name) {
                c.name = tc.function.name
                if (!c.started) { c.started = true; emit({ type: 'tool_start', name: c.name }) }
              }
              if (tc.function.arguments) c.args += tc.function.arguments
            }
          }
        }
        if (choice.finish_reason) stopReason = mapOpenAIStop(choice.finish_reason)
      }
    } catch (err) {
      if (!isAbort(err, opts.signal)) throw err
    }
    const content = []
    if (text) content.push({ type: 'text', text })
    for (const c of calls) {
      if (!c) continue
      let input = {}
      try { input = c.args ? JSON.parse(c.args) : {} } catch { input = {} }
      content.push({ type: 'tool_use', id: c.id, name: c.name, input })
    }
    return { content, stopReason, usage }
  }

  // --- ChatGPT (Codex Responses) ---

  let refreshInFlight = null // single-flight token refresh, shared across concurrent streams

  function readChatGPTTokens() {
    const raw = store.getSecret('chatgpt')
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  // Refresh when the token is within 60s of expiry or when forced (after a 401).
  // The rotated tokens are persisted BEFORE any caller uses them, so a second
  // concurrent request never races an already-rotated refresh token.
  async function ensureChatGPTToken(force) {
    const tok = readChatGPTTokens()
    if (!tok || !tok.access) throw new Error('ChatGPT: not signed in — connect in settings')
    const near = tok.expiresAt && (tok.expiresAt - Date.now() < 60000)
    if (!force && !near) return tok
    if (typeof refreshChatGPT !== 'function') {
      if (near) throw new Error('ChatGPT: session expired — sign in again')
      return tok
    }
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        const next = await refreshChatGPT(readChatGPTTokens() || tok)
        store.setSecret('chatgpt', JSON.stringify(next))
        return next
      })().finally(() => { refreshInFlight = null })
    }
    return refreshInFlight
  }

  function toCodexInput(messages) {
    const items = []
    for (const m of (messages || [])) {
      if (m.role === 'assistant') {
        for (const b of asBlocks(m.content)) {
          if (b.type === 'text') { if (b.text) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: b.text }] }) }
          else if (b.type === 'tool_use') items.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input || {}) })
        }
        continue
      }
      const parts = []
      for (const b of asBlocks(m.content)) {
        if (b.type === 'tool_result') {
          // Same string-only constraint as Chat Completions: images ride as a
          // user message part right after the function output.
          const images = Array.isArray(b.content) ? b.content.filter((x) => x && x.type === 'image') : []
          items.push({
            type: 'function_call_output',
            call_id: b.tool_use_id,
            output: images.length ? 'The captured image is attached below.' : toolResultText(b.content)
          })
          for (const im of images) {
            parts.push({ type: 'input_image', image_url: 'data:' + (im.media_type || 'image/jpeg') + ';base64,' + im.data })
          }
        } else if (b.type === 'text') parts.push({ type: 'input_text', text: b.text || '' })
        else if (b.type === 'image') parts.push({ type: 'input_image', image_url: 'data:' + (b.media_type || 'image/jpeg') + ';base64,' + b.data })
      }
      if (parts.length) items.push({ type: 'message', role: 'user', content: parts })
    }
    return items
  }

  function toCodexTools(tools) {
    return (tools || []).map((t) => ({
      type: 'function', name: t.name, description: t.description, parameters: t.input_schema || { type: 'object', properties: {} }
    }))
  }

  function chatgptFetch(tok, opts) {
    const body = {
      model: opts.model,
      instructions: opts.system || '',
      input: toCodexInput(opts.messages),
      tools: toCodexTools(opts.tools),
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: false,
      stream: true,
      include: [],
      prompt_cache_key: opts.chatId || randomUUID()
    }
    const headers = {
      'User-Agent': UA,
      'content-type': 'application/json',
      Authorization: 'Bearer ' + tok.access,
      originator: 'drift',
      'OpenAI-Beta': 'responses=experimental',
      accept: 'text/event-stream',
      session_id: randomUUID()
    }
    if (tok.accountId) headers['ChatGPT-Account-Id'] = tok.accountId
    return doFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal
    })
  }

  async function runChatGPT(opts) {
    let tok = await ensureChatGPTToken(false)
    let res = await chatgptFetch(tok, opts)
    if (res.status === 401) {
      // Stale access token — refresh once and retry.
      tok = await ensureChatGPTToken(true)
      res = await chatgptFetch(tok, opts)
    }
    if (!res.ok) throw await httpError('ChatGPT', res)
    return consumeChatGPT(res, opts)
  }

  async function consumeChatGPT(res, opts) {
    const emit = mkEmit(opts.onEvent)
    let text = ''
    const toolBlocks = []
    let stopReason = 'end_turn'
    const usage = { input: 0, output: 0 }
    try {
      for await (const data of sseEvents(res, opts.signal)) {
        let ev
        try { ev = JSON.parse(data) } catch { continue }
        const t = ev.type
        if (t === 'response.output_text.delta') { const dv = ev.delta || ''; text += dv; emit({ type: 'text', delta: dv }) }
        else if (t === 'response.reasoning_summary_text.delta') emit({ type: 'thinking', delta: ev.delta || '' })
        else if (t === 'response.output_item.added') {
          const it = ev.item || {}
          if (it.type === 'function_call') emit({ type: 'tool_start', name: it.name })
        } else if (t === 'response.output_item.done') {
          const it = ev.item || {}
          if (it.type === 'function_call') {
            let input = {}
            try { input = it.arguments ? JSON.parse(it.arguments) : {} } catch { input = {} }
            toolBlocks.push({ type: 'tool_use', id: it.call_id || it.id, name: it.name, input })
          }
        } else if (t === 'response.completed') {
          const r = ev.response || {}
          if (r.usage) { usage.input = r.usage.input_tokens || 0; usage.output = r.usage.output_tokens || 0 }
          if (r.incomplete_details && r.incomplete_details.reason === 'max_output_tokens') stopReason = 'max_tokens'
        } else if (t === 'response.failed' || t === 'error') {
          const r = ev.response || ev
          const msg = (r.error && (r.error.message || r.error)) || 'stream error'
          throw new Error('ChatGPT: ' + msg)
        }
      }
    } catch (err) {
      if (!isAbort(err, opts.signal)) throw err
    }
    const content = []
    if (text) content.push({ type: 'text', text })
    for (const b of toolBlocks) content.push(b)
    if (toolBlocks.length) stopReason = 'tool_use'
    return { content, stopReason, usage }
  }

  // --- Mock (selftest): deterministic, network-free ---

  function mockCardCount(messages) {
    for (const m of (messages || [])) {
      for (const b of asBlocks(m.content)) {
        if (b.type === 'tool_result') {
          const s = toolResultText(b.content)
          const rows = s.split('\n').filter((l) => l.includes('|'))
          if (rows.length) return rows.length
          return s.split('\n').filter((l) => l.trim()).length
        }
      }
    }
    return 0
  }

  function splitInto(str, n) {
    if (!str) return ['']
    const size = Math.max(1, Math.ceil(str.length / n))
    const out = []
    for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size))
    return out
  }

  async function runMock(opts) {
    const emit = mkEmit(opts.onEvent)
    const msgs = opts.messages || []
    const usage = { input: 0, output: 0 }
    const hasToolResult = msgs.some((m) => asBlocks(m.content).some((b) => b.type === 'tool_result'))
    if (hasToolResult) {
      const n = mockCardCount(msgs)
      const line = 'You have ' + n + ' card' + (n === 1 ? '' : 's') + ' on your canvas.'
      for (const chunk of splitInto(line, 5)) emit({ type: 'text', delta: chunk })
      return { content: [{ type: 'text', text: line }], stopReason: 'end_turn', usage }
    }
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
    const lastText = lastUser ? textOf(lastUser.content) : ''
    if (/use tool/i.test(lastText)) {
      const pre = 'Checking your canvas…'
      emit({ type: 'text', delta: pre })
      emit({ type: 'tool_start', name: 'list_cards' })
      return {
        content: [{ type: 'text', text: pre }, { type: 'tool_use', id: 'toolu_mock_1', name: 'list_cards', input: {} }],
        stopReason: 'tool_use',
        usage
      }
    }
    const words = lastText.trim().split(/\s+/).filter(Boolean).reverse()
    const full = 'mock: ' + words.join(' ')
    let acc = ''
    for (const part of splitInto(full, 5)) { emit({ type: 'text', delta: part }); acc += part }
    return { content: [{ type: 'text', text: acc }], stopReason: 'end_turn', usage }
  }

  return { descriptors, listModels, detectLocal, stream }
}

module.exports = { createProviders }
