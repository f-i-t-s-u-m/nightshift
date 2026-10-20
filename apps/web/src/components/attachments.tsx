import { createContext, useCallback, useContext, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { ExternalLink, FileText, Loader2, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { AttachmentRef } from "@nightshift/core";
import { api, messageOf } from "../api";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type Upload = {
  key: string;
  name: string;
  preview: string;
  state: "uploading" | "done" | "error";
  error: string | null;
  attachment: AttachmentRef | null;
};

let seq = 0;

const imageFiles = (list: FileList | File[] | null | undefined): File[] =>
  Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));

export function useUploads() {
  const [items, setItems] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const live = useRef(items);
  live.current = items;

  useEffect(
    () => () => {
      for (const item of live.current) URL.revokeObjectURL(item.preview);
    },
    [],
  );

  const patch = (key: string, next: Partial<Upload>) =>
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...next } : item)));

  const add = useCallback((files: FileList | File[] | null | undefined) => {
    const all = Array.from(files ?? []);
    const images = imageFiles(all);
    setRejected(images.length < all.length ? "Only pictures can be attached." : null);
    for (const file of images) {
      const key = `u${++seq}`;
      const name = file.name || "pasted-image.png";
      const tooBig = file.size > MAX_UPLOAD_BYTES;
      const item: Upload = {
        key,
        name,
        preview: URL.createObjectURL(file),
        state: tooBig ? "error" : "uploading",
        error: tooBig ? "Larger than 10 MB" : null,
        attachment: null,
      };
      setItems((prev) => [...prev, item]);
      if (tooBig) continue;
      api
        .upload(file)
        .then((res) => patch(key, { state: "done", attachment: res.attachment }))
        .catch((err: unknown) => patch(key, { state: "error", error: messageOf(err) }));
    }
  }, []);

  const remove = useCallback((key: string) => {
    setItems((prev) => {
      const gone = prev.find((i) => i.key === key);
      if (gone) URL.revokeObjectURL(gone.preview);
      return prev.filter((i) => i.key !== key);
    });
  }, []);

  const clear = useCallback(() => {
    setItems((prev) => {
      for (const item of prev) URL.revokeObjectURL(item.preview);
      return [];
    });
    setRejected(null);
  }, []);

  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const files = imageFiles(e.clipboardData?.files);
      if (files.length === 0) return;
      e.preventDefault();
      add(files);
    },
    [add],
  );

  const dropProps = {
    onDragEnter: (e: DragEvent) => {
      if (e.dataTransfer.types.includes("Files")) setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragging(false);
      add(e.dataTransfer.files);
    },
  };

  const ready = items.filter((i) => i.state === "done" && i.attachment);
  return {
    items,
    add,
    remove,
    clear,
    onPaste,
    dropProps,
    dragging,
    rejected,
    uploading: items.some((i) => i.state === "uploading"),
    failed: items.some((i) => i.state === "error"),
    attachments: ready.map((i) => i.attachment as AttachmentRef),
  };
}

export type Uploads = ReturnType<typeof useUploads>;

export function AttachButton({ uploads, label = "Attach pictures", compact }: { uploads: Uploads; label?: string; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size={compact ? "icon-sm" : "sm"}
        onClick={() => input.current?.click()}
        aria-label={compact ? label : undefined}
        title={label}
      >
        <Paperclip />
        {compact ? null : <span>{label}</span>}
      </Button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        tabIndex={-1}
        onChange={(e) => {
          uploads.add(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
    </>
  );
}

export function UploadTray({ uploads }: { uploads: Uploads }) {
  if (uploads.items.length === 0 && !uploads.rejected) return null;
  return (
    <div className="grid gap-2">
      {uploads.rejected ? <div className="text-xs text-destructive">{uploads.rejected}</div> : null}
      {uploads.items.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Attached pictures">
          {uploads.items.map((item) => (
            <li
              key={item.key}
              className={cn("relative size-16 overflow-hidden rounded-md border bg-muted", item.state === "error" && "border-destructive")}
              title={item.error ?? item.name}
            >
              <img src={item.preview} alt={item.name} className={cn("size-full object-cover", item.state !== "done" && "opacity-50")} />
              {item.state === "uploading" ? (
                <span className="absolute inset-0 flex items-center justify-center">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  <span className="sr-only">Uploading {item.name}</span>
                </span>
              ) : null}
              {item.state === "error" ? (
                <span className="absolute inset-x-0 bottom-0 truncate bg-destructive px-1 text-[10px] text-white">{item.error ?? "Failed"}</span>
              ) : null}
              <button
                type="button"
                className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm hover:bg-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label={`Remove ${item.name}`}
                onClick={() => uploads.remove(item.key)}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type LightboxState = { url: string; alt: string } | null;

const LightboxContext = createContext<(url: string, alt: string) => void>(() => undefined);

export function LightboxProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<LightboxState>(null);
  const [last, setLast] = useState<LightboxState>(null);
  const current = shown ?? last;

  return (
    <LightboxContext.Provider
      value={useCallback((url: string, alt: string) => {
        setShown({ url, alt });
        setLast({ url, alt });
      }, [])}
    >
      {children}
      <Dialog open={shown !== null} onOpenChange={(open) => (open ? null : setShown(null))}>
        <DialogContent className="max-h-[92svh] gap-3 p-3 sm:max-w-[min(92vw,1200px)]">
          <DialogTitle className="sr-only">{current?.alt ?? "Picture"}</DialogTitle>
          <DialogDescription className="sr-only">Full size picture</DialogDescription>
          {current ? <img src={current.url} alt={current.alt} className="max-h-[78svh] w-full rounded-md object-contain" /> : null}
          <DialogFooter className="items-center sm:justify-between">
            <span className="truncate text-sm text-muted-foreground">{current?.alt}</span>
            {current ? (
              <Button asChild variant="outline" size="sm">
                <a href={current.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink /> Open original
                </a>
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LightboxContext.Provider>
  );
}

export function AttachmentThumbs({ attachments, size = "md" }: { attachments: AttachmentRef[]; size?: "sm" | "md" }) {
  const open = useContext(LightboxContext);
  const images = attachments.filter((a) => a.mimeType.startsWith("image/"));
  const files = attachments.filter((a) => !a.mimeType.startsWith("image/"));
  if (attachments.length === 0) return null;
  return (
    <div className="mt-2 grid gap-2">
      {images.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {images.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className={cn(
                  "block overflow-hidden rounded-md border bg-muted transition-opacity hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  size === "sm" ? "size-16" : "h-28 w-40",
                )}
                onClick={() => open(a.url, a.name)}
                aria-label={`Open ${a.name} full size`}
              >
                <img src={a.url} alt={a.name} loading="lazy" className="size-full object-cover" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {files.map((a) => (
        <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline">
          <FileText className="size-4" />
          {a.name}
        </a>
      ))}
    </div>
  );
}
