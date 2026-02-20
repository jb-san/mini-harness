import { toolDefinitions, executeTool } from "./tools";
import { systemPrompt } from "./prompts/system";
import { streamResponse, type StreamCallbacks } from "./stream";
import { debug } from "./ui/debug";

const LLM_BASE_URL = "http://localhost:1234/v1";
const CHAT_URL = `${LLM_BASE_URL}/chat/completions`;
const MAX_ITERATIONS = 100;

// --- Types ---

type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface UICallbacks {
  onIterationStart: (iteration: number) => void;
  onContentChunk: (chunk: string) => void;
  onReasoningChunk: (chunk: string) => void;
  onToolStart: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: string) => void;
  onToolError: (name: string, error: string) => void;
  onAssistantDone: (text: string) => void;
  onError: (error: string) => void;
  onContextUpdate: (info: {
    model: string;
    tokensUsed: number;
    maxTokens: number;
  }) => void;
}

// --- Agent loop ---

const MODEL = "zai-org/glm-4.7-flash";
const MAX_TOKENS = 202752;

export function createSession() {
  const messages: Message[] = [{ role: "system", content: systemPrompt }];

  return {
    messages,
    async run(prompt: string, ui: UICallbacks) {
      return runWithMessages(messages, prompt, ui);
    },
  };
}

async function runWithMessages(
  messages: Message[],
  prompt: string,
  ui: UICallbacks,
) {
  messages.push({ role: "user", content: prompt });

  const chatTools = toolDefinitions.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  let iteration = 0;
  while (true) {
    iteration++;
    if (iteration > MAX_ITERATIONS) {
      ui.onError(`Max iterations (${MAX_ITERATIONS}) reached`);
      break;
    }
    ui.onIterationStart(iteration);

    const streamCallbacks: StreamCallbacks = {
      onContent: (chunk) => ui.onContentChunk(chunk),
      onReasoning: (chunk) => ui.onReasoningChunk(chunk),
    };

    let toolCalls: Awaited<ReturnType<typeof streamResponse>>["toolCalls"];
    let assistantText: string;
    let usage: Awaited<ReturnType<typeof streamResponse>>["usage"];
    try {
      ({ toolCalls, assistantText, usage } = await streamResponse(
        CHAT_URL,
        {
          messages,
          model: MODEL,
          stream: true,
          max_tokens: MAX_TOKENS,
          stream_options: { include_usage: true },
          tools: chatTools,
        },
        streamCallbacks,
      ));
    } catch (err) {
      ui.onError(String(err));
      break;
    }

    if (usage) {
      ui.onContextUpdate({
        model: MODEL,
        tokensUsed: usage.total_tokens,
        maxTokens: MAX_TOKENS,
      });
    }

    // Add assistant message to history
    if (toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
    } else {
      if (assistantText) {
        messages.push({ role: "assistant", content: assistantText });
      }
      ui.onAssistantDone(assistantText);
      break;
    }

    // Execute tools
    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.arguments || "{}");
      } catch {
        const error = `Failed to parse arguments: ${tc.arguments}`;
        ui.onToolError(tc.name, error);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error }),
        });
        continue;
      }

      ui.onToolStart(tc.name, args);

      let result: string;
      try {
        result = await executeTool(tc.name, args);
      } catch (err) {
        result = JSON.stringify({ error: String(err) });
        ui.onToolError(tc.name, String(err));
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
        continue;
      }

      ui.onToolResult(tc.name, result);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });
    }

    debug(`sending tool results back (${toolCalls.length} results)`);
  }
}
