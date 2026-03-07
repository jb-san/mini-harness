import type { MessageBus } from "../mq/bus.ts";

const MAX_CHAT_ENTRIES = 160;
const MAX_ACTIVITY_ENTRIES = 240;
const MAX_TOOL_ENTRIES = 240;

export type ChatEntry =
  | { type: "user"; key: string; text: string }
  | { type: "assistant"; key: string; text: string }
  | { type: "system"; key: string; text: string; tone: "info" | "error" };

export type ActivityEntry =
  | { type: "message"; key: string; from: string; to: string; body: string }
  | { type: "status"; key: string; agentId: string; text: string; tone: "info" | "success" | "error" };

export type ToolEntry = {
  key: string;
  agentId: string;
  name: string;
  phase: "call" | "result" | "error";
  detail: string;
  color: string;
};

export type AgentSummary = {
  agentId: string;
  parentId?: string;
  promptPreview: string;
  status: "idle" | "running" | "completed" | "error";
  lastEvent: string;
  toolCalls: number;
  toolErrors: number;
  messagesSent: number;
  messagesReceived: number;
  tokensUsed: number;
};

export type OverviewStats = {
  runningAgents: number;
  completedAgents: number;
  erroredAgents: number;
  totalMessages: number;
  totalToolCalls: number;
  totalToolErrors: number;
};

export type UIState = {
  thinkingText: string;
  thinkingActive: boolean;
  chatLog: ChatEntry[];
  activityLog: ActivityEntry[];
  toolLog: ToolEntry[];
  agentSummaries: AgentSummary[];
  model: string;
  tokensUsed: number;
  maxTokens: number;
  streaming: boolean;
  stats: OverviewStats;
};

type Listener = () => void;

