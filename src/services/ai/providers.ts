import type { AIProvider, ChatMessage, ThinkingLevel, ThinkingType, TokenUsage } from "@/types";
import { modelRequiresAdaptiveThinking } from "@/constants/providers";

interface SendMessageParams {
  provider: AIProvider;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  systemPrompt: string;
  customBaseUrl?: string;
  thinkingEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
  thinkingType?: ThinkingType;
  maxTokens?: number;
}

interface StreamRequestParams extends SendMessageParams {
  thinkingEnabled: boolean;
  thinkingLevel?: ThinkingLevel;
  thinkingType?: ThinkingType;
}

const THINKING_BUDGETS: Record<ThinkingLevel, { budget_tokens: number; max_tokens: number }> = {
  low: { budget_tokens: 5000, max_tokens: 16000 },
  medium: { budget_tokens: 10000, max_tokens: 16000 },
  high: { budget_tokens: 25000, max_tokens: 32000 },
  max: { budget_tokens: 50000, max_tokens: 64000 },
};

const ADAPTIVE_EFFORT: Record<ThinkingLevel, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
};

const ADAPTIVE_MAX_TOKENS: Record<ThinkingLevel, number> = {
  low: 16000,
  medium: 16000,
  high: 32000,
  max: 64000,
};

const OPENAI_REASONING_EFFORT: Record<ThinkingLevel, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
};

const OPENAI_THINKING_TOKENS: Record<ThinkingLevel, number> = {
  low: 16000,
  medium: 25000,
  high: 50000,
  max: 100000,
};

export type StreamChunk =
  | { type: "thinking"; content: string }
  | { type: "text"; content: string }
  | { type: "done" }
  | { type: "done_with_usage"; usage: TokenUsage }
  | { type: "usage_delta"; inputTokens?: number; outputTokens?: number }
  | { type: "error"; message: string };

interface ProviderAdapter {
  formatRequest(params: SendMessageParams): { url: string; init: RequestInit };
  parseResponse(data: unknown): { content: string; usage: TokenUsage | null };
  formatStreamRequest(params: StreamRequestParams): { url: string; init: RequestInit };
  parseSSEEvent(eventType: string, data: string): StreamChunk | StreamChunk[] | null;
}

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";

function isReasoningModel(model: string): boolean {
  return /^o\d/.test(model) || /^gpt-5/.test(model);
}

