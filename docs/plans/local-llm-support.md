# Local LLM Support: Ollama / OpenAI-Compatible Endpoints

## Goal

Let a user run OpenGnothia entirely against a local LLM (Ollama, or any OpenAI-compatible endpoint such as opencode, LM Studio, llama.cpp, vLLM) so that no therapy content ever leaves the device. Add a third `"local"` provider, route all AI HTTP through `tauri-plugin-http` to eliminate CORS, and surface base URL / model / context-window controls in Settings and Onboarding.

Success = with Ollama running and a model pulled, the user selects **Local**, enters a URL and model name, gets a green **Test connection** with **no environment variables set and no Ollama restart**, runs a full streaming therapy session with a working context gauge and compaction, sees `$0` with real token counts, finds voice mode visibly unavailable with a stated reason — and can turn Wi-Fi off mid-session with nothing breaking. Existing OpenAI/Anthropic users see zero behaviour change.

## Progress Tracking

Phase-level overview. Tick a phase when all its steps are done.

- [x] **Phase 0** — Pre-flight (branch)
- [x] **Phase 1** — 🚦 Spike: `tauri-plugin-http` streaming (gates everything)
- [x] **Phase 2** — Widen the provider type + add the `local` adapter
- [x] **Phase 3** — Swap AI calls onto plugin fetch
- [x] **Phase 4** — Settings persistence for new keys
- [x] **Phase 5** — Free-text model entry (Settings + Onboarding)
- [x] **Phase 6** — Base URL + Test connection UI
- [x] **Phase 7** — Context window field + compaction fix
- [x] **Phase 8** — Disable voice on local
- [x] **Phase 9** — Reasoning stream handling (was: `<think>` tag handling)
- [x] **Phase 10** — Error messaging + i18n
- [~] **Phase 11** — Acceptance run (automated parts done; GUI walkthrough outstanding)

> **Phase 1 is a hard gate.** Its findings can invalidate the decisions in Phases 3 and 7. Do not start Phase 2 until Phase 1's two questions are answered in writing at the bottom of this document.

## Context

OpenGnothia is a local-first, privacy-focused AI self-therapy desktop app (Tauri 2 + React 19 + Vite + TypeScript + Zustand + Tailwind 4). All user data lives on-device in SQLite. This is a **fork** of `Lepuz-coder/opengnothia` at `v1.8.1`; the work is fork-only but should extend the existing provider architecture rather than hack around it, so upstreaming stays possible.

**The gap.** Despite the "your data never leaves your device" promise, every therapy session streams to OpenAI or Anthropic. There is **no existing Ollama or opencode wiring** — zero references in the codebase. What does exist is a `customBaseUrl` setting that is fully plumbed from the store through ~20 call sites into the OpenAI adapter, but has **no UI to set it**. This plan completes that last mile.

**Decisions already made** (do not relitigate):

| Decision | Choice |
|---|---|
| Framing | Privacy completion, not cost saving — so voice/STT/TTS is in scope |
| Target endpoint | Ollama via its OpenAI-compatible `/v1` shim; generic custom URLs fall out for free |
| CORS fix | Add `tauri-plugin-http`, route through Rust |
| Fetch routing | **All** AI calls, not just local (one code path) |
| Provider shape | New `"local"` provider entry, not URL-sniffing on `"openai"` |
| Context window | Manual number field, default 8192 |
| Voice on local | Disabled with a stated reason |
| Audience | Technical — no Ollama auto-detect, no install hand-holding |
| i18n | All 8 locale files updated; EN + TR written properly, rest fall back to English text |

**Entry points the receiving agent should read first:**

