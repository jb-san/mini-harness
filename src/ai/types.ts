export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface StreamResult {
  toolCalls: ToolCall[];
  assistantText: string;
  usage: StreamUsage | null;
}

export interface StreamCallbacks {
  onContent?: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  onToolCallStart?: (idx: number, id: string, name: string) => void;
}

export interface ChatToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  };
}
