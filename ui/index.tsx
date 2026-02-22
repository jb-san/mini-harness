import { createCliRenderer } from "@opentui/core";
import { createRoot, useRenderer, useKeyboard } from "@opentui/react";
import { useState, useCallback, useEffect, useRef } from "react";
import type { InputRenderable } from "@opentui/core";
import type { UICallbacks } from "../core";

// --- Chat log entry types ---
type ChatEntry =
  | { type: "user"; key: string; text: string }
  | { type: "assistant"; key: string; text: string }
  | { type: "toolbox"; key: string; name: string; detail: string; color: string };

// --- Agents panel entry types ---
type AgentPanelEntry =
  | { type: "message"; key: string; from: string; to: string; body: string }
  | { type: "status"; key: string; agentId: string; text: string };

// --- Bridge: external callbacks -> React state ---
type UIState = {
  thinkingText: string;
  thinkingActive: boolean;
  chatLog: ChatEntry[];
  agentLog: AgentPanelEntry[];
  model: string;
  tokensUsed: number;
  maxTokens: number;
  streaming: boolean;
};

type Listener = () => void;

function createStore(initial: UIState) {
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

// --- React components ---

function ThinkingBox({ text, active }: { text: string; active: boolean }) {
  const lines = text.split("\n");
  const visible = lines.slice(-3).join("\n");

  return (
    <box
      width="100%"
      height={5}
      borderStyle="rounded"
      border={true}
      borderColor={active ? "#997700" : "#555555"}
      title=" Thinking "
      titleAlignment="left"
    >
      <text
        content={visible}
        fg="#888888"
        width="100%"
        height="100%"
        wrapMode="word"
        truncate={true}
      />
    </box>
  );
}

function TopBar({ model, tokensUsed, maxTokens, streaming }: { model: string; tokensUsed: number; maxTokens: number; streaming: boolean }) {
  const pct = maxTokens > 0 ? Math.min(100, Math.round((tokensUsed / maxTokens) * 100)) : 0;
  const barWidth = 20;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const barColor = pct < 50 ? "#555555" : pct < 80 ? "#997700" : "#cc4444";

  const modelShort = model.includes("/") ? model.split("/").pop()! : model;
  const status = streaming ? "●" : "○";
  const statusColor = streaming ? "#44aa44" : "#555555";

  return (
    <box width="100%" height={1} flexDirection="row">
      <text content={` ${status} `} fg={statusColor} />
      <text content={`${modelShort} `} fg="#888888" />
      <box flexGrow={1} />
      <text content={bar} fg={barColor} />
      <text content={` ${pct}% `} fg="#666666" />
    </box>
  );
}

function ChatLogEntry({ entry }: { entry: ChatEntry }) {
  if (entry.type === "user") {
    return (
      <box width="100%" marginTop={1} marginBottom={1}>
        <text content={`> ${entry.text}`} fg="#55aaff" width="100%" wrapMode="word" />
      </box>
    );
  }

  if (entry.type === "assistant") {
    return <text content={entry.text} fg="#eeeeee" width="100%" wrapMode="word" />;
  }

  // toolbox
  return (
    <box
      width="100%"
      borderStyle="single"
      border={true}
      borderColor={entry.color}
      title={` ${entry.name} `}
      titleAlignment="left"
      marginTop={1}
      marginBottom={1}
    >
      <text content={entry.detail} fg={entry.color} width="100%" wrapMode="word" truncate={true} />
    </box>
  );
}

function AgentPanelEntry({ entry }: { entry: AgentPanelEntry }) {
  if (entry.type === "status") {
    return (
      <box width="100%" marginTop={1}>
        <text content={`  ${entry.text}`} fg="#666666" width="100%" wrapMode="word" />
      </box>
    );
  }

  // message
  const isMain = entry.from === "main";
  const labelColor = isMain ? "#55aaff" : "#cc88ff";
  const arrow = entry.to === "broadcast" ? " -> all" : ` -> ${entry.to}`;

  return (
    <box width="100%" marginTop={1}>
      <text
        content={`${entry.from}${arrow}`}
        fg={labelColor}
        width="100%"
      />
      <text
        content={entry.body}
        fg="#cccccc"
        width="100%"
        wrapMode="word"
      />
    </box>
  );
}

function AgentsPanel({ entries }: { entries: AgentPanelEntry[] }) {
  if (entries.length === 0) {
    return (
      <box
        width={36}
        height="100%"
        borderStyle="rounded"
        border={true}
        borderColor="#553399"
        title=" Agents "
        titleAlignment="left"
      >
        <text content="  No agent activity yet." fg="#555555" width="100%" marginTop={1} />
      </box>
    );
  }

  return (
    <scrollbox
      width={36}
      height="100%"
      borderStyle="rounded"
      border={true}
      borderColor="#553399"
      title=" Agents "
      titleAlignment="left"
      scrollY={true}
      stickyScroll={true}
      stickyStart="bottom"
    >
      {entries.map((entry) => (
        <AgentPanelEntry key={entry.key} entry={entry} />
      ))}
    </scrollbox>
  );
}

function App({
  store,
  onSubmit,
}: {
  store: ReturnType<typeof createStore>;
  onSubmit: (value: string) => void;
}) {
  const [state, setState] = useState(store.getState());
  const inputRef = useRef<InputRenderable>(null);

  useEffect(() => {
    return store.subscribe(() => {
      setState(store.getState());
    });
  }, [store]);

  // Cmd+C / Ctrl+C to copy selection
  const renderer = useRenderer();
  useKeyboard((key) => {
    if (key.name === "c" && (key.meta || key.ctrl)) {
      const selection = renderer.getSelection();
      if (selection?.isActive) {
        const text = selection.getSelectedText();
        if (text) {
          renderer.copyToClipboardOSC52(text);
        }
      }
    }
  });

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      // Clear input immediately via ref
      if (inputRef.current) {
        inputRef.current.value = "";
      }

      onSubmit(trimmed);
    },
    [onSubmit],
  );

  return (
    <box width="100%" height="100%" flexDirection="row">
      <AgentsPanel entries={state.agentLog} />

      <box flexGrow={1} height="100%" flexDirection="column">
        <TopBar model={state.model} tokensUsed={state.tokensUsed} maxTokens={state.maxTokens} streaming={state.streaming} />
        <ThinkingBox text={state.thinkingText} active={state.thinkingActive} />

        <scrollbox
          width="100%"
          flexGrow={1}
          borderStyle="rounded"
          border={true}
          borderColor="#444444"
          title=" Chat "
          titleAlignment="left"
          scrollY={true}
          stickyScroll={true}
          stickyStart="bottom"
        >
          {state.chatLog.map((entry) => (
            <ChatLogEntry key={entry.key} entry={entry} />
          ))}
        </scrollbox>

        <box
          width="100%"
          height={3}
          borderStyle="rounded"
          border={true}
          borderColor="#666666"
          title=" > "
          titleAlignment="left"
        >
          <input
            ref={inputRef}
            width="100%"
            placeholder="Type a message..."
            textColor="#ffffff"
            focusedTextColor="#ffffff"
            focused={true}
            onSubmit={handleSubmit as any}
          />
        </box>
      </box>
    </box>
  );
}

