import { createCliRenderer } from "@opentui/core";
import { createRoot, useRenderer, useKeyboard } from "@opentui/react";
import { useState, useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { InputRenderable } from "@opentui/core";
import type { MessageBus } from "../mq/bus.ts";
import { createStore, connectBusBridge } from "./bus-bridge.ts";
import type { Store, ChatEntry, ActivityEntry, ToolEntry, AgentSummary, OverviewStats } from "./bus-bridge.ts";

const theme = {
  bg: "#11161c",
  frame: "#314050",
  frameHot: "#4f6b7a",
  text: "#d8e1e8",
  muted: "#7c8b97",
  dim: "#5d6972",
  cyan: "#55c2ff",
  green: "#69d18a",
  amber: "#f0b35f",
  red: "#ff7a7a",
};

function panelTitle(label: string, suffix?: string) {
  return suffix ? ` ${label} | ${suffix} ` : ` ${label} `;
}

function toneColor(tone: "info" | "success" | "error") {
  if (tone === "success") return theme.green;
  if (tone === "error") return theme.red;
  return theme.amber;
}

function statusColor(status: AgentSummary["status"]) {
  if (status === "running") return theme.cyan;
  if (status === "completed") return theme.green;
  if (status === "error") return theme.red;
  return theme.muted;
}

function compact(text: string, max = 84) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function tokenBar(tokensUsed: number, maxTokens: number) {
  const pct = maxTokens > 0 ? Math.min(100, Math.round((tokensUsed / maxTokens) * 100)) : 0;
  const width = 18;
  const filled = Math.round((pct / 100) * width);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
  const color = pct < 50 ? theme.green : pct < 80 ? theme.amber : theme.red;
  return { pct, bar, color };
}

function Section({
  title,
  color,
  width,
  height,
  flexGrow,
  children,
}: {
  title: string;
  color: string;
  width?: number | string;
  height?: number | string;
  flexGrow?: number;
  children: any;
}) {
  return (
    <box
      width={width}
      height={height}
      flexGrow={flexGrow}
      borderStyle="rounded"
      border={true}
      borderColor={color}
      title={title}
      titleAlignment="left"
    >
      {children}
    </box>
  );
}

function HeaderBar({
  model,
  tokensUsed,
  maxTokens,
  streaming,
  stats,
}: {
  model: string;
  tokensUsed: number;
  maxTokens: number;
  streaming: boolean;
  stats: OverviewStats;
}) {
  const shortModel = model.includes("/") ? model.split("/").pop()! : model || "no-model";
  const status = streaming ? "LIVE" : "IDLE";
  const statusColor = streaming ? theme.green : theme.dim;
  const usage = tokenBar(tokensUsed, maxTokens);

  return (
    <Section title=" Harness Command Center " color={theme.frameHot} height={4}>
      <box width="100%" height="100%" paddingLeft={1} paddingRight={1} flexDirection="column">
        <box width="100%" height={1} flexDirection="row">
          <text content="STATUS " fg={theme.dim} />
          <text content={status} fg={statusColor} />
          <text content="  MODEL " fg={theme.dim} />
          <text content={shortModel} fg={theme.text} />
          <box flexGrow={1} />
          <text content={usage.bar} fg={usage.color} />
          <text content={` ${usage.pct}%`} fg={theme.muted} />
        </box>
        <box width="100%" height={1} flexDirection="row">
          <text content={`RUN ${stats.runningAgents}`} fg={theme.cyan} />
          <text content="  " />
          <text content={`DONE ${stats.completedAgents}`} fg={theme.green} />
          <text content="  " />
          <text content={`ERR ${stats.erroredAgents}`} fg={theme.red} />
          <text content="  " />
          <text content={`MSG ${stats.totalMessages}`} fg={theme.text} />
          <text content="  " />
          <text content={`TOOLS ${stats.totalToolCalls}`} fg={theme.text} />
          <text content="  " />
          <text content={`FAIL ${stats.totalToolErrors}`} fg={theme.red} />
        </box>
      </box>
    </Section>
  );
}

function ThinkingPanel({ text, active }: { text: string; active: boolean }) {
  const lines = text.split("\n").filter(Boolean);
  const visible = lines.slice(-4).join("\n") || "No reasoning stream.";
  return (
    <Section
      title={panelTitle("Reasoning", active ? "streaming" : "standby")}
      color={active ? theme.amber : theme.frame}
      height={6}
    >
      <text
        content={visible}
        fg={active ? "#f6d3a1" : theme.muted}
        width="100%"
        height="100%"
        wrapMode="word"
        truncate={true}
      />
    </Section>
  );
}

function StatRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <box width="100%" height={1} flexDirection="row">
      <text content={`${label} `} fg={theme.dim} />
      <text content={value} fg={color} />
    </box>
  );
}

