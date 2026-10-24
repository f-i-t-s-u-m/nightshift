import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { FileText, Folder, Library } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../api";
import { Spinner } from "./TaskBits";

/** An @ being typed at the caret: after the start or a space or bracket, up to the caret, no spaces. */
const TOKEN = /(^|[\s([{"'`])@([^\s@]*)$/;

type Mention = { query: string; start: number; end: number };

/**
 * `@` file mentions for a textarea, like Claude Code: typing @ lists the task's files (or the project's, before the
 * task has a workspace), the arrow keys move, Enter or Tab inserts `@path`, Escape closes. Picking a folder keeps the
 * list open inside it. Nightshift adds the mentioned files' contents when the text reaches the agent.
 */
export function useFileMentions({
  projectId,
  taskId,
  value,
  setValue,
  ref,
}: {
  projectId: string;
  taskId?: string;
  value: string;
  setValue: (value: string) => void;
  ref: RefObject<HTMLTextAreaElement | null>;
}) {
  const [mention, setMention] = useState<Mention | null>(null);
  const [items, setItems] = useState<string[]>([]);
  const [root, setRoot] = useState<"workspace" | "project">("workspace");
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const listId = useId();
  const seq = useRef(0);

  const detect = useCallback((text: string, caret: number | null) => {
    if (caret === null) return setMention(null);
    const m = text.slice(0, caret).match(TOKEN);
    setMention(m ? { query: m[2]!, start: caret - m[2]!.length - 1, end: caret } : null);
  }, []);

  useEffect(() => {
    if (!mention) {
      setItems([]);
      return;
    }
    const mine = ++seq.current;
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      api
        .searchFiles(projectId, mention.query, taskId, controller.signal)
        .then((res) => {
          if (mine !== seq.current) return;
          setItems(res.files);
          setRoot(res.root);
          setActive(0);
        })
        .catch(() => {
          if (mine === seq.current && !controller.signal.aborted) setItems([]);
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false);
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [mention?.query, projectId, taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (file: string) => {
    if (!mention) return;
    const folder = file.endsWith("/") || file.endsWith(":");
    const insert = `@${file}${folder ? "" : " "}`;
    const next = value.slice(0, mention.start) + insert + value.slice(mention.end);
    const caret = mention.start + insert.length;
    setValue(next);
    setMention(folder ? { query: file, start: mention.start, end: caret } : null);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(caret, caret);
    });
  };

  const open = mention !== null;
  /** Call first in the textarea's onKeyDown; true when the key was used by the list. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setMention(null);
      return true;
    }
    if (!items.length) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === "Tab") {
      e.preventDefault();
      pick(items[active]!);
      return true;
    }
    return false;
  };

  const inputProps = {
    onSelect: () => detect(ref.current?.value ?? value, ref.current?.selectionStart ?? null),
    onBlur: () => window.setTimeout(() => setMention(null), 150),
    "aria-autocomplete": "list" as const,
    "aria-controls": open ? listId : undefined,
    "aria-expanded": open,
  };

  const list = open ? (
    <div className="absolute right-0 bottom-full left-0 z-20 mb-1 overflow-hidden rounded-lg border bg-popover text-sm shadow-md">
      <div className="flex items-center gap-2 border-b px-2.5 py-1 text-xs text-muted-foreground">
        {loading ? <Spinner className="size-3" /> : null}
        Files in the {root === "workspace" ? "task's workspace" : "project folder"}
        {mention.query ? (
          <span className="truncate">
            matching <code className="font-mono">{mention.query}</code>
          </span>
        ) : null}
        <span className="ml-auto hidden sm:inline">↑↓ · Enter · Esc</span>
      </div>
      <ul id={listId} role="listbox" aria-label="Files to mention" className="max-h-60 overflow-y-auto py-1">
        {items.map((f, i) => {
          const ref = f.match(/^([a-z0-9][a-z0-9-]*):(.*)$/);
          const inside = ref ? ref[2]! : f;
          const top = Boolean(ref && !inside);
          const folder = f.endsWith("/") || top;
          const name = top ? ref![1] : inside.replace(/\/$/, "").split("/").pop();
          const dir = top ? "read-only reference" : inside.replace(/\/$/, "").split("/").slice(0, -1).join("/");
          return (
            <li key={f} role="option" aria-selected={i === active}>
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(f)}
                className={cn("flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left", i === active && "bg-muted")}
              >
                {top ? <Library className="size-3.5 shrink-0 text-teal-600 dark:text-teal-400" /> : folder ? <Folder className="size-3.5 shrink-0 text-muted-foreground" /> : <FileText className="size-3.5 shrink-0 text-muted-foreground" />}
                {ref && !top ? <span className="shrink-0 rounded bg-teal-500/15 px-1 font-mono text-[10px] text-teal-800 dark:text-teal-200">{ref[1]}</span> : null}
                <span className="shrink-0 font-mono text-xs">{name}{top ? ":" : folder ? "/" : ""}</span>
                {dir ? <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{dir}</span> : null}
              </button>
            </li>
          );
        })}
        {!loading && !items.length ? <li className="px-2.5 py-1.5 text-xs text-muted-foreground">No file matches.</li> : null}
      </ul>
    </div>
  ) : null;

  return { open, list, onKeyDown, inputProps, detect };
}