// --- Public API ---

export async function createUI() {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: true,
  });

  const store = createStore({
    thinkingText: "",
    thinkingActive: false,
    chatLog: [],
    agentLog: [],
    model: "",
    tokensUsed: 0,
    maxTokens: 0,
    streaming: false,
  });

  let reasoningBuffer = "";
  let entryCounter = 0;
  // Key of the current assistant text entry being streamed into
  let currentAssistantKey: string | null = null;

  function nextKey(prefix: string) {
    return `${prefix}-${entryCounter++}`;
  }

  // Append or update an entry in the chat log
  function appendToLog(entry: ChatEntry) {
    const log = store.getState().chatLog;
    const existing = log.findIndex((e) => e.key === entry.key);
    if (existing >= 0) {
      const updated = [...log];
      updated[existing] = entry;
      store.setState({ chatLog: updated });
    } else {
      store.setState({ chatLog: [...log, entry] });
    }
  }

  // Mutable resolve for input promise
  let pendingResolve: ((value: string) => void) | null = null;

  const handleSubmit = (value: string) => {
    if (pendingResolve) {
      // Add user message to chat log
      appendToLog({ type: "user", key: nextKey("user"), text: value });

      // Clear thinking for the new turn
      reasoningBuffer = "";
      store.setState({ thinkingText: "", thinkingActive: false });

      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(value);
    }
  };

  const root = createRoot(renderer);
  root.render(<App store={store} onSubmit={handleSubmit} />);
  renderer.start();

  // --- Callbacks for core ---
  const callbacks: UICallbacks = {
    onIterationStart(_iteration: number) {
      reasoningBuffer = "";
      currentAssistantKey = null;
      store.setState({ streaming: true });
    },

    onReasoningChunk(chunk: string) {
      reasoningBuffer += chunk;
      store.setState({
        thinkingText: reasoningBuffer,
        thinkingActive: true,
      });
    },

    onContentChunk(chunk: string) {
      store.setState({ thinkingActive: false });

      // Create or update the current assistant entry
      if (!currentAssistantKey) {
        currentAssistantKey = nextKey("assistant");
        appendToLog({ type: "assistant", key: currentAssistantKey, text: chunk });
      } else {
        const log = store.getState().chatLog;
        const entry = log.find((e) => e.key === currentAssistantKey);
        if (entry && entry.type === "assistant") {
          appendToLog({ ...entry, text: entry.text + chunk });
        }
      }
    },

    onToolStart(name: string, args: Record<string, unknown>) {
      const argsStr = JSON.stringify(args, null, 2).slice(0, 200);
      appendToLog({
        type: "toolbox",
        key: nextKey("tool"),
        name,
        detail: argsStr,
        color: "#5599ff",
      });
    },

    onToolResult(name: string, result: string) {
      const truncated = result.length > 200 ? result.slice(0, 200) + "..." : result;
      appendToLog({
        type: "toolbox",
        key: nextKey("tool"),
        name: `${name} done`,
        detail: truncated,
        color: "#44aa44",
      });
    },

    onToolError(name: string, error: string) {
      appendToLog({
        type: "toolbox",
        key: nextKey("tool"),
        name: `${name} error`,
        detail: error,
        color: "#ff4444",
      });
    },

    onAssistantDone(_text: string) {
      currentAssistantKey = null;
      store.setState({ thinkingActive: false, streaming: false });
    },

    onError(error: string) {
      store.setState({ streaming: false });
      appendToLog({
        type: "toolbox",
        key: nextKey("error"),
        name: "Error",
        detail: error,
        color: "#ff4444",
      });
    },

    onContextUpdate(info: { model: string; tokensUsed: number; maxTokens: number }) {
      store.setState({
        model: info.model,
        tokensUsed: info.tokensUsed,
        maxTokens: info.maxTokens,
      });
    },
  };

  // --- Agents panel API ---
  // Track message IDs we've already shown to avoid duplicates
  const seenMessageIds = new Set<string>();

  function addAgentMessage(from: string, to: string, body: string, msgId?: string) {
    if (msgId && seenMessageIds.has(msgId)) return;
    if (msgId) seenMessageIds.add(msgId);

    const agentLog = store.getState().agentLog;
    store.setState({
      agentLog: [
        ...agentLog,
        { type: "message", key: nextKey("amsg"), from, to, body },
      ],
    });
  }

  function addAgentStatus(agentId: string, text: string) {
    const agentLog = store.getState().agentLog;
    store.setState({
      agentLog: [
        ...agentLog,
        { type: "status", key: nextKey("astat"), agentId, text },
      ],
    });
  }

  // --- Input handling ---
  function waitForInput(): Promise<string> {
    return new Promise((resolve) => {
      pendingResolve = resolve;
    });
  }

  return {
    callbacks,
    waitForInput,
    addAgentMessage,
    addAgentStatus,
    destroy: () => {
      root.unmount();
      renderer.destroy();
    },
  };
}