- `src/types/index.ts:7` — `AIProvider = "openai" | "anthropic"`, the closed union to widen
- `src/constants/providers.ts` — the `providers` array, model table, and `modelSupports*` helpers
- `src/services/ai/providers.ts` — the two adapters; `openaiAdapter` already honours `customBaseUrl` (L79, L120), `anthropicAdapter` hardcodes its URL twice
- `src/services/ai/aiService.ts:23,73` — the two `fetch` call sites; L86 `getReader()` is the streaming loop
- `src/stores/useSettingsStore.ts` — `customBaseUrl` exists; `setProvider` does per-provider key/thinking swapping
- `src/lib/store.ts` — `STORE_DEFAULTS`, the Tauri store schema
- `src/App.tsx:54,114` — settings load from store on boot
- `src/pages/SettingsPage.tsx:507` — the AI tab provider/key block; L142 save; L314 reset
- `src/components/onboarding/ApiSetupStep.tsx` — the same controls again, for first run
- `src/pages/SessionPage.tsx:526` and `src/pages/CoursesPage.tsx:1349` — compaction, guarded by `ctxWindow > 0`
- `src/components/session/ContextUsageIndicator.tsx:84` — gauge, hidden when `contextWindow` is 0
- `src-tauri/src/lib.rs:399` — the `tauri::Builder` plugin chain
- `src-tauri/capabilities/default.json` — permissions; needs an HTTP scope entry