function OverviewPanel({
  model,
  tokensUsed,
  maxTokens,
  stats,
  mainSummary,
}: {
  model: string;
  tokensUsed: number;
  maxTokens: number;
  stats: OverviewStats;
  mainSummary?: AgentSummary;
}) {
  const shortModel = model.includes("/") ? model.split("/").pop()! : model || "unknown";
  return (
    <Section title=" Overview " color={theme.frameHot} height={10}>
      <box width="100%" height="100%" paddingLeft={1} paddingRight={1} flexDirection="column">
        <StatRow label="Coordinator" value={mainSummary?.status ?? "idle"} color={statusColor(mainSummary?.status ?? "idle")} />
        <StatRow label="Main event" value={compact(mainSummary?.lastEvent ?? "Waiting for input", 26)} color={theme.text} />
        <StatRow label="Model" value={shortModel} color={theme.text} />
        <StatRow label="Tokens" value={`${tokensUsed}/${maxTokens || 0}`} color={theme.text} />
        <StatRow label="Workers" value={`${stats.runningAgents} running / ${stats.completedAgents} done / ${stats.erroredAgents} error`} color={theme.text} />
        <StatRow label="Traffic" value={`${stats.totalMessages} msg / ${stats.totalToolCalls} tool / ${stats.totalToolErrors} fail`} color={theme.text} />
      </box>
    </Section>
  );
}

function AgentSummaryView({ summary }: { summary: AgentSummary }) {
  const status = summary.agentId === "main" ? "coordinator" : summary.status;
  return (
    <box width="100%" flexDirection="column" marginTop={1} paddingLeft={1} paddingRight={1}>
      <box width="100%" flexDirection="row">
        <text content={summary.agentId} fg={theme.text} />
        <text content={` ${status}`} fg={statusColor(summary.status)} />
        <box flexGrow={1} />
        <text content={`${summary.tokensUsed} tok`} fg={theme.dim} />
      </box>
      <text content={compact(summary.promptPreview || "(no task)", 34)} fg={theme.muted} width="100%" />
      <text content={compact(summary.lastEvent, 34)} fg={theme.text} width="100%" />
      <text
        content={`msg ${summary.messagesSent}/${summary.messagesReceived}  tools ${summary.toolCalls}  err ${summary.toolErrors}`}
        fg={theme.dim}
        width="100%"
      />
    </box>
  );
}

function AgentsPanel({ summaries }: { summaries: AgentSummary[] }) {
  if (summaries.length === 0) {
    return (
      <Section title=" Fleet " color={theme.frame} flexGrow={1}>
        <text content="  No agents registered." fg={theme.dim} width="100%" marginTop={1} />
      </Section>
    );
  }

  return (
    <scrollbox
      width="100%"
      flexGrow={1}
      borderStyle="rounded"
      border={true}
      borderColor={theme.frame}
      title={panelTitle("Fleet", `${summaries.length} actors`)}
      titleAlignment="left"
      scrollY={true}
      stickyScroll={true}
      stickyStart="top"
    >
      {summaries.map((summary) => (
        <AgentSummaryView key={summary.agentId} summary={summary} />
      ))}
    </scrollbox>
  );
}

