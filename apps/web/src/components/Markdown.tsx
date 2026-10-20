import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "para"; text: string };

const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;

const parseBlocks = (source: string): Block[] => {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "para", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(fence[1] ?? "```")) body.push(lines[i++] ?? "");
      blocks.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = Boolean(item[2]);
      const items: string[] = [item[3] ?? ""];
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? "";
        const m = LIST_ITEM.exec(next);
        if (m && Boolean(m[2]) === ordered) {
          items.push(m[3] ?? "");
          i++;
        } else if (next.trim() && /^\s{2,}/.test(next)) {
          items[items.length - 1] += `\n${next.trim()}`;
          i++;
        } else break;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (line.startsWith(">")) {
      flush();
      const quote = [line.replace(/^>\s?/, "")];
      while (i + 1 < lines.length && (lines[i + 1] ?? "").startsWith(">")) quote.push((lines[++i] ?? "").replace(/^>\s?/, ""));
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
};

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

const renderInline = (text: string, keyPrefix: string): ReactNode[] => {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const index = m.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const key = `${keyPrefix}-${n++}`;
    const [whole, code, bold, link, linkUrl, bare] = m;
    if (code) out.push(<code key={key}>{code.slice(1, -1)}</code>);
    else if (bold) out.push(<strong key={key}>{bold.slice(2, -2)}</strong>);
    else if (link && linkUrl)
      out.push(
        <a key={key} href={linkUrl} target="_blank" rel="noopener noreferrer">
          {link.slice(1, link.indexOf("]("))}
        </a>,
      );
    else if (bare)
      out.push(
        <a key={key} href={bare} target="_blank" rel="noopener noreferrer">
          {bare}
        </a>,
      );
    else out.push(whole);
    last = index + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div
      className={cn(
        "space-y-2 text-sm leading-relaxed break-words [&_a]:underline [&_a]:underline-offset-4 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em]",
        className,
      )}
    >
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case "code":
            return (
              <pre key={key} className="overflow-x-auto rounded-md border bg-muted/60 p-3 font-mono text-xs leading-relaxed" data-lang={b.lang || undefined}>
                <code>{b.text}</code>
              </pre>
            );
          case "heading":
            return (
              <p key={key} className={cn("font-semibold", b.level === 1 ? "text-base" : "text-sm")}>
                {renderInline(b.text, key)}
              </p>
            );
          case "list": {
            const items = b.items.map((item, j) => <li key={j}>{renderInline(item, `${key}-${j}`)}</li>);
            return b.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
          }
          case "quote":
            return <blockquote key={key}>{renderInline(b.text, key)}</blockquote>;
          case "para":
            return <p key={key}>{renderInline(b.text, key)}</p>;
        }
      })}
    </div>
  );
}
