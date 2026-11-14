export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-5-20250929";

/** One Claude messages call. Recognition and the measurement reader both use this request shape. */
export function postAnthropicMessages(input: {
  apiKey: string;
  model: string;
  maxTokens: number;
  images: { mediaType: string; data: string }[];
  text: string;
  timeoutMs?: number;
}): Promise<Response> {
  return fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    signal: AbortSignal.timeout(input.timeoutMs ?? 25_000),
    headers: { "x-api-key": input.apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens,
      messages: [{ role: "user", content: [
        ...input.images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
        { type: "text", text: input.text },
      ]}],
    }),
  });
}