**Known-good facts** (verified, don't re-derive):

- `csp` is `null` in `tauri.conf.json`, so CSP is **not** the blocker. CORS is.
- Tauri webview origin is `tauri://localhost` (macOS/Linux) / `http://tauri.localhost` (Windows). Ollama rejects it unless `OLLAMA_ORIGINS` is set — which is exactly what plugin-http avoids.
- `costCalculator.ts:14` returns `$0` for unknown models. For local inference this is already correct; no work needed.
- `token_usage.provider` is plain `TEXT` with no CHECK constraint (`005_add_token_usage.sql`), so a new provider id needs no migration.
- `createMarkerStrippedStream.ts` strips the **session-end marker only** — it is not a `<think>` stripper.
- `Select.tsx` renders a plain `<select>`; it cannot do free text.

---

## Phase 0 — Pre-flight

1. Branch from `master`: `git checkout -b feat/local-llm-support`.
2. Confirm Ollama is installed and a model is pulled (`ollama list`). If not: `ollama pull gemma3:27b` or similar.
3. Confirm `curl http://localhost:11434/v1/models` returns JSON from a terminal — this proves the server works before we blame the app.

---

## Phase 1 — 🚦 Spike: `tauri-plugin-http` streaming

**This phase exists to answer two questions. Nothing else is worth building until both are answered.**

> **Q1 — Does SSE stream token-by-token through the plugin, for all three providers?**
> If no, the "all providers" decision collapses. Fallback: keep browser `fetch` for cloud, use plugin fetch for local only; or abandon the plugin and ship an `OLLAMA_ORIGINS` help modal instead.
>
> **Q2 — Does Ollama's `/v1` shim return usage on streamed responses (`stream_options: {include_usage: true}`)?**
> If no, `currentInputTokens` stays 0, the context gauge never moves, and **compaction never fires even after Phase 7 sets a context window**. Fallback: client-side token estimation for local providers.

### Steps

1. `pnpm add @tauri-apps/plugin-http`
2. Add to `src-tauri/Cargo.toml` `[dependencies]`: `tauri-plugin-http = "2"`
3. Register in `src-tauri/src/lib.rs` in the builder chain at ~L400: `.plugin(tauri_plugin_http::init())`
4. Add HTTP scope to `src-tauri/capabilities/default.json`. **Deliberately not a wildcard** — this is a privacy app:
   ```json
   {
     "identifier": "http:default",
     "allow": [
       { "url": "http://localhost:*" },
       { "url": "http://127.0.0.1:*" },
       { "url": "https://api.openai.com/*" },
       { "url": "https://api.anthropic.com/*" }
     ]
   }
   ```
   Note: a user-entered URL on some other host will be **denied by scope**, not by network. Phase 10 must surface that distinctly.
5. Write a throwaway spike (scratch component or a temporary button on Settings) that imports `fetch` from `@tauri-apps/plugin-http` and streams:
   - Ollama `POST http://localhost:11434/v1/chat/completions` with `stream: true`, `stream_options: {include_usage: true}`
   - OpenAI, same shape
   - Anthropic `POST /v1/messages` with `stream: true`
6. For each, log chunk arrival timestamps to confirm **incremental** delivery, not one buffered blob.
7. For Ollama, log whether any chunk carries a `usage` object.

### Verification

- [ ] Chunks arrive incrementally (timestamps spread over the response, not clustered at the end) for all three providers
- [ ] Ollama usage presence recorded — **write the answer into the Spike Findings section at the bottom of this file**
- [ ] Delete the spike code before Phase 2

---

## Phase 2 — Widen the provider type + `local` adapter

1. `src/types/index.ts:7` → `export type AIProvider = "openai" | "anthropic" | "local";`
2. Run `pnpm tsc --noEmit`. The compiler will enumerate every site that must change — work that list. Expect `adapters` record in `providers.ts`, `costCalculator.ts`, `errorMessages.ts`.
3. Add to the `providers` array in `src/constants/providers.ts`:
   ```ts
   {
     id: "local",
     name: "Local (Ollama / OpenAI-compatible)",
     description: "Runs on your machine — nothing leaves the device",
     baseUrl: "http://localhost:11434/v1",
     requiresKey: false,
     models: [],   // user-entered
   }
   ```
   `requiresKey: false` already has a code path: `ApiSetupStep.tsx` has `canProceed = apiKey.length > 0 || !currentProvider?.requiresKey`, and `SettingsPage.tsx:516` gates the key input on `requiresKey`.
4. Add `localAdapter` to `src/services/ai/providers.ts`. Build it from `openaiAdapter` but:
   - Force `isReasoningModel()` to `false` — an Ollama model name will never match `/^o\d/` or `/^gpt-5/`, but be explicit so a model literally named `gpt-5-something` on a local server doesn't get routed to the Responses API.
   - Default `baseUrl` to the local one rather than `https://api.openai.com/v1`.
   - Send `Authorization: Bearer ollama` when no key is set (Ollama ignores it; some shims require the header to exist).
5. Register in the `adapters` record.
6. `setProvider` in `useSettingsStore.ts` resets model to `newProvider?.models[0]?.id ?? state.model`. With `models: []` this leaves the previous cloud model name in place — wrong. Make it fall back to `""` for providers with an empty model list so the user is prompted to type one.

### Verification

- [ ] `pnpm tsc --noEmit` clean
- [ ] `pnpm build` succeeds
- [ ] "Local" appears in the provider dropdown; selecting it hides the API key field

---

## Phase 3 — Swap AI calls onto plugin fetch

Contingent on Phase 1 Q1. If Q1 was "no", implement the local-only variant instead and record that here.

1. In `src/services/ai/aiService.ts`, replace the global `fetch` at L23 (`sendMessage`) and L73 (`streamMessage`) with the plugin import.
2. Verify `abortSignal` passthrough still cancels a stream mid-flight — the stop button depends on it.
3. Remove `anthropic-dangerous-direct-browser-access: "true"` from both Anthropic request builders — going through Rust makes it unnecessary.
4. Fix the Anthropic adapter to honour `customBaseUrl` (two hardcoded `https://api.anthropic.com/v1/messages` strings in `formatRequest` and `formatStreamRequest`). Small consistency win, enables Anthropic proxies.

### Verification 🧪

- [ ] OpenAI streaming session works end-to-end (regression)
- [ ] Anthropic streaming session works end-to-end (regression)
- [ ] Stop button aborts mid-stream on both
- [ ] Token counts still recorded in Expenses

---

## Phase 4 — Settings persistence

Two new keys: `customBaseUrl` gains a UI (it already persists), and `customContextWindow` is new.

1. `src/lib/store.ts` — add `customContextWindow: 8192` to `STORE_DEFAULTS`.
2. `src/stores/useSettingsStore.ts` — add `customContextWindow: number` + `setCustomContextWindow`.
3. `src/App.tsx` — read it in the boot load (~L54) and include in `loadFromStore` (~L114). Note the existing spread guard pattern `...(x && { x })` will drop a `0` value; use `!= null` for the numeric key.
4. `src/pages/SettingsPage.tsx` — persist both in `handleSave` (~L142); reset both in the reset handler (~L314 store side, ~L346 state side).

### Verification

- [ ] Set a value, quit the app, relaunch — value survives
- [ ] Reset-to-defaults clears it back to 8192

---

## Phase 5 — Free-text model entry

Four controls total: chat model + memory model, in **both** `SettingsPage.tsx` and `ApiSetupStep.tsx`.

1. Rule: when `currentProvider.models.length === 0`, render an `<Input>` instead of a `<Select>`, with placeholder `gemma3:27b`.
2. Guard the `modelSupports*` calls — they look up the static table and will return `false` for any typed model, which correctly hides the thinking toggles. Confirm this rather than assume.
3. `RECOMMENDED_MODEL_ID` labelling logic must not blow up on an empty options array.

### Verification

- [ ] Can type an arbitrary model name in Settings and in Onboarding, for both chat and memory model
- [ ] OpenAI/Anthropic still show dropdowns, unchanged

---

## Phase 6 — Base URL + Test connection

1. In the AI Connection card (`SettingsPage.tsx:507`), show a **Base URL** `<Input>` when `provider === "local"`, bound to `customBaseUrl`, defaulted from the provider entry's `baseUrl`.
2. Same in `ApiSetupStep.tsx`.
3. Wire a **Test connection** button to the existing `testApiKey` in `aiService.ts` — it already accepts `customBaseUrl`. `ApiSetupStep.tsx` has the full loading/success/error pattern to copy.
4. `ApiSetupStep.tsx` has a provider-conditional "how to get an API key" link. For `local`, swap to an Ollama install link or hide it.
5. Only present the "nothing leaves your device" affordance when the host is `localhost` / `127.0.0.1` (risk R6) — a remote URL must not claim privacy.

### Verification

- [ ] Green tick against a running Ollama with **no `OLLAMA_ORIGINS` set and no Ollama restart**
- [ ] Clear failure when Ollama is stopped

---

## Phase 7 — Context window + compaction fix

Contingent on Phase 1 Q2.

1. Add a **Context window** number `<Input>` next to the model field, shown for providers with an empty model list. Default 8192. Note Ollama's own default `num_ctx` is 4096 unless the server is configured otherwise — the help text should say so.
2. `src/pages/SessionPage.tsx:526` and `src/pages/CoursesPage.tsx:1349`: change
   `const ctxWindow = modelConfig?.contextWindow ?? 0;`
   to fall back to `settings.customContextWindow` when there's no `modelConfig`.
3. `src/pages/SessionPage.tsx:1214` — same fallback so `ContextUsageIndicator` receives a non-zero value and renders.
4. **If Phase 1 Q2 was "no usage"**: add client-side estimation for local providers so `currentInputTokens` advances. A `chars/4` heuristic on the assembled prompt is sufficient to drive the 80% compaction trigger. Mark the gauge as approximate.

### Verification

- [ ] Context gauge visible and advancing during a local session
- [ ] Compaction fires at 80% — force it by setting the context window to something small (e.g. 2000) and talking past it
- [ ] Cloud providers unaffected — their `modelConfig` still wins

---

## Phase 8 — Disable voice on local

1. `src/pages/SessionPage.tsx:1006` — the mode picker cards. Disable the voice card when `provider === "local"`, with a one-line reason: speech-to-text and text-to-speech still require OpenAI.
2. `src/pages/SettingsPage.tsx:427` — the Voice tab. Disable or annotate for local.
3. If `preferredSessionMode === "voice"` and the user switches to local, coerce to `"chat"` so a stored preference can't silently start a voice session.
4. Leave `transcriptionService.ts` / `ttsService.ts` untouched but note in a comment that base-URL parameterisation is the extension point for future local audio.

### Verification

- [ ] Voice card is visibly unavailable with a reason on local
- [ ] Switching to local while `preferredSessionMode` is `voice` does not start a voice session
- [ ] Voice fully works on OpenAI/Anthropic (regression)

---

## Phase 9 — `<think>` tag handling

Reasoning-capable local models (`deepseek-r1`, `qwen3`, `gpt-oss`) emit `<think>…</think>` inline in the content stream. Nothing currently strips it, so it renders as therapist dialogue.

1. Add a `<think>` block stripper in the local adapter's `parseSSEEvent`, or as a stream transform alongside `createMarkerStrippedStream`. Route captured content to the thinking channel (`{ type: "thinking" }`) rather than discarding it.
2. Also handle Ollama's non-standard `delta.reasoning_content` field, which some model/version combinations emit instead of inline tags.
3. Must handle the tag being split across chunk boundaries — the existing `createMarkerStrippedStream` has the buffering pattern to copy.

### Verification

- [ ] Run a reasoning model (`ollama pull qwen3:8b`) — no raw `<think>` text in the chat bubble
- [ ] Reasoning content appears in the thinking pane

---

## Phase 10 — Error messaging + i18n

1. `src/services/ai/errorMessages.ts` takes a `provider` param — add local-specific cases distinguishing:
   - connection refused → "Ollama doesn't appear to be running"
   - 404 with a model-not-found body → "Model not pulled — run `ollama pull <name>`"
   - **scope denial** from plugin-http → "This URL isn't allowed; only localhost endpoints are permitted" (see Phase 1 step 4)
2. Add all new UI strings to all 8 locale files (`src/i18n/{de,en,es,fr,ja,pt,tr,zh}.ts`) plus the `Translations` interface in `src/i18n/index.ts`. The interface is closed — a missing key is a compile error. Write EN and TR properly; English text in the other six.

### Verification

- [ ] `pnpm tsc --noEmit` clean
- [ ] Stop Ollama mid-session → the error names Ollama, not a generic network failure

---

## Phase 11 — Acceptance run

Work the success criteria as a checklist:

- [ ] Ollama running, model pulled → Settings → Local → URL + model → **Test connection** green, **no env vars, no Ollama restart**
- [ ] Full therapy session streams token-by-token at comparable perceived latency
- [ ] Context gauge shows a real number; compaction fires at 80%
- [ ] Voice mode visibly unavailable with a reason
- [ ] Expenses shows the session at `$0` with real token counts
- [ ] **Zero regression**: OpenAI and Anthropic sessions work; pre-existing stored settings load unchanged
- [ ] **Turn Wi-Fi off mid-session — nothing changes**

The last one is the only end-to-end proof of the privacy claim. It takes five seconds. Don't skip it.

---

## Risk Register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | plugin-http buffers instead of streaming | Critical | Phase 1 gate; fallback to local-only plugin fetch |
| R2 | HTTP scope silently denies user URLs | High | Explicit localhost scope; distinct error copy in Phase 10 |
| R3 | Fetch swap regresses cloud users | High | Phase 3 verification is a release gate |
| R4 | Ollama returns no stream usage → compaction never fires despite Phase 7 | High | Phase 1 Q2; client-side token estimation fallback |
| R5 | `<think>` tags render as therapist speech | Medium | Phase 9 |
| R6 | User points at a remote URL and believes it's private | Medium | Host check before showing the privacy affordance (Phase 6) |
| R7 | Closed i18n interface breaks the build | Low | Phase 10 covers all 8 files |

---

## Spike Findings

_Completed. Phases 3, 7 and 9 are updated accordingly._

### Q1 — Does SSE stream incrementally through `tauri-plugin-http`? ✅ YES (confirmed at runtime)

**Runtime measurement**, via a temporary boot-time probe inside the real webview streaming
`gemma4:31b` from Ollama:

```
status=200  body is ReadableStream: true
chunks=134  bytes=29405  sawUsage=true
first chunk at 10110ms, last at 19709ms   (~57ms apart)
SPREAD=9599ms => INCREMENTAL (streams)
```

(The 10s to first chunk is Ollama loading a 19GB model into memory, not plugin latency.)
Usage is reported through the plugin as well. Corroborated by reading
`node_modules/@tauri-apps/plugin-http/dist-js/index.js` (v2.5.9), The plugin constructs a real `ReadableStream` whose `pull` handler
calls `invoke('plugin:http|fetch_read_body')` once per chunk, enqueuing incrementally and closing
when the IPC sends a terminating last-byte of `1`. `response.body.getReader()` in
`aiService.ts:86` therefore works unchanged.

**Decision: proceed with the all-providers swap as planned.**

> ⚠️ **Regression discovered — abort handling.** Cancellation does *not* surface as a
> `DOMException` named `AbortError`. The plugin throws `new Error('Request cancelled')`, and
> `controller.error(ERROR_REQUEST_CANCELLED)` is passed a **raw string**, so the stream reader
> rejects with a string rather than an `Error` at all. The guard in `aiService.ts:151` —
> `if (err instanceof DOMException && err.name === "AbortError")` — will not match, so pressing
> **stop** would surface a spurious error modal.
> **Phase 3 must widen that guard** to also treat a `'Request cancelled'` message (and a
> non-`Error` string rejection) as a user cancellation.

### Q2 — Does Ollama `/v1` return usage on streams? ✅ YES

Verified with `curl` against `gemma4:31b` and `qwen3:32b`. Both emit a final usage chunk before
`[DONE]`:

```json
{"choices":[],"usage":{"prompt_tokens":21,"completion_tokens":60,"total_tokens":81}}
```

The shape matches what `openaiAdapter.parseSSEEvent` already handles: `usage` present with
`choices` an empty array satisfies the existing `parsedData.choices.length === 0` branch.

**Decision: use reported usage. R4 is eliminated — no client-side estimation needed, and
Phase 7 step 4 is dropped.**

### Bonus — reasoning models (revises Phase 9 and R5)

Probed `qwen3:32b` through the `/v1` shim. The original R5 assumption was **wrong**:

- Reasoning arrives in **`delta.reasoning`** — *not* `reasoning_content`, and *not* as inline
  `<think>` tags.
- The reconstructed `content` string is clean; **no `<think>` tag ever leaks into it**. So there
  is no risk of raw reasoning rendering as therapist dialogue, and **no tag stripper is needed**.
- But the current adapter only reads `delta.content`, so reasoning is **silently discarded**.
  `qwen3:32b` spent 1183 completion tokens almost entirely on reasoning before emitting any
  content — meaning the user would stare at an empty bubble for a long time.

**Phase 9 is therefore simpler and more valuable than planned:** map `delta.reasoning` to
`{ type: "thinking" }` in the local adapter so the existing thinking pane lights up. Downgrade
R5 from "medium / renders as therapist speech" to "medium / long silent pause".

### ⚠️ Capability scope: invalid IPv6 pattern broke *everything* (found at runtime)

The first scope draft included `{ "url": "http://[::1]:*" }`. At runtime this produced:

```
error deserializing scope: `http://[::1]:*` is not a valid URL pattern:
tokenizer error: invalid name; must be at least length 1 (at char 1)
```

Two things matter here:

1. The `urlpattern` tokenizer rejects a **bracketed IPv6 literal**.
2. **One malformed entry invalidates the entire scope**, so *every* HTTP request failed — not
   just IPv6 ones. The app would have shipped with no working AI at all.

`cargo check` does **not** catch this: the capability JSON compiles fine and the scope is only
deserialized at runtime. **Any future change to the http scope must be exercised by actually
running the app.** The entry was removed; `localhost` covers the normal case.

### Scope-rejection wording (replaces a guess)

A deliberate request to a non-allowlisted host returned, verbatim:

```
url not allowed on the configured scope: https://example.com/
```

`errorMessages.ts` now anchors on `not allowed on the configured scope`, with the earlier
looser checks retained as a hedge.

### Environment

Rust was not installed at the start of this work; `rustup` 1.98.0 has since been installed with
`--profile default --no-modify-path` (~1.3 GB in `~/.rustup`, 11 MB in `~/.cargo`). **The shell
profile was deliberately not modified** — add `. "$HOME/.cargo/env"` to `~/.zshrc` for `cargo`
on the PATH in a normal terminal. Node is v25.8.0 via Homebrew, `pnpm` is not installed (used
via `npx pnpm@10`; Node 25 has dropped `corepack`).

pnpm warns that it skipped `esbuild`'s build script (`Ignored build scripts: esbuild@0.27.3`).
**This turned out to be harmless** — `vite build` succeeds (esbuild ships its binary as a
platform-specific optional dependency). No `onlyBuiltDependencies` entry needed; ignore the warning.


---

## Implementation Status (end of session 1)

Phases 0–10 are implemented on branch `feat/local-llm-support`. `tsc --noEmit` and `vite build`
are both clean. **Nothing is committed yet.**

### Deviations from the plan, and why

- **Phase 7 step 4 dropped.** Spike Q2 showed Ollama reports usage, so no client-side token
  estimation was needed.
- **Phase 9 rewritten.** No `<think>` stripper was built because the shim never emits the tags.
  The local adapter maps `delta.reasoning` (and `delta.reasoning_content` as a fallback for other
  shims) into the existing thinking pane instead.
- **`resolveContextWindow()` added** to `src/constants/providers.ts` rather than repeating the
  fallback at each of the three call sites.
- **`providerUsesCustomModels()` added** as the single predicate driving all conditional UI, so
  nothing sniffs URLs to decide whether a provider is local.
- **`handleSave` never persisted `customBaseUrl`** — a latent bug from before this work, since
  there was no UI to set it. Now persisted, alongside `customContextWindow`.
- **Abort handling widened** (see Spike Findings) — this was not in the original plan and would
  have been a shipped regression for *all* providers, not just local.

### Verified at runtime

- `cargo check` clean; the app builds and launches via `pnpm tauri dev`.
- Streaming through `tauri-plugin-http` from Ollama: **134 incremental chunks**, usage reported.
- Capability scope loads and correctly denies a non-allowlisted host (after the IPv6 fix).
- `tsc --noEmit` and `vite build` clean with the spike removed.

### GUI walkthrough

Confirmed by manual testing:

- [x] **Test connection** green from onboarding, with no `OLLAMA_ORIGINS` and no Ollama restart.
- [x] A local session streams end to end; token count climbs as expected.
- [x] Context gauge populated and advancing (observed 4000 / 80000).
- [x] Cost shows `0.00` with real token counts — confirms Ollama's usage chunk is parsed.
- [x] Voice card greyed out and not selectable under a local provider.

Still outstanding:

- [~] **Regression: OpenAI and Anthropic.** No API keys are available on this machine (both are
      subscriptions), so a real session cannot be run. Everything testable *without* a key has
      been verified, which narrows the gap considerably:

      | Aspect | Status |
      |---|---|
      | Capability scope admits `api.openai.com` | ✅ HTTP 401 with a genuine OpenAI error body |
      | Capability scope admits `api.anthropic.com` | ✅ HTTP 401 with a genuine Anthropic error body |
      | Transport streams SSE and handles chunk boundaries | ✅ measured against Ollama (134 chunks) |
      | Anthropic SSE parsing (text, thinking, both usage events, stop) | ✅ 5/5 fixture checks |
      | OpenAI Chat Completions + Responses API parsing | ✅ 5/5 fixture checks |
      | Request construction | unchanged, bar two intended edits |

      **What still genuinely requires a key:** one real streaming session per provider, end to
      end. Given the above, the residual risk is low but not zero — the fixtures encode the
      event shapes as understood, and a live stream could still differ in ordering or in some
      event type not covered.

      The 12 fixture assertions were run from a temporary in-app probe and then removed. There
      is no test framework in this repo; if one is ever added, those assertions are worth
      keeping as a regression suite for adapter parsing.

### Field note: context window vs. Ollama's real `num_ctx`

Testing used `gemma4` with the app's context window set to 80000. `ollama ps` reported the
server actually serving **262144** (gemma4's Modelfile sets it, so the 4096 default never
applies). The app-side number being *lower* than the server's is safe — it just compacts
earlier than necessary. The dangerous direction is the reverse: if the app's number exceeds the
server's real `num_ctx`, compaction fires too late and Ollama silently drops the earliest turns.
Check with `ollama ps` (CONTEXT column) when using a model whose Modelfile doesn't raise it.

### Other notes

- **Six locales carry English text** for the new keys, per the fork-only scope decision. EN and
  TR are written properly.
- Nothing is committed; the whole change is in the working tree on `feat/local-llm-support`.