const openaiAdapter: ProviderAdapter = {
  formatRequest({ apiKey, model, messages, systemPrompt, customBaseUrl, thinkingEnabled, thinkingLevel, maxTokens }) {
    const baseUrl = customBaseUrl || "https://api.openai.com/v1";
    const isReasoning = isReasoningModel(model);
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: isReasoning ? "developer" : "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };
    if (!isReasoning) {
      body.temperature = 0.7;
      if (maxTokens) body.max_tokens = maxTokens;
    }
    if (isReasoning && thinkingEnabled) {
      body.reasoning_effort = OPENAI_REASONING_EFFORT[thinkingLevel ?? "medium"];
      body.max_completion_tokens = maxTokens || OPENAI_THINKING_TOKENS[thinkingLevel ?? "medium"];
    }
    return {
      url: `${baseUrl}/chat/completions`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
    };
  },
  parseResponse(data: unknown): { content: string; usage: TokenUsage | null } {
    const d = data as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const content = d.choices[0]?.message?.content ?? "";
    const usage = d.usage
      ? { inputTokens: d.usage.prompt_tokens, outputTokens: d.usage.completion_tokens }
      : null;
    return { content, usage };
  },
  formatStreamRequest({ apiKey, model, messages, systemPrompt, customBaseUrl, thinkingEnabled, thinkingLevel }) {
    const baseUrl = customBaseUrl || "https://api.openai.com/v1";
    const isReasoning = isReasoningModel(model);

    // Use Responses API when thinking is enabled for reasoning models
    if (isReasoning && thinkingEnabled) {
      const body: Record<string, unknown> = {
        model,
        stream: true,
        instructions: systemPrompt,
        input: messages.map((m) => ({ role: m.role, content: m.content })),
        reasoning: {
          effort: OPENAI_REASONING_EFFORT[thinkingLevel ?? "medium"],
          summary: "detailed",
        },
        max_output_tokens: OPENAI_THINKING_TOKENS[thinkingLevel ?? "medium"],
      };
      return {
        url: `${baseUrl}/responses`,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        },
      };
    }

    // Chat Completions API for non-reasoning or thinking disabled
    const body: Record<string, unknown> = {
      model,
      stream: true,
      messages: [
        { role: isReasoning ? "developer" : "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };
    if (!isReasoning) {
      body.temperature = 0.7;
    }
    body.stream_options = { include_usage: true };
    return {
      url: `${baseUrl}/chat/completions`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
    };
  },
  parseSSEEvent(eventType: string, data: string): StreamChunk | StreamChunk[] | null {
    // Responses API: fall back to `type` field in JSON when `event:` header is absent.
    let effectiveType = eventType;
    let parsedData: any = null;
    if (data && data !== "[DONE]") {
      try {
        parsedData = JSON.parse(data);
        if (!effectiveType && typeof parsedData?.type === "string") {
          effectiveType = parsedData.type;
        }
      } catch { /* not JSON — leave parsedData null */ }
    }

    if (effectiveType === "response.reasoning_summary_part.added") {
      // New reasoning summary part — insert a blank line so consecutive parts don't run together
      return { type: "thinking", content: "\n\n" };
    }

    // If the reasoning output item completes, pull its summary text(s) into the thinking stream.
    // This fires before `response.completed`, so the user sees reasoning as soon as it's ready
    // — even when the API doesn't stream per-delta events for the summary.
    if (effectiveType === "response.output_item.done") {
      const item = parsedData?.item;
      if (item?.type === "reasoning" && Array.isArray(item.summary) && item.summary.length > 0) {
        const chunks: StreamChunk[] = [];
        for (const s of item.summary) {
          if (s?.type === "summary_text" && typeof s.text === "string" && s.text.length > 0) {
            chunks.push({ type: "thinking", content: s.text });
          }
        }
        if (chunks.length > 0) return chunks;
      }
    }

    // Generic reasoning/thinking delta capture: any Responses API event whose name contains
    // "reasoning" or "summary" and that carries a string `delta` field is treated as thinking.
    if (effectiveType && effectiveType.startsWith("response.") && typeof parsedData?.delta === "string") {
      const lower = effectiveType.toLowerCase();
      if (lower.includes("reasoning") || lower.includes("summary")) {
        return { type: "thinking", content: parsedData.delta };
      }
      if (lower.includes("output_text") || lower.endsWith(".text.delta")) {
        return { type: "text", content: parsedData.delta };
      }
    }

    if (effectiveType === "response.completed") {
      const chunks: StreamChunk[] = [];
      // Post-hoc fallback: if the API didn't stream a reasoning summary (no delta events fired),
      // pull the final summary text from the completed output so the user can still see it.
      const output = parsedData?.response?.output;
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item?.type === "reasoning" && Array.isArray(item.summary)) {
            for (const s of item.summary) {
              if (s?.type === "summary_text" && typeof s.text === "string" && s.text.length > 0) {
                chunks.push({ type: "thinking", content: s.text });
              }
            }
          }
        }
      }
      if (parsedData?.response?.usage) {
        chunks.push({
          type: "done_with_usage",
          usage: {
            inputTokens: parsedData.response.usage.input_tokens,
            outputTokens: parsedData.response.usage.output_tokens,
          },
        });
      } else {
        chunks.push({ type: "done" });
      }
      return chunks;
    }
    if (effectiveType === "error" || effectiveType === "response.failed") {
      return { type: "error", message: parsedData?.error?.message ?? "Stream error" };
    }

    // Chat Completions API events
    if (data === "[DONE]") return { type: "done" };
    if (!parsedData) return null;
    // Usage chunk (sent before [DONE] when stream_options.include_usage is true)
    if (parsedData.usage && (!parsedData.choices || parsedData.choices.length === 0 || !parsedData.choices[0]?.delta?.content)) {
      return {
        type: "done_with_usage",
        usage: {
          inputTokens: parsedData.usage.prompt_tokens,
          outputTokens: parsedData.usage.completion_tokens,
        },
      };
    }
    const delta = parsedData.choices?.[0]?.delta;
    if (!delta) return null;
    if (delta.content) {
      return { type: "text", content: delta.content };
    }
    return null;
  },
};

