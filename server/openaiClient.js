/**
 * Shared OpenAI Chat Completions helper.
 * The API key is always passed in by the caller and must never be logged.
 */

export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function buildOpenAiError(status) {
  if (status === 401 || status === 403) {
    return new Error("OpenAI rejected the API key.");
  }
  if (status === 429) {
    return new Error("OpenAI rate limit reached. Try again shortly.");
  }
  return new Error(`OpenAI request failed with status ${status}.`);
}

/**
 * Call OpenAI and parse a JSON object from the assistant message.
 * Uses response_format json_object for a classic structured reply.
 */
export async function callOpenAiJson({
  openAiApiKey,
  model = OPENAI_MODEL,
  systemPrompt,
  userPayload,
  temperature = 0.4,
  signal,
}) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json",
    },
    signal,
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            typeof userPayload === "string"
              ? userPayload
              : JSON.stringify(userPayload),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw buildOpenAiError(response.status);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("OpenAI returned an empty response.");
  }

  try {
    return JSON.parse(content);
  } catch {
    throw new Error("OpenAI returned invalid JSON.");
  }
}

/**
 * Stream plain-text tokens from OpenAI (SSE).
 * Calls onDelta(textChunk) as soon as each piece arrives.
 */
export async function streamOpenAiText({
  openAiApiKey,
  model = OPENAI_MODEL,
  systemPrompt,
  userPayload,
  temperature = 0.5,
  signal,
  onDelta,
}) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json",
    },
    signal,
    body: JSON.stringify({
      model,
      temperature,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            typeof userPayload === "string"
              ? userPayload
              : JSON.stringify(userPayload),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw buildOpenAiError(response.status);
  }

  if (!response.body) {
    throw new Error("OpenAI returned an empty stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }

      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      const piece = parsed.choices?.[0]?.delta?.content;
      if (typeof piece === "string" && piece.length > 0) {
        fullText += piece;
        onDelta(piece);
      }
    }
  }

  if (!fullText.trim()) {
    throw new Error("OpenAI returned an empty streamed reply.");
  }

  return fullText;
}
