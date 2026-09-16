import type { Plugin } from "@opencode-ai/plugin"

// rs-guard-v1: best-effort guard for Responses-style reasoning continuation
// failures on OpenCode V1 (`@opencode-ai/plugin`).
//
// Errors handled:
// - `reasoning encrypted_content was not issued to this caller`
// - `invalid_encrypted_content` / `could not be verified`
// - `Referenced reasoning item 'rs_..:rs_..' was not found or has expired`
//
// Seen on Gateway Console free models (e.g. muse-spark-1.3-contributor-free
// failing on message 2-3 of a fresh session) and on Responses API with
// `store: false` after a few tool turns. Same family as upstream
// anomalyco/opencode PR #28678 (don't replay `rs_*` ids when stateless) and
// PR #29000 (summary splitting, encrypted replay, `item_reference` when stored).
//
// How it works — best-effort only (V1 exposes no request/retry hooks):
// 1. `chat.params`: force stateless provider options (drop
//    `previous_response_id` / `conversation`, force `store: false`), drop
//    `include: reasoning.encrypted_content`.
// 2. `experimental.chat.messages.transform`: strip server-issued ids from
//    every part, keep at most 1 newest encrypted blob.
// 3. `experimental.session.compacting`: keep provider reasoning blobs/ids
//    out of the compacted session.
// 4. `event` (`session.error`): toast guidance on a matching error — retry,
//    or start a fresh session if it persists.
//
// Invariant: server-issued continuation ids live in metadata keys only; the
// local `id` of a part is never touched, so tool-call/tool-result pairing
// stays intact.
//
// For the full self-heal (stateless replay + automatic retry without
// reasoning) use OpenCode V2 with `github:arfoux/rs-guard`.

// Matches the reasoning-continuation error class (case-insensitive).
const CONTINUATION_ERROR_PATTERN =
  /encrypted_content|invalid_encrypted_content|was not issued to this caller|could not be verified|was not found or has expired|referenced reasoning|reasoning item|previous_response|previous response|item_reference/i

// Server-issued ids look like `rs_…`, `msg_…`, `resp_…` — a `prefix_payload`
// shape plain local ids never match.
const SERVER_ITEM_ID_PATTERN = /^[A-Za-z]+_[A-Za-z0-9][A-Za-z0-9:_-]*$/

// Metadata keys carrying server-issued continuation ids (local `id` is
// never touched — see invariant above).
const SERVER_ID_KEYS: Record<string, true> = {
  itemid: true,
  item_id: true,
  previous_response_id: true,
  previousresponseid: true,
  response_id: true,
  responseid: true,
}

// Type guard for the `prefix_payload` shape above.
function isServerItemId(value: unknown): value is string {
  return typeof value === "string" && SERVER_ITEM_ID_PATTERN.test(value)
}

// Metadata containers that may carry continuation state, including
// one-level-deeper provider nests.
function metadataContainers(obj: object): object[] {
  const containers: object[] = []
  for (const [k, v] of Object.entries(obj)) {
    if ((k === "metadata" || k === "providerMetadata" || k === "providerOptions") && typeof v === "object" && v !== null) {
      containers.push(v)
      // Native continuation metadata is sometimes nested one level deeper.
      if (k !== "metadata") {
        for (const nested of Object.values(v)) {
          if (typeof nested === "object" && nested !== null) containers.push(nested)
        }
      }
    }
  }
  return containers
}

// Normal path: remove ONLY server ids (leave encrypted blobs alone) so
// lowering can't build an expired `item_reference`.
function stripServerIdsOnly(obj: object): boolean {
  let stripped = false
  for (const c of metadataContainers(obj)) {
    for (const [k, v] of Object.entries(c)) {
      if (SERVER_ID_KEYS[k.toLowerCase()] === true && isServerItemId(v)) {
        Reflect.deleteProperty(c, k)
        stripped = true
      }
    }
  }
  return stripped
}

// Self-heal path: remove encrypted blobs AND server ids from one part/message.
function stripEncryptedKeys(obj: object): boolean {
  let stripped = false
  for (const c of [obj, ...metadataContainers(obj)]) {
    for (const [k, v] of Object.entries(c)) {
      const lk = k.toLowerCase()
      if (lk.includes("encrypt")) {
        Reflect.deleteProperty(c, k)
        stripped = true
        continue
      }
      if (c === obj) continue
      if (SERVER_ID_KEYS[lk] === true && isServerItemId(v)) {
        Reflect.deleteProperty(c, k)
        stripped = true
      }
      if (lk === "itemid" && typeof v === "string" && v.startsWith("rs_")) {
        Reflect.deleteProperty(c, k)
        stripped = true
      }
    }
  }
  return stripped
}

