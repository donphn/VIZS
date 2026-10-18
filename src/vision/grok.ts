/**
 * Minimal xAI (Grok) client over the OpenAI-compatible Chat Completions API.
 * No SDK: just the global fetch. Env is read lazily at call time so that
 * importing this module never throws (and dotenv can load later).
 */

export const DEFAULT_GROK_BASE_URL = "https://api.x.ai/v1";
/** grok-4.7 is xAI's current recommended chat model and accepts image input. */
export const DEFAULT_GROK_MODEL = "grok-4.7";
export const DEFAULT_TIMEOUT_MS = 60_000;

export type GrokContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "low" | "high" | "auto" };
    };

export interface GrokMessage {
  role: "system" | "user" | "assistant";
  content: string | GrokContentPart[];
}

export interface GrokChatOptions {
  /** Defaults to env GROK_MODEL, then DEFAULT_GROK_MODEL. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask for a JSON object response (response_format: json_object). */
  json?: boolean;
  timeoutMs?: number;
  /** Optional external abort signal. */
  signal?: AbortSignal;
}

export class GrokError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "GrokError";
  }
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
}

/**
 * Send a chat completion to Grok and return the assistant's text content.
 * Throws GrokError on missing key, HTTP errors, timeouts, or empty replies.
 */
export async function grokChat(
  messages: GrokMessage[],
  opts: GrokChatOptions = {},
): Promise<string> {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) throw new GrokError("GROK_API_KEY is not set");

  const baseUrl = (process.env.GROK_BASE_URL || DEFAULT_GROK_BASE_URL).replace(/\/+$/, "");
  const model = opts.model || process.env.GROK_MODEL || DEFAULT_GROK_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const body: Record<string, unknown> = { model, messages };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.json) body.response_format = { type: "json_object" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onExternalAbort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted && !opts.signal?.aborted) {
      throw new GrokError(`Grok request timed out after ${timeoutMs}ms`);
    }
    throw new GrokError(`Grok request failed: ${(err as Error)?.message ?? String(err)}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new GrokError(
      `Grok API error ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      res.status,
      text,
    );
  }

  let data: ChatCompletionResponse;
  try {
    data = JSON.parse(text) as ChatCompletionResponse;
  } catch {
    throw new GrokError(`Grok returned non-JSON response: ${text.slice(0, 200)}`, res.status, text);
  }
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new GrokError("Grok returned an empty response", res.status, text);
  return content;
}
