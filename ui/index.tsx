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

// --- Bridge: external callbacks -> React state ---
type UIState = {
  thinkingText: string;
  thinkingActive: boolean;
  chatLog: ChatEntry[];
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
    <box width="100%" height="100%" flexDirection="column">
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
      store.setState({ thinkingActive: false });
    },

    onError(error: string) {
      appendToLog({
        type: "toolbox",
        key: nextKey("error"),
        name: "Error",
        detail: error,
        color: "#ff4444",
      });
    },
  };

  // --- Input handling ---
  function waitForInput(): Promise<string> {
    return new Promise((resolve) => {
      pendingResolve = resolve;
    });
  }

  return {
    callbacks,
    waitForInput,
    destroy: () => {
      root.unmount();
      renderer.destroy();
    },
  };
}
