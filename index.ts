import { toolDefinitions, executeTool } from "./tools";
import { systemPrompt } from "./prompts/system";
import { streamResponse } from "./stream";

const LLM_BASE_URL = "http://localhost:1234/v1";
const CHAT_URL = `${LLM_BASE_URL}/chat/completions`;

// --- Main loop ---

type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

async function run(prompt: string) {
  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];

  const MAX_ITERATIONS = 20;
  let iteration = 0;
  while (true) {
    iteration++;
    if (iteration > MAX_ITERATIONS) {
      console.log(`\n[loop] max iterations (${MAX_ITERATIONS}) reached, stopping`);
      break;
    }
    console.log(`\n[loop] === iteration ${iteration} ===`);

    const body = {
      messages,
      model: "zai-org/glm-4.7-flash",
      stream: true,
      max_tokens: 4096,
      tools: toolDefinitions.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
    };

    let toolCalls: Awaited<ReturnType<typeof streamResponse>>["toolCalls"];
    let assistantText: string;
    try {
      ({ toolCalls, assistantText } = await streamResponse(CHAT_URL, body));
    } catch (err) {
      console.error(`\n[error] ${err}`);
      break;
    }

    // Add assistant message to history
    if (toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
    } else {
      if (assistantText) {
        messages.push({ role: "assistant", content: assistantText });
      }
      console.log(`[loop] no tool calls, breaking`);
      break;
    }

    // Execute tools and add results to history
    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.arguments || "{}");
      } catch {
        console.log(`\n[tool] ${tc.name} — failed to parse args: ${tc.arguments}`);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: `Failed to parse arguments: ${tc.arguments}` }),
        });
        continue;
      }
      console.log(`\n[tool] ${tc.name}(${JSON.stringify(args)})`);
      let result: string;
      try {
        result = await executeTool(tc.name, args);
      } catch (err) {
        result = JSON.stringify({ error: String(err) });
      }
      console.log(`[tool] -> ${result.slice(0, 200)}`);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });
    }

    console.log(`\n[loop] sending tool results back (${toolCalls.length} results)`);
  }

  console.log();
}

const prompt = (question: string): Promise<string> => {
  process.stdout.write(question);
  return new Promise((resolve) => {
    process.stdin.once("data", (data) => resolve(data.toString().trim()));
  });
};

console.log("Type a message (ctrl+c to quit)\n");
while (true) {
  const input = await prompt("> ");
  if (!input) continue;
  await run(input);
}

export {};