function ChatLogEntryView({ entry }: { entry: ChatEntry }) {
  if (entry.type === "user") {
    return (
      <box width="100%" marginTop={1}>
        <text content={`> ${entry.text}`} fg={theme.cyan} width="100%" wrapMode="word" />
      </box>
    );
  }

  if (entry.type === "assistant") {
    return (
      <box width="100%" marginTop={1}>
        <text content={entry.text} fg={theme.text} width="100%" wrapMode="word" />
      </box>
    );
  }

  return (
    <box width="100%" marginTop={1}>
      <text content={`SYSTEM ${entry.text}`} fg={entry.tone === "error" ? theme.red : theme.amber} width="100%" wrapMode="word" />
    </box>
  );
}

function ChatPanel({ entries }: { entries: ChatEntry[] }) {
  return (
    <scrollbox
      width="100%"
      flexGrow={1}
      borderStyle="rounded"
      border={true}
      borderColor={theme.frameHot}
      title={panelTitle("Conversation", `${entries.length} entries`)}
      titleAlignment="left"
      scrollY={true}
      stickyScroll={true}
      stickyStart="bottom"
    >
      {entries.length === 0 ? (
        <text content="  No conversation yet." fg={theme.dim} width="100%" marginTop={1} />
      ) : (
        entries.map((entry) => <ChatLogEntryView key={entry.key} entry={entry} />)
      )}
    </scrollbox>
  );
}

function ActivityEntryView({ entry }: { entry: ActivityEntry }) {
  if (entry.type === "message") {
    const route = entry.to === "broadcast" ? `${entry.from} => all` : `${entry.from} => ${entry.to}`;
    return (
      <box width="100%" flexDirection="column" marginTop={1} paddingLeft={1} paddingRight={1}>
        <text content={route} fg={theme.cyan} width="100%" />
        <text content={compact(entry.body, 70)} fg={theme.text} width="100%" wrapMode="word" />
      </box>
    );
  }

  return (
    <box width="100%" marginTop={1} paddingLeft={1} paddingRight={1}>
      <text content={`${entry.agentId} ${entry.text}`} fg={toneColor(entry.tone)} width="100%" wrapMode="word" />
    </box>
  );
}

function ActivityPanel({ entries }: { entries: ActivityEntry[] }) {
  return (
    <scrollbox
      width="100%"
      flexGrow={1}
      borderStyle="rounded"
      border={true}
      borderColor={theme.amber}
      title={panelTitle("Orchestration", `${entries.length} events`)}
      titleAlignment="left"
      scrollY={true}
      stickyScroll={true}
      stickyStart="bottom"
    >
      {entries.length === 0 ? (
        <text content="  No orchestration events yet." fg={theme.dim} width="100%" marginTop={1} />
      ) : (
        entries.map((entry) => <ActivityEntryView key={entry.key} entry={entry} />)
      )}
    </scrollbox>
  );
}

function ToolEntryView({ entry }: { entry: ToolEntry }) {
  const phaseLabel = entry.phase.toUpperCase();
  return (
    <box width="100%" flexDirection="column" marginTop={1} paddingLeft={1} paddingRight={1}>
      <box width="100%" flexDirection="row">
        <text content={entry.agentId} fg={theme.muted} />
        <text content={` ${phaseLabel}`} fg={entry.color} />
        <text content={` ${entry.name}`} fg={theme.text} />
      </box>
      <text content={compact(entry.detail, 70)} fg={theme.dim} width="100%" wrapMode="word" />
    </box>
  );
}

