import type { LLMProvider } from "../provider.ts";
import type { Message, ChatToolDef, StreamCallbacks, StreamResult, ToolCall, StreamUsage } from "../types.ts";
import { debug } from "../../ui/debug.ts";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  maxTokens: number;
}

export class OpenAICompatibleProvider implements LLMProvider {
  id = "openai-compatible";
  private chatUrl: string;
  private model: string;
  private maxTokens: number;

  constructor(options: OpenAICompatibleOptions) {
    this.chatUrl = `${options.baseUrl}/chat/completions`;
    this.model = options.model;
    this.maxTokens = options.maxTokens;
  }

  async chat(
    params: { messages: Message[]; tools?: ChatToolDef[]; model?: string },
    callbacks?: StreamCallbacks,
  ): Promise<StreamResult> {
    const model = params.model ?? this.model;
    const body: Record<string, unknown> = {
      messages: params.messages,
      model,
      stream: true,
      max_tokens: this.maxTokens,
      stream_options: { include_usage: true },
    };
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools;
    }

    const reqBody = JSON.stringify(body);
    debug(">>> POST", this.chatUrl);
    debug(">>> body:", reqBody.slice(0, 500));

    const response = await fetch(this.chatUrl, {
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

    return this.parseStream(response, callbacks);
  }

  getModel(): string {
    return this.model;
  }

  getMaxTokens(): number {
    return this.maxTokens;
  }

  private async parseStream(
    response: Response,
    callbacks?: StreamCallbacks,
  ): Promise<StreamResult> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map<number, ToolCall>();
    let assistantText = "";
    let buffer = "";
    let inThinkBlock = false;
    let usage: StreamUsage | null = null;

    const STREAM_TIMEOUT_MS = 300_000;

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

        if (chunk.usage) {
          usage = chunk.usage;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (!delta) continue;

        if (delta.reasoning_content) {
          callbacks?.onReasoning?.(delta.reasoning_content);
        }

        if (delta.content) {
          let text: string = delta.content;
          while (text.length > 0) {
            if (inThinkBlock) {
              const endIdx = text.indexOf("</think>");
              if (endIdx !== -1) {
                const reasoning = text.slice(0, endIdx);
                if (reasoning) callbacks?.onReasoning?.(reasoning);
                text = text.slice(endIdx + "</think>".length);
                inThinkBlock = false;
              } else {
                callbacks?.onReasoning?.(text);
                text = "";
              }
            } else {
              const startIdx = text.indexOf("<think>");
              if (startIdx !== -1) {
                const content = text.slice(0, startIdx);
                if (content) {
                  callbacks?.onContent?.(content);
                  assistantText += content;
                }
                text = text.slice(startIdx + "<think>".length);
                inThinkBlock = true;
              } else {
                callbacks?.onContent?.(text);
                assistantText += text;
                text = "";
              }
            }
          }
        }

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

        if (choice.finish_reason === "length") {
          debug("model hit max_tokens limit — output may be truncated");
        }
      }
    }

    const result = { toolCalls: [...toolCalls.values()], assistantText, usage };
    debug("stream done.", `toolCalls=${result.toolCalls.length}`, usage ? `tokens=${usage.total_tokens}` : "no usage");
    if (result.toolCalls.length > 0) {
      debug("toolCalls:", JSON.stringify(result.toolCalls, null, 2));
    }
    return result;
  }
}
