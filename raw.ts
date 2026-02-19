import { appendFileSync, readFileSync } from "fs";
const LLM_BASE_URL = "http://localhost:1234/v1";

const routes = {
  models: `${LLM_BASE_URL}/models`,
  responses: `${LLM_BASE_URL}/responses`,
  completions: `${LLM_BASE_URL}/completions`,
};

// --- Tool definitions ---

const tools = [
  {
    type: "function",
    name: "get_weather",
    description: "Get the current weather for a location",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City name, e.g. 'San Francisco'",
        },
      },
      required: ["location"],
    },
  },
  {
    type: "function",
    name: "save_fact",
    description: "remember a fact and save it to disk ",
    parameters: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description: "a fact 'eg the capital of france is paris'",
        },
      },
      required: ["fact"],
    },
  },
  {
    type: "function",
    name: "load_facts",
    description: "retrive a fact from memory",
  },
];

// --- Tool implementations ---

function executeTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "get_weather":
      return JSON.stringify({
        location: args.location,
        temperature: "72°F",
        condition: "sunny",
      });
    case "save_fact":
      appendFileSync("memory.txt", args.fact + "\n");
      return JSON.stringify({ success: true });
    case "load_facts":
      const facts = readFileSync("memory.txt", "utf8").split("\n");
      return JSON.stringify({ facts });
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// --- Streaming helper ---

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

async function streamResponse(body: Record<string, unknown>): Promise<{
  toolCalls: ToolCall[];
  responseId: string | null;
}> {
  const response = await fetch(routes.responses, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const decoder = new TextDecoder();
  const reader = response.body!.getReader();
  const toolCalls = new Map<string, ToolCall>();
  let responseId: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const event = JSON.parse(line.slice(6));
      // console.log("\n");
      // console.log(event);
      // console.log("\n");
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

// --- Main loop ---

const systemPrompt = `You have a persistent memory stored on disk from previous sessions.

Rules:
1. BEFORE answering ANY question, call load_facts first.
2. If load_facts returns a fact that answers the question, reply with ONLY that fact. Do not elaborate, rephrase, or add anything.
3. If no relevant fact is found, answer normally.
4. When the user tells you something worth remembering, save it with save_fact.`;

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
    tools,
  };

  while (true) {
    const { toolCalls, responseId } = await streamResponse(body);
    lastResponseId = responseId;

    if (toolCalls.length === 0) break;

    // Execute each tool call and build the follow-up input
    const toolResults = toolCalls.map((tc) => {
      console.log("[tool arguments]", tc);
      const args = JSON.parse(tc.arguments);
      console.log(`\n[tool] ${tc.name}(${JSON.stringify(args)})`);
      const result = executeTool(tc.name, args);
      console.log(`[tool] -> ${result}`);
      return {
        type: "function_call_output",
        call_id: tc.id,
        output: result,
      };
    });

    // Continue the conversation with tool results
    body = {
      previous_response_id: lastResponseId,
      input: toolResults,
      model: "zai-org/glm-4.7-flash",
      stream: true,
      tools,
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
