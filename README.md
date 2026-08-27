<div align="center">
  <img src="src/assets/logo.svg" alt="OpenGnothia Logo" width="120" />
  <h1>OpenGnothia — Local Host</h1>
  <p><strong>A fork of <a href="https://github.com/Lepuz-coder/opengnothia">OpenGnothia</a> that adds local LLM support.</strong></p>
  <p><em>Run every therapy session against a model on your own machine. Nothing leaves the device.</em></p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
  [![Fork of](https://img.shields.io/badge/fork%20of-Lepuz--coder%2Fopengnothia-lightgrey.svg)](https://github.com/Lepuz-coder/opengnothia)
  [![Local LLM](https://img.shields.io/badge/local-Ollama%20%7C%20OpenAI--compatible-2ea44f.svg)](#running-against-a-local-model)
</div>

---

## Read this first

This is **not** the main project. It is a fork of [Lepuz-coder/opengnothia](https://github.com/Lepuz-coder/opengnothia) (forked at `v1.8.1`) that exists to fill exactly one gap: running the app against a **local LLM**.

> **If upstream adds local model support, use upstream.** This fork exists only to fill that gap, and not to compete with the original.

Everything else — the therapy schools, journal, dream analysis, insights, mood tracking, breathing exercises, courses, the whole UI — is upstream's work. Read the [upstream README](docs/UPSTREAM_README.md) for the full feature tour and screenshots. Bug reports about anything other than local-model support belong [upstream](https://github.com/Lepuz-coder/opengnothia/issues).

---

## Why this fork exists

Upstream promises "your data never leaves your device," and that is true of your *storage* — sessions, journals, and insights all live in local SQLite. But every therapy message still streams to OpenAI or Anthropic. For some (most) people that is not an issue, but for some (like me) it might be.

Point the app at Ollama (or any OpenAI-compatible server) and the entire session — prompt, transcript, summaries, insights — stays on your machine no wifi / internet access required.

Essentially this is a long-winded way of saying there is an additional dropdown in the settings menu.

---

## What this fork adds

| Change | Detail |
|---|---|
| **`Local` provider** | A third provider alongside Anthropic and OpenAI, defaulting to Ollama's OpenAI-compatible shim at `http://localhost:11434/v1`. Also works with LM Studio, llama.cpp, vLLM, and opencode. |
| **No CORS setup** | All AI traffic is routed through Tauri's Rust HTTP plugin instead of the webview's `fetch`. You do **not** need to set `OLLAMA_ORIGINS` or restart Ollama. |
| **Base URL + Test connection** | Editable endpoint with a one-click connection check, in both Settings and first-run onboarding. |
| **Free-text model names** | Local model names are arbitrary, so the model field accepts typed text instead of a fixed dropdown. |
| **Manual context window** | Local servers don't advertise their context size. Set it yourself so the context gauge and auto-compaction keep working — otherwise a long session silently overflows and drops its earliest turns. |
| **Keep model loaded** | Controls Ollama's `keep_alive`. Reloading a large model takes several seconds, and thinking/typing pauses routinely exceed Ollama's 5-minute default. Defaults to 30 minutes. |
| **Stop button** | Cancel an in-progress response mid-stream — far more useful when a local model is grinding out tokens slowly. |
| **Local-aware errors** | "Connection refused" now says *your server isn't running*, rather than surfacing a generic API failure. |
| **Voice disabled on local** | See below. |

Cloud providers behave exactly as they did upstream. Existing OpenAI and Anthropic users see no change.

---

## Voice is disabled

**Voice chat is turned off whenever a local provider is selected**, and the UI says why rather than failing quietly.

Speech-to-text and text-to-speech still require OpenAI — there is no local STT/TTS path in this build. Leaving voice enabled would mean your spoken therapy sessions were uploaded as audio to a third party while the app told you nothing was leaving your device. That's a worse privacy failure than the one this fork set out to fix, so voice mode is blocked instead: the mode selector greys it out, and a stored "voice" preference falls back to chat when you switch to a local provider.

If you select a cloud provider, upstream's voice mode is still there and still routes audio to OpenAI. **Privacy  applies to the local provider only.**

---

## Running against a local model

### 1. Install and start Ollama

```bash
# https://ollama.com/download
ollama pull gemma3:27b        # or any instruct-tuned model you like
ollama list                   # note the exact model name
curl http://localhost:11434/v1/models   # sanity check: should return JSON
```

A model with a large context window and good instruction-following makes for far better sessions than a small one. Therapy prompts are long.

### 2. Point the app at it

In **Settings → AI** (or during onboarding):

| Field | Value |
|---|---|
| Provider | `Local (Ollama / OpenAI-compatible)` |
| Base URL | `http://localhost:11434/v1` |
| Model name | exactly as `ollama list` reports it, e.g. `gemma3:27b` |
| Context window | your model's real context size in tokens |
| Keep model loaded | 30 minutes (default) |

No API key is required. Hit **Test connection** — green means you're done.

### 3. About that context window

Ollama defaults to a **4096-token** context unless `num_ctx` is configured on the model, regardless of what the model itself supports. Set the app's context window to match what your server will actually honour, not what the model's card advertises. If you set it too high, the server truncates silently; too low and the app compacts more often than it needs to.

Cost tracking will show `$0` for local models. That's correct, not a bug.

---

## Build from source

Prerequisites: [Node.js](https://nodejs.org/) v18+, [pnpm](https://pnpm.io/), [Rust](https://www.rust-lang.org/tools/install), and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
git clone https://github.com/Strain-solutions/opengnothia-local-host.git
cd opengnothia-local-host

pnpm install
pnpm tauri dev      # development
pnpm tauri build    # production build
```

---

## Contributing

Local-model fixes and improvements are welcome here. Anything else — new therapy schools, translations, UI work, general bug fixes — should go to [upstream](https://github.com/Lepuz-coder/opengnothia) so everyone benefits. The local LLM work was deliberately built on top of upstream's provider architecture rather than hacked around it, so it stays upstreamable.

Implementation notes and the full design record live in [docs/plans/local-llm-support.md](docs/plans/local-llm-support.md).

---

## Credits and license

All credit for OpenGnothia goes to **[Emirhan / Lepuz-coder](https://github.com/Lepuz-coder)** and the upstream contributors. This fork adds one feature to their work.

MIT, same as upstream — see [LICENSE](LICENSE).

> **Note:** OpenGnothia is a self-exploration tool, not a replacement for professional mental health care. If you are in crisis, please reach out to a licensed professional or a crisis helpline.