// True if any nested key containing `encrypt` holds a non-empty string blob.
function hasEncrypted(obj: object): boolean {
  const seen = new Set<object>()
  const stack: object[] = [obj]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur || seen.has(cur)) continue
    seen.add(cur)
    for (const [k, v] of Object.entries(cur)) {
      if (k.toLowerCase().includes("encrypt") && typeof v === "string" && v.length > 0) return true
      if (typeof v === "object" && v !== null) stack.push(v)
    }
  }
  return false
}

// Drop `include: reasoning.encrypted_content`, including provider-scoped nests
// (e.g. `options.openai.include`).
function stripInclude(options: object): void {
  for (const [k, v] of Object.entries(options)) {
    if (k === "include" && Array.isArray(v)) {
      const kept = v.filter((item: unknown) => typeof item !== "string" || !item.toLowerCase().includes("encrypt"))
      if (kept.length === 0) Reflect.deleteProperty(options, k)
      else Reflect.set(options, k, kept)
      continue
    }
    // Provider-scoped: options.openai.include / options.azure.include / etc.
    if (typeof v === "object" && v !== null) stripInclude(v)
  }
}

// Force stateless full replay: no continuation pointers, no store.
function dropContinuation(options: object, depth = 0): void {
  if (depth > 4) return
  for (const [k, v] of Object.entries(options)) {
    const lk = k.toLowerCase()
    if (
      lk === "previous_response_id" ||
      lk === "previousresponseid" ||
      lk === "conversation" ||
      lk === "response_id" ||
      lk === "responseid"
    ) {
      Reflect.deleteProperty(options, k)
      continue
    }
    if (lk === "store") {
      Reflect.set(options, k, false)
      continue
    }
    if (typeof v === "object" && v !== null) dropContinuation(v, depth + 1)
  }
}

// One toast per session per 30s — errors still surface, we just don't nag.
const TOAST_THROTTLE_MS = 30_000

// NOTE: exactly one export — the V1 loader calls every exported function
// value as a plugin, so helper exports would double-register or throw.
export const RsGuardV1: Plugin = async ({ client }) => {
  const lastToast = new Map<string, number>()

  return {
    "chat.params": async (_input, output) => {
      try {
        stripInclude(output.options)
        dropContinuation(output.options)
      } catch (e) {
        console.error("[rs-guard-v1] chat.params hook failed:", e)
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        // Normal path: ALWAYS strip server ids; afterwards trim older blobs.
        const encryptedReasoning: object[] = []
        for (const m of output.messages) {
          for (const p of m.parts) {
            stripServerIdsOnly(p)
            if (p.type === "reasoning" && hasEncrypted(p)) encryptedReasoning.push(p)
          }
        }
        // Keep at most 1 newest encrypted blob.
        for (let i = 0; i < encryptedReasoning.length - 1; i++) stripEncryptedKeys(encryptedReasoning[i])
      } catch (e) {
        console.error("[rs-guard-v1] messages.transform hook failed:", e)
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      try {
        output.context.push(
          `[rs-guard-v1] Do not carry provider reasoning blobs or ids (encrypted_content, rs_*, response ids) ` +
            `into the compacted session — the provider rejects expired continuation state. ` +
            `Summarize decisions and task state in plain text only.`,
        )
      } catch (e) {
        console.error("[rs-guard-v1] compacting hook failed:", e)
      }
    },

    event: async ({ event }) => {
      try {
        if (event.type !== "session.error") return
        const err = event.properties.error
        let detail = ""
        if (err && typeof err === "object" && "data" in err) {
          const data = err.data
          if (data && typeof data === "object" && "message" in data && typeof data.message === "string") {
            detail = data.message
          }
        }
        // Anything outside the continuation-error class passes through untouched.
        if (!CONTINUATION_ERROR_PATTERN.test(detail)) return
        const sessionID = event.properties.sessionID ?? ""
        const now = Date.now()
        if (sessionID && now - (lastToast.get(sessionID) ?? 0) < TOAST_THROTTLE_MS) return
        if (sessionID) lastToast.set(sessionID, now)
        const short = detail.length > 300 ? detail.slice(0, 300) + "…" : detail
        try {
          await client.tui.showToast({
            body: {
              title: "rs-guard-v1: stale reasoning state",
              message:
                `Stale Responses reasoning state — the provider rejected an expired encrypted blob or reasoning id (rs_*). ` +
                `rs-guard-v1 strips these on the next turn, so just retry. If it persists, start a fresh session. ` +
                `Full self-heal needs OpenCode V2 + github:arfoux/rs-guard.` +
                (short ? ` Provider said: ${short}` : ""),
              variant: "warning",
              duration: 12000,
            },
          })
        } catch {
          // Toast is best-effort (e.g. headless); the error itself still surfaces.
        }
      } catch (e) {
        console.error("[rs-guard-v1] event hook failed:", e)
      }
    },
  }
}
