import { toolDefinitions, executeTool } from "./tools";
import { systemPrompt } from "./prompts/system";
import { streamResponse } from "./stream";

const LLM_BASE_URL = "http://localhost:1234/v1";
const RESPONSES_URL = `${LLM_BASE_URL}/responses`;

// --- Main loop ---

let lastResponseId: string | null = null;

async function run(prompt: string) {
  let body: Record<string, unknown> = {
    input: [
      ...(lastResponseId ? [] : [{ role: "system", content: systemPrompt }]),
      { role: "user", content: prompt },
    ],
    ...(lastResponseId ? { previous_response_id: lastResponseId } : {}),
    model: "zai-org/glm-4.7-flash",
    stream: true,
    tools: toolDefinitions,
  };

  while (true) {
    const { toolCalls, responseId } = await streamResponse(RESPONSES_URL, body);
    lastResponseId = responseId;

    if (toolCalls.length === 0) break;

    const toolResults = await Promise.all(
      toolCalls.map(async (tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || "{}");
        } catch {
          console.log(
            `\n[tool] ${tc.name} — failed to parse args: ${tc.arguments}`,
          );
        }
        console.log(`\n[tool] ${tc.name}(${JSON.stringify(args)})`);
        const result = await executeTool(tc.name, args);
        console.log(`[tool] -> ${result.slice(0, 200)}`);
        return {
          type: "function_call_output",
          call_id: tc.id,
          output: result,
        };
      }),
    );

    body = {
      previous_response_id: lastResponseId,
      input: toolResults,
      model: "zai-org/glm-4.7-flash",
      stream: true,
      tools: toolDefinitions,
    };
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