const anthropicAdapter: ProviderAdapter = {
  formatRequest({ apiKey, model, messages, systemPrompt, customBaseUrl, maxTokens, thinkingEnabled, thinkingLevel, thinkingType }) {
    const baseUrl = customBaseUrl || DEFAULT_ANTHROPIC_BASE_URL;
    const body: Record<string, unknown> = {
      model,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (thinkingEnabled) {
      const level = thinkingLevel ?? "medium";
      const useAdaptive = thinkingType === "adaptive" || modelRequiresAdaptiveThinking("anthropic", model);
      if (useAdaptive) {
        body.thinking = { type: "adaptive" };
        body.output_config = { effort: ADAPTIVE_EFFORT[level] };
        body.max_tokens = ADAPTIVE_MAX_TOKENS[level];
      } else {
        const budget = THINKING_BUDGETS[level];
        body.thinking = { type: "enabled", budget_tokens: budget.budget_tokens };
        body.max_tokens = budget.max_tokens;
      }
    } else {
      body.max_tokens = maxTokens || 8192;
    }
    return {
      url: `${baseUrl}/messages`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      },
    };
  },
  parseResponse(data: unknown): { content: string; usage: TokenUsage | null } {
    const d = data as {
      content: { type: string; text: string }[];
      usage?: { input_tokens: number; output_tokens: number };
    };
    const content = d.content.find((c) => c.type === "text")?.text ?? "";
    const usage = d.usage
      ? { inputTokens: d.usage.input_tokens, outputTokens: d.usage.output_tokens }
      : null;
    return { content, usage };
  },
  formatStreamRequest({ apiKey, model, messages, systemPrompt, customBaseUrl, thinkingEnabled, thinkingLevel, thinkingType }) {
    const baseUrl = customBaseUrl || DEFAULT_ANTHROPIC_BASE_URL;
    const body: Record<string, unknown> = {
      model,
      stream: true,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (thinkingEnabled) {
      const level = thinkingLevel ?? "medium";
      const useAdaptive = thinkingType === "adaptive" || modelRequiresAdaptiveThinking("anthropic", model);
      if (useAdaptive) {
        body.thinking = { type: "adaptive" };
        body.output_config = { effort: ADAPTIVE_EFFORT[level] };
        body.max_tokens = ADAPTIVE_MAX_TOKENS[level];
      } else {
        const budget = THINKING_BUDGETS[level];
        body.thinking = { type: "enabled", budget_tokens: budget.budget_tokens };
        body.max_tokens = budget.max_tokens;
      }
      // temperature must NOT be sent when thinking is enabled
    } else {
      body.max_tokens = 8192;
    }
    return {
      url: `${baseUrl}/messages`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      },
    };
  },
  parseSSEEvent(eventType: string, data: string): StreamChunk | null {
    if (eventType === "message_start") {
      try {
        const parsed = JSON.parse(data);
        const inputTokens = parsed.message?.usage?.input_tokens;
        if (inputTokens !== undefined) {
          return { type: "usage_delta", inputTokens };
        }
      } catch { /* ignore */ }
      return null;
    }
    if (eventType === "message_delta") {
      try {
        const parsed = JSON.parse(data);
        const outputTokens = parsed.usage?.output_tokens;
        if (outputTokens !== undefined) {
          return { type: "usage_delta", outputTokens };
        }
      } catch { /* ignore */ }
      return null;
    }
    if (eventType === "message_stop") return { type: "done" };
    if (eventType === "content_block_delta") {
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.delta;
        if (!delta) return null;
        if (delta.type === "thinking_delta" && delta.thinking) {
          return { type: "thinking", content: delta.thinking };
        }
        if (delta.type === "text_delta" && delta.text) {
          return { type: "text", content: delta.text };
        }
        return null;
      } catch {
        return null;
      }
    }
    if (eventType === "error") {
      try {
        const parsed = JSON.parse(data);
        return { type: "error", message: parsed.error?.message ?? "Stream error" };
      } catch {
        return { type: "error", message: "Stream error" };
      }
    }
    return null;
  },
};

