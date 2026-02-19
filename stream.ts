export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamResult {
  toolCalls: ToolCall[];
  responseId: string | null;
}

export async function streamResponse(
  url: string,
  body: Record<string, unknown>,
): Promise<StreamResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<string, ToolCall>();
  let responseId: string | null = null;
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // Keep the last incomplete line in the buffer
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      // console.log(`\n ${line}\n`);
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;

      let event: any;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        continue;
      }

      switch (event.type) {
        case "response.created":
          responseId = event.response.id;
          break;
        case "response.reasoning_text.delta":
          process.stdout.write(event.delta);
          break;
        case "response.reasoning_text.done":
          process.stdout.write("\n\n---\n\n");
          break;
        case "response.output_text.delta":
          process.stdout.write(event.delta);
          break;
        case "response.function_call_arguments.done": {
          const tc = toolCalls.get(event.item_id) ?? {
            id: event.item_id,
            name: "",
            arguments: "",
          };
          tc.arguments += event.arguments;
          toolCalls.set(event.item_id, tc);
          break;
        }
        case "response.output_item.added": {
          if (event.item.type === "function_call") {
            toolCalls.set(event.item.id, {
              id: event.item.call_id,
              name: event.item.name,
              arguments: "",
            });
          }
          break;
        }
      }
    }
  }

  return { toolCalls: [...toolCalls.values()], responseId };
}
