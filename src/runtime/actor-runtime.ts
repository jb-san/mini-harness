import type { MessageBus } from "../mq/bus.ts";

export interface AgentMessageRecord {
  from: string;
  to: string;
  body: string;
  timestamp: string;
}

export type ActorEnvelope =
  | { kind: "user_input"; text: string; timestamp: string }
  | { kind: "agent_message"; from: string; to: string; body: string; timestamp: string }
  | { kind: "agent_completed"; agentId: string; result: string; timestamp: string }
  | { kind: "agent_error"; agentId: string; error: string; timestamp: string };

interface ActorRegistration {
  onReady?: () => void;
  parentId?: string;
}

export class ActorRuntime {
  private mailboxes = new Map<string, ActorEnvelope[]>();
  private messageLog = new Map<string, AgentMessageRecord[]>();
  private registrations = new Map<string, ActorRegistration>();
  private scheduled = new Set<string>();

  constructor(private bus: MessageBus) {
    this.bus.on("user:input", ({ agentId, text }) => {
      this.enqueue(agentId, {
        kind: "user_input",
        text,
        timestamp: new Date().toISOString(),
      });
    });
  }

  registerActor(agentId: string, registration: ActorRegistration = {}): void {
    const existing = this.registrations.get(agentId) ?? {};
    this.registrations.set(agentId, { ...existing, ...registration });
    this.ensureMailbox(agentId);
    this.ensureMessageLog(agentId);
    if (this.mailboxes.get(agentId)!.length > 0) {
      this.schedule(agentId);
    }
  }

  unregisterActor(agentId: string): void {
    this.registrations.delete(agentId);
    this.scheduled.delete(agentId);
  }

  setParent(agentId: string, parentId?: string): void {
    const existing = this.registrations.get(agentId) ?? {};
    this.registrations.set(agentId, { ...existing, parentId });
  }

  sendUserInput(agentId: string, text: string): void {
    this.enqueue(agentId, {
      kind: "user_input",
      text,
      timestamp: new Date().toISOString(),
    });
  }

  sendAgentMessage(from: string, to: string, body: string): void {
    const timestamp = new Date().toISOString();
    this.bus.emit("agent:message", { from, to, body });

    if (to === "broadcast") {
      for (const actorId of this.registrations.keys()) {
        if (actorId === from) continue;
        const record = { from, to, body, timestamp };
        this.ensureMessageLog(actorId).push(record);
        this.enqueue(actorId, {
          kind: "agent_message",
          from,
          to,
          body,
          timestamp,
        });
      }
      return;
    }

    const record = { from, to, body, timestamp };
    this.ensureMessageLog(to).push(record);
    this.enqueue(to, {
      kind: "agent_message",
      from,
      to,
      body,
      timestamp,
    });
  }

  completeAgent(agentId: string, result: string): void {
    this.bus.emit("agent:completed", { agentId, result });
    const parentId = this.registrations.get(agentId)?.parentId;
    this.unregisterActor(agentId);
    if (parentId) {
      this.enqueue(parentId, {
        kind: "agent_completed",
        agentId,
        result,
        timestamp: new Date().toISOString(),
      });
    }
  }

  failAgent(agentId: string, error: string): void {
    this.bus.emit("agent:error", { agentId, error });
    const parentId = this.registrations.get(agentId)?.parentId;
    this.unregisterActor(agentId);
    if (parentId) {
      this.enqueue(parentId, {
        kind: "agent_error",
        agentId,
        error,
        timestamp: new Date().toISOString(),
      });
    }
  }

  takeNext(agentId: string): ActorEnvelope | undefined {
    return this.ensureMailbox(agentId).shift();
  }

  hasMessages(agentId: string): boolean {
    return this.ensureMailbox(agentId).length > 0;
  }

  readMessages(agentId: string, since?: string): AgentMessageRecord[] {
    const messages = this.ensureMessageLog(agentId);
    if (!since) return [...messages];
    return messages.filter((message) => message.timestamp > since);
  }

  readAllMessages(since?: string): AgentMessageRecord[] {
    const all: AgentMessageRecord[] = [];
    for (const messages of this.messageLog.values()) {
      for (const message of messages) {
        if (since && message.timestamp <= since) continue;
        all.push(message);
      }
    }
    return all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  private enqueue(agentId: string, envelope: ActorEnvelope): void {
    this.ensureMailbox(agentId).push(envelope);
    this.schedule(agentId);
  }

  private schedule(agentId: string): void {
    const registration = this.registrations.get(agentId);
    if (!registration?.onReady) return;
    if (this.scheduled.has(agentId)) return;
    this.scheduled.add(agentId);
    setTimeout(() => {
      this.scheduled.delete(agentId);
      this.registrations.get(agentId)?.onReady?.();
    }, 0);
  }

  private ensureMailbox(agentId: string): ActorEnvelope[] {
    if (!this.mailboxes.has(agentId)) {
      this.mailboxes.set(agentId, []);
    }
    return this.mailboxes.get(agentId)!;
  }

  private ensureMessageLog(agentId: string): AgentMessageRecord[] {
    if (!this.messageLog.has(agentId)) {
      this.messageLog.set(agentId, []);
    }
    return this.messageLog.get(agentId)!;
  }
}