export const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";

/**
 * Local / OpenAI-compatible endpoints (Ollama, opencode, LM Studio, llama.cpp, vLLM).
 *
 * Reuses the OpenAI Chat Completions shape, with three deliberate differences:
 *  - Never routes to the OpenAI Responses API. `isReasoningModel()` matches on model-name
 *    patterns, and a local server is free to serve a model literally named e.g. "gpt-5-foo";
 *    sending that to `/responses` would fail, so the reasoning path is forced off.
 *  - Defaults to the Ollama base URL rather than api.openai.com.
 *  - Understands `delta.reasoning`, which Ollama's /v1 shim uses to stream reasoning tokens
 *    for models like qwen3. It is not inline `<think>` tags and not `reasoning_content`;
 *    without this the reasoning is silently dropped and the user watches an empty bubble.
 */
const localAdapter: ProviderAdapter = {
  formatRequest({ apiKey, model, messages, systemPrompt, customBaseUrl, maxTokens }) {
    const baseUrl = customBaseUrl || DEFAULT_LOCAL_BASE_URL;
    const body: Record<string, unknown> = {
      model,
      temperature: 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };
    if (maxTokens) body.max_tokens = maxTokens;
    return {
      url: `${baseUrl}/chat/completions`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Ollama ignores the value but some OpenAI-compatible shims require the header.
          Authorization: `Bearer ${apiKey || "local"}`,
        },
        body: JSON.stringify(body),
      },
    };
  },
  parseResponse: openaiAdapter.parseResponse,
  formatStreamRequest({ apiKey, model, messages, systemPrompt, customBaseUrl }) {
    const baseUrl = customBaseUrl || DEFAULT_LOCAL_BASE_URL;
    const body: Record<string, unknown> = {
      model,
      stream: true,
      temperature: 0.7,
      // Verified against Ollama: yields a final {"choices":[],"usage":{...}} chunk,
      // which keeps the context gauge and auto-compaction working.
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };
    return {
      url: `${baseUrl}/chat/completions`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey || "local"}`,
        },
        body: JSON.stringify(body),
      },
    };
  },
  parseSSEEvent(_eventType: string, data: string): StreamChunk | StreamChunk[] | null {
    if (data === "[DONE]") return { type: "done" };
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return null;
    }

    // Final usage chunk carries an empty `choices` array.
    if (parsed.usage && (!parsed.choices || parsed.choices.length === 0)) {
      return {
        type: "done_with_usage",
        usage: {
          inputTokens: parsed.usage.prompt_tokens,
          outputTokens: parsed.usage.completion_tokens,
        },
      };
    }

    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return null;
    if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
      return { type: "thinking", content: delta.reasoning };
    }
    // Some shims follow the older convention instead.
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      return { type: "thinking", content: delta.reasoning_content };
    }
    if (delta.content) {
      return { type: "text", content: delta.content };
    }
    return null;
  },
};

const adapters: Record<AIProvider, ProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  local: localAdapter,
};

export function getAdapter(provider: AIProvider): ProviderAdapter {
  return adapters[provider] ?? openaiAdapter;
}
