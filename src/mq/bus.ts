import type { StreamUsage } from "../ai/types.ts";

export type MsgMap = {
  "user:input":          { agentId: string; text: string };
  "llm:chunk:content":   { agentId: string; text: string };
  "llm:chunk:reasoning": { agentId: string; text: string };
  "llm:done":            { agentId: string; text: string; usage: StreamUsage | null };
  "llm:error":           { agentId: string; error: string };
  "tool:call":           { agentId: string; callId: string; name: string; args: Record<string, unknown> };
  "tool:result":         { agentId: string; callId: string; name: string; result: string };
  "tool:error":          { agentId: string; callId: string; name: string; error: string };
  "agent:spawned":       { agentId: string; parentId: string; prompt: string };
  "agent:completed":     { agentId: string; result: string };
  "agent:error":         { agentId: string; error: string };
  "agent:message":       { from: string; to: string; body: string };
  "context:update":      { agentId: string; model: string; tokensUsed: number; maxTokens: number };
  "hook:event":          { status: "loaded" | "run" | "blocked" | "error"; hook: string; source: string; detail: string };
};

export type MsgType = keyof MsgMap;

type Handler<T> = (payload: T) => void;

interface Waiter<T> {
  resolve: (payload: T) => void;
  filter?: (payload: T) => boolean;
}

export class MessageBus {
  private handlers = new Map<string, Set<Handler<any>>>();
  private waiters = new Map<string, Set<Waiter<any>>>();

  on<T extends MsgType>(type: T, handler: Handler<MsgMap[T]>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => { this.handlers.get(type)?.delete(handler); };
  }

  emit<T extends MsgType>(type: T, payload: MsgMap[T]): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        handler(payload);
      }
    }

    const waiters = this.waiters.get(type);
    if (waiters) {
      for (const waiter of waiters) {
        if (!waiter.filter || waiter.filter(payload)) {
          waiter.resolve(payload);
          waiters.delete(waiter);
        }
      }
      if (waiters.size === 0) {
        this.waiters.delete(type);
      }
    }
  }

  next<T extends MsgType>(type: T, filter?: (payload: MsgMap[T]) => boolean): Promise<MsgMap[T]> & { cancel: () => void } {
    let waiter: Waiter<MsgMap[T]>;
    const promise = new Promise<MsgMap[T]>((resolve) => {
      waiter = { resolve, filter };
      if (!this.waiters.has(type)) {
        this.waiters.set(type, new Set());
      }
      this.waiters.get(type)!.add(waiter);
    });
    (promise as any).cancel = () => {
      this.waiters.get(type)?.delete(waiter!);
    };
    return promise as Promise<MsgMap[T]> & { cancel: () => void };
  }
}
