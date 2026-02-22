import { createSession, type UICallbacks } from "./core";
import { subAgentPrompt } from "./prompts/sub_agent";
import { mkdir } from "fs/promises";

const agentId = process.env.AGENT_ID;
if (!agentId) {
  console.error("AGENT_ID env var is required");
  process.exit(1);
}

const prompt = process.argv.slice(2).join(" ");
if (!prompt) {
  console.error("Usage: AGENT_ID=a001 bun agent.ts <prompt>");
  process.exit(1);
}

const context = process.env.AGENT_CONTEXT;
const agentDir = `.mini-harness/agents/${agentId}`;
await mkdir(agentDir, { recursive: true });

const outputPath = `${agentDir}/output.jsonl`;
const resultPath = `${agentDir}/result.json`;
const metaPath = `${agentDir}/meta.json`;

// Append a line to the output JSONL log
async function appendOutput(entry: Record<string, unknown>) {
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + "\n";
  const file = Bun.file(outputPath);
  const existing = await file.exists() ? await file.text() : "";
  await Bun.write(outputPath, existing + line);
}

let stepsCount = 0;
let totalTokens = 0;
const startedAt = new Date().toISOString();

const callbacks: UICallbacks = {
  onIterationStart(iteration) {
    stepsCount = iteration;
  },
  onReasoningChunk(chunk) {
    appendOutput({ type: "reasoning", content: chunk });
  },
  onContentChunk(chunk) {
    appendOutput({ type: "content", content: chunk });
  },
  onToolStart(name, args) {
    appendOutput({ type: "tool_call_start", name, args });
  },
  onToolResult(name, result) {
    appendOutput({ type: "tool_call", name, result: result.slice(0, 2000) });
  },
  onToolError(name, error) {
    appendOutput({ type: "tool_error", name, error });
  },
  onAssistantDone(text) {
    appendOutput({ type: "done", content: text });
  },
  onError(error) {
    appendOutput({ type: "error", content: error });
  },
  onContextUpdate(info) {
    totalTokens = info.tokensUsed;
  },
};

// Build the full prompt with optional context
const fullPrompt = context ? `[Context from parent agent]\n${context}\n\n[Task]\n${prompt}` : prompt;

const session = createSession({
  agentId,
  systemPrompt: subAgentPrompt(agentId),
  isSubAgent: true,
});

try {
  await session.run(fullPrompt, callbacks);

  // Get final response from message history
  const lastMsg = session.messages.findLast(
    (m) => m.role === "assistant" && typeof m.content === "string" && m.content,
  );
  const finalResponse = lastMsg && "content" in lastMsg ? (lastMsg.content as string) : "";

  const result = {
    agent_id: agentId,
    status: "completed" as const,
    final_response: finalResponse,
    steps_count: stepsCount,
    tokens_used: totalTokens,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };

  await Bun.write(resultPath, JSON.stringify(result, null, 2));

  // Update meta
  const meta = await Bun.file(metaPath).json();
  meta.status = "completed";
  meta.finished_at = result.finished_at;
  await Bun.write(metaPath, JSON.stringify(meta, null, 2));
} catch (err) {
  const result = {
    agent_id: agentId,
    status: "error" as const,
    error: String(err),
    steps_count: stepsCount,
    tokens_used: totalTokens,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };

  await Bun.write(resultPath, JSON.stringify(result, null, 2));

  // Update meta
  try {
    const meta = await Bun.file(metaPath).json();
    meta.status = "error";
    meta.finished_at = result.finished_at;
    await Bun.write(metaPath, JSON.stringify(meta, null, 2));
  } catch {
    // best effort
  }

  process.exit(1);
}
