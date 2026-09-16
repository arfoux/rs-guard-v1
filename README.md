# opencode-rs-guard-v1

OpenCode **V1** plugin: best-effort guard for Responses-style **reasoning continuation** failures.

## Errors handled

- `reasoning encrypted_content was not issued to this caller`
- `invalid_encrypted_content` / `could not be verified`
- `Referenced reasoning item 'rs_..:rs_..' was not found or has expired`

Seen on Gateway Console free models (e.g. `muse-spark-1.3-contributor-free`
failing on message 2–3 of a fresh session) and on Responses API with
`store: false` after a few tool turns. Same family as upstream
`anomalyco/opencode` PR #28678 and PR #29000.

## How it works (best-effort)

V1 (`@opencode-ai/plugin`) has no V2-style request/retry hooks, so this
plugin works with what V1 offers:

- `chat.params`: strip `include: reasoning.encrypted_content`, drop
  `previous_response_id` / `conversation` continuation fields, force
  `store: false` on the outgoing provider options.
- `experimental.chat.messages.transform`: strip server-issued ids from every
  part, keep at most 1 newest encrypted blob.
- `experimental.session.compacting`: ask the summarizer not to carry
  reasoning blobs/ids into the compacted session.
- `event` (`session.error`): show a toast explaining the stale-state error
  (retry, or start a fresh session if it persists).

For the full self-heal (stateless replay + automatic retry without
reasoning), use OpenCode V2 with
[`github:arfoux/rs-guard`](https://github.com/arfoux/rs-guard).

## Install

```jsonc
// opencode.json
{ "plugin": ["opencode-rs-guard-v1"] }
```

Requires OpenCode V1 (`@opencode-ai/plugin` v1).

## Notes

- This is a client-side mitigation, not a server fix. If the provider keeps
  expiring ids aggressively, starting a new session clears the stale
  checkpoint.

## License

MIT — see [LICENSE](./LICENSE).
