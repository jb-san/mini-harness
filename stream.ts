import { debug } from "./ui/debug";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamResult {
  toolCalls: ToolCall[];
  assistantText: string;
}

export interface StreamCallbacks {
  onContent?: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  onToolCallStart?: (idx: number, id: string, name: string) => void;
}

export async function streamResponse(
  url: string,
  body: Record<string, unknown>,
  callbacks?: StreamCallbacks,
): Promise<StreamResult> {
  const reqBody = JSON.stringify(body);
  debug(">>> POST", url);
  debug(">>> body:", reqBody.slice(0, 500));

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: reqBody,
  });

  debug("<<< status:", response.status, response.statusText);

  if (!response.ok) {
    const errorText = await response.text();
    debug("<<< error body:", errorText);
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, ToolCall>();
  let assistantText = "";
  let buffer = "";
  let inThinkBlock = true; // model may omit opening <think>, assume thinking until </think>

  const STREAM_TIMEOUT_MS = 300_000; // 5 minutes

  while (true) {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Stream read timed out")), STREAM_TIMEOUT_MS),
    );
    const { done, value } = await Promise.race([reader.read(), timeout]);
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;

      let chunk: any;
      try {
        chunk = JSON.parse(line.slice(6));
      } catch {
        continue;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (!delta) continue;

      // Reasoning content (model-specific, e.g. GLM)
      if (delta.reasoning_content) {
        callbacks?.onReasoning?.(delta.reasoning_content);
      }

      // Text content — detect <think>...</think> blocks and route to reasoning
      if (delta.content) {
        let text: string = delta.content;
        while (text.length > 0) {
          if (inThinkBlock) {
            const endIdx = text.indexOf("</think>");
            if (endIdx !== -1) {
              // Send everything before </think> as reasoning
              const reasoning = text.slice(0, endIdx);
              if (reasoning) callbacks?.onReasoning?.(reasoning);
              text = text.slice(endIdx + "</think>".length);
              inThinkBlock = false;
            } else {
              // Entire chunk is still thinking
              callbacks?.onReasoning?.(text);
              text = "";
            }
          } else {
            const startIdx = text.indexOf("<think>");
            if (startIdx !== -1) {
              // Content before <think> is real content
              const content = text.slice(0, startIdx);
              if (content) {
                callbacks?.onContent?.(content);
                assistantText += content;
              }
              text = text.slice(startIdx + "<think>".length);
              inThinkBlock = true;
            } else {
              // No think tags, all content
              callbacks?.onContent?.(text);
              assistantText += text;
              text = "";
            }
          }
        }
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls.has(idx)) {
            debug("new tool_call", `idx=${idx}`, `id=${tc.id}`, `name=${tc.function?.name}`);
            toolCalls.set(idx, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: "",
            });
            callbacks?.onToolCallStart?.(idx, tc.id ?? "", tc.function?.name ?? "");
          }
          const existing = toolCalls.get(idx)!;
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments != null) existing.arguments += tc.function.arguments;
        }
      }

      // Check for finish
      if (choice.finish_reason === "length") {
        debug("model hit max_tokens limit — output may be truncated");
      }
    }
  }

  const result = { toolCalls: [...toolCalls.values()], assistantText };
  debug("stream done.", `toolCalls=${result.toolCalls.length}`);
  if (result.toolCalls.length > 0) {
    debug("toolCalls:", JSON.stringify(result.toolCalls, null, 2));
  }
  return result;
}
