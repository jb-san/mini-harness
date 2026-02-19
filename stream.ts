export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamResult {
  toolCalls: ToolCall[];
  assistantText: string;
}

export async function streamResponse(
  url: string,
  body: Record<string, unknown>,
): Promise<StreamResult> {
  const reqBody = JSON.stringify(body);
  console.log(`\n[debug] >>> POST ${url}`);
  console.log(`[debug] >>> body: ${reqBody.slice(0, 500)}`);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: reqBody,
  });

  console.log(`[debug] <<< status: ${response.status} ${response.statusText}`);

  if (!response.ok) {
    const errorText = await response.text();
    console.log(`[debug] <<< error body: ${errorText}`);
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, ToolCall>();
  let assistantText = "";
  let buffer = "";

  const STREAM_TIMEOUT_MS = 60_000;

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

      // Text content
      if (delta.content) {
        process.stdout.write(delta.content);
        assistantText += delta.content;
      }

      // Reasoning content (model-specific, e.g. GLM)
      if (delta.reasoning_content) {
        process.stdout.write(delta.reasoning_content);
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls.has(idx)) {
            console.log(`\n[debug] new tool_call idx=${idx} id=${tc.id} name=${tc.function?.name}`);
            toolCalls.set(idx, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: "",
            });
          }
          const existing = toolCalls.get(idx)!;
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments != null) existing.arguments += tc.function.arguments;
        }
      }

      // Check for finish
      if (choice.finish_reason === "length") {
        console.log(`\n[warn] model hit max_tokens limit — output may be truncated`);
      }
    }
  }

  const result = { toolCalls: [...toolCalls.values()], assistantText };
  console.log(`\n[debug] stream done. toolCalls=${result.toolCalls.length}`);
  if (result.toolCalls.length > 0) {
    console.log(`[debug] toolCalls:`, JSON.stringify(result.toolCalls, null, 2));
  }
  return result;
}