export function createStore(initial: UIState) {
  let state = initial;
  const listeners = new Set<Listener>();

  return {
    getState: () => state,
    setState: (partial: Partial<UIState>) => {
      state = { ...state, ...partial };
      for (const l of listeners) l();
    },
    subscribe: (l: Listener) => {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
  };
}

export type Store = ReturnType<typeof createStore>;

function trimList<T>(entries: T[], max: number): T[] {
  return entries.length <= max ? entries : entries.slice(entries.length - max);
}

function createDefaultSummary(agentId: string): AgentSummary {
  return {
    agentId,
    promptPreview: agentId === "main" ? "Primary coordinator" : "",
    status: agentId === "main" ? "running" : "idle",
    lastEvent: agentId === "main" ? "Waiting for input" : "Spawned",
    toolCalls: 0,
    toolErrors: 0,
    messagesSent: 0,
    messagesReceived: 0,
    tokensUsed: 0,
  };
}

function sortSummaries(summaries: AgentSummary[]): AgentSummary[] {
  const statusOrder = { running: 0, error: 1, idle: 2, completed: 3 } as const;
  return [...summaries].sort((a, b) => {
    if (a.agentId === "main") return -1;
    if (b.agentId === "main") return 1;
    const statusDelta = statusOrder[a.status] - statusOrder[b.status];
    if (statusDelta !== 0) return statusDelta;
    return a.agentId.localeCompare(b.agentId);
  });
}

function deriveStats(summaries: AgentSummary[], activityLog: ActivityEntry[], toolLog: ToolEntry[]): OverviewStats {
  const workers = summaries.filter((summary) => summary.agentId !== "main");
  return {
    runningAgents: workers.filter((summary) => summary.status === "running").length,
    completedAgents: workers.filter((summary) => summary.status === "completed").length,
    erroredAgents: workers.filter((summary) => summary.status === "error").length,
    totalMessages: activityLog.filter((entry) => entry.type === "message").length,
    totalToolCalls: toolLog.filter((entry) => entry.phase === "call").length,
    totalToolErrors: toolLog.filter((entry) => entry.phase === "error").length,
  };
}

export function connectBusBridge(bus: MessageBus, store: Store, agentId = "main") {
  let reasoningBuffer = "";
  let entryCounter = 0;
  let currentAssistantKey: string | null = null;

  function nextKey(prefix: string) {
    return `${prefix}-${entryCounter++}`;
  }

  function setState(partial: Partial<UIState>) {
    const current = store.getState();
    const next = { ...current, ...partial };
    next.stats = deriveStats(next.agentSummaries, next.activityLog, next.toolLog);
    store.setState(next);
  }

  function appendChat(entry: ChatEntry) {
    const current = store.getState();
    const existing = current.chatLog.findIndex((candidate) => candidate.key === entry.key);
    if (existing >= 0) {
      const next = [...current.chatLog];
      next[existing] = entry;
      setState({ chatLog: next });
      return;
    }
    setState({ chatLog: trimList([...current.chatLog, entry], MAX_CHAT_ENTRIES) });
  }

  function appendActivity(entry: ActivityEntry) {
    const current = store.getState();
    setState({ activityLog: trimList([...current.activityLog, entry], MAX_ACTIVITY_ENTRIES) });
  }

  function appendTool(entry: ToolEntry) {
    const current = store.getState();
    setState({ toolLog: trimList([...current.toolLog, entry], MAX_TOOL_ENTRIES) });
  }

  function updateSummary(targetAgentId: string, updater: (summary: AgentSummary) => AgentSummary) {
    const current = store.getState();
    const summaries = [...current.agentSummaries];
    const index = summaries.findIndex((summary) => summary.agentId === targetAgentId);
    const base = index >= 0 ? summaries[index] : createDefaultSummary(targetAgentId);
    const nextSummary = updater(base);
    if (index >= 0) {
      summaries[index] = nextSummary;
    } else {
      summaries.push(nextSummary);
    }
    setState({ agentSummaries: sortSummaries(summaries) });
  }

  function touchMain(status: AgentSummary["status"], lastEvent: string) {
    updateSummary(agentId, (summary) => ({
      ...summary,
      status,
      lastEvent,
      promptPreview: summary.promptPreview || "Primary coordinator",
    }));
  }

  updateSummary(agentId, (summary) => summary);

  bus.on("llm:chunk:reasoning", (p) => {
    if (p.agentId !== agentId) return;
    reasoningBuffer += p.text;
    setState({
      thinkingText: reasoningBuffer,
      thinkingActive: true,
      streaming: true,
    });
    touchMain("running", "Reasoning");
  });

  bus.on("llm:chunk:content", (p) => {
    if (p.agentId !== agentId) return;
    setState({ thinkingActive: false, streaming: true });

    if (!currentAssistantKey) {
      currentAssistantKey = nextKey("assistant");
      appendChat({ type: "assistant", key: currentAssistantKey, text: p.text });
    } else {
      const log = store.getState().chatLog;
      const entry = log.find((candidate) => candidate.key === currentAssistantKey);
      if (entry && entry.type === "assistant") {
        appendChat({ ...entry, text: entry.text + p.text });
      }
    }

    touchMain("running", "Responding");
  });

  bus.on("llm:done", (p) => {
    if (p.agentId !== agentId) return;
    currentAssistantKey = null;
    reasoningBuffer = "";
    setState({ thinkingActive: false, streaming: false, thinkingText: "" });
    touchMain("idle", p.text ? `Replied: ${p.text.slice(0, 48)}` : "Waiting for input");
  });

  bus.on("llm:error", (p) => {
    if (p.agentId !== agentId) return;
    currentAssistantKey = null;
    reasoningBuffer = "";
    setState({ streaming: false, thinkingActive: false, thinkingText: "" });
    appendChat({
      type: "system",
      key: nextKey("error"),
      text: p.error,
      tone: "error",
    });
    touchMain("error", `Error: ${p.error.slice(0, 48)}`);
  });

  bus.on("tool:call", (p) => {
    const argsStr = JSON.stringify(p.args, null, 2).slice(0, 180);
    appendTool({
      key: nextKey("tool"),
      agentId: p.agentId,
      name: p.name,
      phase: "call",
      detail: argsStr,
      color: "#4aa3ff",
    });
    updateSummary(p.agentId, (summary) => ({
      ...summary,
      status: p.agentId === agentId ? "running" : summary.status === "completed" ? "running" : summary.status,
      lastEvent: `Tool call: ${p.name}`,
      toolCalls: summary.toolCalls + 1,
    }));
  });

  bus.on("tool:result", (p) => {
    const detail = p.result.length > 180 ? `${p.result.slice(0, 180)}...` : p.result;
    appendTool({
      key: nextKey("tool"),
      agentId: p.agentId,
      name: p.name,
      phase: "result",
      detail,
      color: "#58c26b",
    });
    updateSummary(p.agentId, (summary) => ({
      ...summary,
      lastEvent: `Tool result: ${p.name}`,
    }));
  });

  bus.on("tool:error", (p) => {
    appendTool({
      key: nextKey("tool"),
      agentId: p.agentId,
      name: p.name,
      phase: "error",
      detail: p.error,
      color: "#ff6b6b",
    });
    updateSummary(p.agentId, (summary) => ({
      ...summary,
      status: "error",
      lastEvent: `Tool error: ${p.name}`,
      toolErrors: summary.toolErrors + 1,
    }));
  });

  bus.on("context:update", (p) => {
    updateSummary(p.agentId, (summary) => ({
      ...summary,
      tokensUsed: p.tokensUsed,
    }));

    if (p.agentId !== agentId) return;
    setState({
      model: p.model,
      tokensUsed: p.tokensUsed,
      maxTokens: p.maxTokens,
    });
  });

  bus.on("agent:spawned", (p) => {
    appendActivity({
      type: "status",
      key: nextKey("status"),
      agentId: p.agentId,
      text: `${p.agentId} spawned under ${p.parentId}`,
      tone: "info",
    });
    updateSummary(p.agentId, (summary) => ({
      ...summary,
      parentId: p.parentId,
      promptPreview: p.prompt.slice(0, 72),
      status: "running",
      lastEvent: "Spawned",
    }));
  });

  bus.on("agent:completed", (p) => {
    const preview = p.result ? p.result.slice(0, 72) : "(no output)";
    appendActivity({
      type: "status",
      key: nextKey("status"),
      agentId: p.agentId,
      text: `${p.agentId} completed: ${preview}`,
      tone: "success",
    });
    updateSummary(p.agentId, (summary) => ({
      ...summary,
      status: "completed",
      lastEvent: `Completed: ${preview}`,
    }));
  });

  bus.on("agent:error", (p) => {
    appendActivity({
      type: "status",
      key: nextKey("status"),
      agentId: p.agentId,
      text: `${p.agentId} failed: ${p.error.slice(0, 72)}`,
      tone: "error",
    });
    updateSummary(p.agentId, (summary) => ({
      ...summary,
      status: "error",
      lastEvent: `Error: ${p.error.slice(0, 72)}`,
    }));
  });

  bus.on("agent:message", ({ from, to, body }) => {
    appendActivity({
      type: "message",
      key: nextKey("message"),
      from,
      to,
      body,
    });

    updateSummary(from, (summary) => ({
      ...summary,
      messagesSent: summary.messagesSent + 1,
      lastEvent: `Sent to ${to}: ${body.slice(0, 48)}`,
    }));

    if (to !== "broadcast") {
      updateSummary(to, (summary) => ({
        ...summary,
        messagesReceived: summary.messagesReceived + 1,
        lastEvent: `Received from ${from}: ${body.slice(0, 48)}`,
      }));
    }
  });

  return {
    addUserMessage(text: string) {
      reasoningBuffer = "";
      setState({ thinkingText: "", thinkingActive: false });
      appendChat({ type: "user", key: nextKey("user"), text });
      touchMain("running", `Queued prompt: ${text.slice(0, 48)}`);
    },
  };
}
