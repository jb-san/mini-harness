import type { Message, ChatToolDef, StreamCallbacks } from "../ai/types.ts";
import type { LLMProvider } from "../ai/provider.ts";
import type { ToolRegistry } from "./tool-registry.ts";
import type { MessageBus } from "../mq/bus.ts";
import { debug } from "../ui/debug.ts";
import type { ActorEnvelope, ActorRuntime } from "../runtime/actor-runtime.ts";

const MAX_ITERATIONS = 100;

type AgentState = "idle" | "thinking" | "tool-wait";

export class Agent {
  private messages: Message[] = [];
  private state: AgentState = "idle";
  private draining = false;
  private model: string;
  private maxTokens: number;
  private _lastResponse = "";

  constructor(
    public readonly id: string,
    private bus: MessageBus,
    private runtime: ActorRuntime,
    private provider: LLMProvider,
    private registry: ToolRegistry,
    systemPrompt: string,
  ) {
    this.messages = [{ role: "system", content: systemPrompt }];

    // Extract model info from provider
    const providerAny = provider as any;
    this.model = typeof providerAny.getModel === "function" ? providerAny.getModel() : "unknown";
    this.maxTokens = typeof providerAny.getMaxTokens === "function" ? providerAny.getMaxTokens() : 0;
    this.runtime.registerActor(this.id, { onReady: () => this.wake() });
  }

  /** Full text (content + reasoning) from the last LLM call */
  get lastResponse(): string {
    return this._lastResponse;
  }

  /** Enqueue input and schedule async drain */
  send(text: string) {
    this.runtime.sendUserInput(this.id, text);
  }

  private wake() {
    if (this.draining) return;
    setTimeout(() => this.drain(), 0);
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (true) {
        const next = this.runtime.takeNext(this.id);
        if (!next) break;
        this.messages.push(this.toMessage(next));
        await this.runLoop();
      }
    } finally {
      this.draining = false;
      if (this.runtime.hasMessages(this.id)) {
        this.wake();
      }
    }
  }

  private toMessage(envelope: ActorEnvelope): Message {
    switch (envelope.kind) {
      case "user_input":
        return { role: "user", content: envelope.text };
      case "agent_message":
        return {
          role: "system",
          content:
            `[System event at ${envelope.timestamp}] Agent ${envelope.from} sent ` +
            `${envelope.to === "broadcast" ? "a broadcast message" : `you a message`}: ${envelope.body}`,
        };
      case "agent_completed":
        return {
          role: "system",
          content:
            `[System event at ${envelope.timestamp}] Sub-agent ${envelope.agentId} completed: ` +
            `${envelope.result || "(no output)"}`,
        };
      case "agent_error":
        return {
          role: "system",
          content:
            `[System event at ${envelope.timestamp}] Sub-agent ${envelope.agentId} failed: ${envelope.error}`,
        };
    }
  }

  private async runLoop() {
    const chatTools: ChatToolDef[] = this.registry.definitions.map((t) => ({
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
        this.bus.emit("llm:error", {
          agentId: this.id,
          error: `Max iterations (${MAX_ITERATIONS}) reached`,
        });
        this.state = "idle";
        break;
      }

      this.state = "thinking";
      this._lastResponse = "";

      const streamCallbacks: StreamCallbacks = {
        onContent: (chunk) => {
          this._lastResponse += chunk;
          this.bus.emit("llm:chunk:content", { agentId: this.id, text: chunk });
        },
        onReasoning: (chunk) => {
          this._lastResponse += chunk;
          this.bus.emit("llm:chunk:reasoning", { agentId: this.id, text: chunk });
        },
      };

      let result;
      try {
        result = await this.provider.chat(
          { messages: this.messages, tools: chatTools },
          streamCallbacks,
        );
      } catch (err) {
        this.bus.emit("llm:error", { agentId: this.id, error: String(err) });
        this.state = "idle";
        break;
      }

      if (result.usage) {
        this.bus.emit("context:update", {
          agentId: this.id,
          model: this.model,
          tokensUsed: result.usage.total_tokens,
          maxTokens: this.maxTokens,
        });
      }

      // No tool calls — assistant done
      if (result.toolCalls.length === 0) {
        if (result.assistantText) {
          this.messages.push({ role: "assistant", content: result.assistantText });
        }
        this.bus.emit("llm:done", {
          agentId: this.id,
          text: result.assistantText,
          usage: result.usage,
        });
        this.state = "idle";
        break;
      }

      // Has tool calls — add assistant message with tool_calls
      this.messages.push({
        role: "assistant",
        content: result.assistantText || null,
        tool_calls: result.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      // Execute tools concurrently via bus
      this.state = "tool-wait";
      const toolPromises = result.toolCalls.map(async (tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || "{}");
        } catch {
          const error = `Failed to parse arguments: ${tc.arguments}`;
          this.bus.emit("tool:error", {
            agentId: this.id,
            callId: tc.id,
            name: tc.name,
            error,
          });
          this.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ error }),
          });
          return;
        }

        // Register waiters BEFORE emitting tool:call to avoid race
        const resultPromise = this.bus.next("tool:result", (p) => p.callId === tc.id);
        const errorPromise = this.bus.next("tool:error", (p) => p.callId === tc.id);

        this.bus.emit("tool:call", {
          agentId: this.id,
          callId: tc.id,
          name: tc.name,
          args,
        });

        const response = await Promise.race([
          resultPromise.then((p) => ({ type: "result" as const, content: p.result })),
          errorPromise.then((p) => ({ type: "error" as const, content: JSON.stringify({ error: p.error }) })),
        ]);

        // Cancel the losing waiter to prevent memory leaks
        if (response.type === "result") {
          errorPromise.cancel();
        } else {
          resultPromise.cancel();
        }

        this.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: response.content,
        });
      });

      await Promise.all(toolPromises);
      debug(`all tools resolved for agent ${this.id}, continuing loop`);
    }
  }
}