function ToolPanel({ entries }: { entries: ToolEntry[] }) {
  return (
    <scrollbox
      width="100%"
      flexGrow={1}
      borderStyle="rounded"
      border={true}
      borderColor={theme.cyan}
      title={panelTitle("Tool Traffic", `${entries.length} events`)}
      titleAlignment="left"
      scrollY={true}
      stickyScroll={true}
      stickyStart="bottom"
    >
      {entries.length === 0 ? (
        <text content="  No tool activity yet." fg={theme.dim} width="100%" marginTop={1} />
      ) : (
        entries.map((entry) => <ToolEntryView key={entry.key} entry={entry} />)
      )}
    </scrollbox>
  );
}

function CommandInput({
  inputRef,
  onSubmit,
}: {
  inputRef: RefObject<InputRenderable | null>;
  onSubmit: (value: string) => void;
}) {
  return (
    <Section title=" Command " color={theme.frameHot} height={4}>
      <box width="100%" height="100%" flexDirection="column">
        <input
          ref={inputRef}
          width="100%"
          placeholder="Ask the harness to act. Cmd/Ctrl+C copies selected text."
          textColor={theme.text}
          focusedTextColor={theme.text}
          focused={true}
          onSubmit={onSubmit as any}
        />
        <text content="  Chat is isolated from tool and orchestration telemetry." fg={theme.dim} width="100%" />
      </box>
    </Section>
  );
}

function App({
  store,
  onSubmit,
}: {
  store: Store;
  onSubmit: (value: string) => void;
}) {
  const [state, setState] = useState(store.getState());
  const inputRef = useRef<InputRenderable>(null);

  useEffect(() => {
    return store.subscribe(() => {
      setState(store.getState());
    });
  }, [store]);

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
      if (inputRef.current) {
        inputRef.current.value = "";
      }
      onSubmit(trimmed);
    },
    [onSubmit],
  );

  const mainSummary = state.agentSummaries.find((summary) => summary.agentId === "main");
  const workerSummaries = state.agentSummaries.filter((summary) => summary.agentId !== "main");

  return (
    <box width="100%" height="100%" flexDirection="column">
      <HeaderBar
        model={state.model}
        tokensUsed={state.tokensUsed}
        maxTokens={state.maxTokens}
        streaming={state.streaming}
        stats={state.stats}
      />

      <box width="100%" flexGrow={1} flexDirection="row">
        <box width={38} height="100%" flexDirection="column">
          <OverviewPanel
            model={state.model}
            tokensUsed={state.tokensUsed}
            maxTokens={state.maxTokens}
            stats={state.stats}
            mainSummary={mainSummary}
          />
          <AgentsPanel summaries={workerSummaries} />
        </box>

        <box flexGrow={1} height="100%" flexDirection="column">
          <ThinkingPanel text={state.thinkingText} active={state.thinkingActive} />
          <ChatPanel entries={state.chatLog} />
          <CommandInput inputRef={inputRef} onSubmit={handleSubmit} />
        </box>

        <box width={46} height="100%" flexDirection="column">
          <ActivityPanel entries={state.activityLog} />
          <ToolPanel entries={state.toolLog} />
        </box>
      </box>
    </box>
  );
}

export async function createUI(bus: MessageBus) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: true,
  });

  const store = createStore({
    thinkingText: "",
    thinkingActive: false,
    chatLog: [],
    activityLog: [],
    toolLog: [],
    agentSummaries: [],
    model: "",
    tokensUsed: 0,
    maxTokens: 0,
    streaming: false,
    stats: {
      runningAgents: 0,
      completedAgents: 0,
      erroredAgents: 0,
      totalMessages: 0,
      totalToolCalls: 0,
      totalToolErrors: 0,
    },
  });

  const bridge = connectBusBridge(bus, store);

  const handleSubmit = (value: string) => {
    bridge.addUserMessage(value);
    bus.emit("user:input", { agentId: "main", text: value });
  };

  const root = createRoot(renderer);
  root.render(<App store={store} onSubmit={handleSubmit} />);
  renderer.start();

  return {
    destroy: () => {
      root.unmount();
      renderer.destroy();
    },
  };
}
