import { useEffect, useRef, useState } from "react";

const RETRY_MS = 10000;
const SETTLE_TYPES = new Set(["run_end", "message_end", "tool_execution_end"]);

type Block = { type: string; text?: string; thinking?: string; name?: string };
type Message = { role?: string; content?: Block[] | string };
type Change =
  | { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: Block }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "block"; contentIndex: number; block: Block }
  | { type: "message"; message: Message };
type ToolSlot = { callId: string; name: string; status: string; output?: string };
type Snapshot = { type: "snapshot"; generation?: { message?: Message }; tools?: ToolSlot[] };
type AgentEvent =
  | Snapshot
  | { type: "message_start"; message: Message }
  | { type: "message_update"; changes: Change[] }
  | { type: "message_end" }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; output?: { trimStart?: number; append?: string } | { set: string } }
  | { type: "tool_execution_end"; toolCallId: string }
  | { type: "run_start" }
  | { type: "run_end" }
  | { type: string };

export type LiveTool = { id: string; name: string; output: string };

export type AgentStreamState = {
  connected: boolean;
  text: string;
  thinking: boolean;
  tools: LiveTool[];
};

const EMPTY: AgentStreamState = { connected: false, text: "", thinking: false, tools: [] };

const blocksOf = (message: Message | undefined): Block[] => (Array.isArray(message?.content) ? message.content : []);

const parse = <T,>(raw: string): T | null => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export function useAgentStream(url: string, enabled: boolean, onSettled: () => void): AgentStreamState {
  const [state, setState] = useState<AgentStreamState>(EMPTY);
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  });

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") {
      setState(EMPTY);
      return;
    }
    let disposed = false;
    let source: EventSource | null = null;
    let retry: number | undefined;
    let texts: string[] = [];
    let thinking = false;
    let assistant = false;
    const tools = new Map<string, LiveTool>();

    const publish = (connected = true) =>
      setState({ connected, text: assistant ? texts.filter(Boolean).join("\n\n") : "", thinking: assistant && thinking, tools: [...tools.values()] });

    const fromMessage = (message: Message | undefined) => {
      const blocks = blocksOf(message);
      texts = blocks.map((b) => (b.type === "text" ? (b.text ?? "") : ""));
      thinking = blocks.some((b) => b.type === "thinking") && !texts.some(Boolean);
    };

    const apply = (event: AgentEvent) => {
      switch (event.type) {
        case "snapshot": {
          const snap = event as Snapshot;
          assistant = Boolean(snap.generation?.message);
          fromMessage(snap.generation?.message);
          tools.clear();
          for (const t of snap.tools ?? []) if (t.status === "running") tools.set(t.callId, { id: t.callId, name: t.name, output: t.output ?? "" });
          break;
        }
        case "message_start": {
          const msg = (event as { message: Message }).message;
          assistant = msg?.role === "assistant";
          fromMessage(assistant ? msg : undefined);
          break;
        }
        case "message_update": {
          assistant = true;
          for (const c of (event as { changes: Change[] }).changes ?? []) {
            if (c.type === "message") fromMessage(c.message);
            else if (c.type === "text_start" || (c.type === "block" && c.block.type === "text")) texts[c.contentIndex] = c.block.text ?? "";
            else if (c.type === "text_delta") texts[c.contentIndex] = (texts[c.contentIndex] ?? "") + c.delta;
            else if (c.type === "thinking_start" || c.type === "thinking_delta") thinking = true;
          }
          if (texts.some(Boolean)) thinking = false;
          break;
        }
        case "message_end":
          assistant = false;
          texts = [];
          thinking = false;
          break;
        case "tool_execution_start": {
          const e = event as { toolCallId: string; toolName: string };
          tools.set(e.toolCallId, { id: e.toolCallId, name: e.toolName, output: "" });
          break;
        }
        case "tool_execution_update": {
          const e = event as { toolCallId: string; toolName: string; output?: { trimStart?: number; append?: string } | { set: string } };
          const tool = tools.get(e.toolCallId) ?? { id: e.toolCallId, name: e.toolName, output: "" };
          if (e.output && "set" in e.output) tool.output = e.output.set;
          else if (e.output) tool.output = tool.output.slice(e.output.trimStart ?? 0) + (e.output.append ?? "");
          tools.set(e.toolCallId, { ...tool });
          break;
        }
        case "tool_execution_end":
          tools.delete((event as { toolCallId: string }).toolCallId);
          break;
        case "run_end":
          assistant = false;
          texts = [];
          thinking = false;
          tools.clear();
          break;
      }
    };

    const connect = () => {
      if (disposed) return;
      const es = new EventSource(url);
      source = es;
      es.addEventListener("snapshot", (msg) => {
        const data = parse<{ snapshot?: Snapshot }>((msg as MessageEvent<string>).data);
        if (data?.snapshot) apply({ ...data.snapshot, type: "snapshot" });
        publish();
      });
      es.addEventListener("events", (msg) => {
        const events = parse<AgentEvent[]>((msg as MessageEvent<string>).data) ?? [];
        let settle = false;
        for (const event of events) {
          apply(event);
          if (SETTLE_TYPES.has(event.type)) settle = true;
        }
        publish();
        if (settle) settled.current();
      });
      es.onerror = () => {
        es.close();
        if (source === es) source = null;
        assistant = false;
        texts = [];
        tools.clear();
        publish(false);
        if (!disposed) retry = window.setTimeout(connect, RETRY_MS);
      };
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retry);
      source?.close();
      setState(EMPTY);
    };
  }, [url, enabled]);

  return state;
}
