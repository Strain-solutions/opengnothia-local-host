import { fetch } from "@tauri-apps/plugin-http";

/**
 * Keeps a local Ollama model resident in memory between turns.
 *
 * Ollama unloads an idle model after ~5 minutes by default. Reloading a large model costs
 * ~10s, and the pauses in a therapy session — thinking, typing — routinely exceed five
 * minutes, so the wait lands exactly when the user has just finished composing a difficult
 * message.
 *
 * Two constraints discovered by testing against Ollama 0.32:
 *
 *  1. The OpenAI-compatible `/v1` endpoint **silently ignores** `keep_alive`. Only the native
 *     `/api/chat` and `/api/generate` endpoints honour it, so this has to be a side-channel
 *     call rather than a field on the chat request.
 *  2. Every `/v1` request **resets** the timer to the server default. So the touch must run
 *     *after* a completed response, never before, or it is immediately overwritten.
 *
 * Posting `{model, keep_alive, messages: []}` returns instantly with `done_reason: "load"` —
 * it generates no tokens and costs nothing.
 *
 * This is Ollama-specific. Other OpenAI-compatible servers (LM Studio, llama.cpp, vLLM) will
 * 404 on `/api/chat`, so every failure is swallowed: it is an optimisation, never a
 * correctness requirement, and must not surface an error to the user.
 */

/** Sentinel for "keep loaded until Ollama exits". */
export const KEEP_ALIVE_FOREVER = -1;
/** Sentinel for "leave it to the server default". */
export const KEEP_ALIVE_SERVER_DEFAULT = 0;

/** Turn an OpenAI-compatible base URL into the Ollama native API root. */
function nativeApiRoot(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    // Strip the OpenAI-compat suffix: http://localhost:11434/v1 -> http://localhost:11434
    const path = url.pathname.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

export function keepAliveValue(minutes: number): string | number {
  return minutes === KEEP_ALIVE_FOREVER ? -1 : `${minutes}m`;
}

/**
 * Fire-and-forget. Never throws, never reports. Call after a response completes.
 */
export async function touchKeepAlive(
  baseUrl: string,
  model: string,
  minutes: number,
): Promise<void> {
  if (!model || minutes === KEEP_ALIVE_SERVER_DEFAULT) return;
  const root = nativeApiRoot(baseUrl);
  if (!root) return;

  try {
    await fetch(`${root}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Empty messages => load-only, no generation.
      body: JSON.stringify({ model, keep_alive: keepAliveValue(minutes), messages: [] }),
    });
  } catch {
    // Not Ollama, server down, or endpoint absent — all fine, this is best-effort only.
  }
}
