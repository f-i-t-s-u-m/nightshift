import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowUp, Check, ChevronRight, Eye, EyeOff, Folder, FolderGit2, FolderOpen, FolderPlus, Home, Loader2, Package } from "lucide-react";
import { toast } from "sonner";
import type { FsListResponse } from "@nightshift/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { fsApi, messageOf } from "../api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  initialPath?: string;
  selectLabel?: string;
  onSelect: (path: string, info: { isGitRepo: boolean }) => void;
};

export function FolderPicker({ open, onOpenChange, title, description, initialPath, selectLabel = "Select this folder", onSelect }: Props) {
  const [listing, setListing] = useState<FsListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    async (path?: string, hidden = showHidden) => {
      setLoading(true);
      setError(null);
      try {
        setListing(await fsApi.list(path, hidden));
      } catch (err) {
        setError(messageOf(err));
        if (path) {
          try {
            setListing(await fsApi.list(undefined, hidden));
          } catch {}
        }
      } finally {
        setLoading(false);
      }
    },
    [showHidden],
  );

  useEffect(() => {
    if (open) {
      setNewName(null);
      void load(initialPath?.trim() && initialPath.trim().startsWith("/") ? initialPath.trim() : undefined);
    }
  }, [open]);

  const createFolder = async (e: FormEvent) => {
    e.preventDefault();
    if (!listing || !newName?.trim()) return;
    setCreating(true);
    try {
      const { path } = await fsApi.mkdir(listing.path, newName.trim());
      toast.success(`Created ${newName.trim()}`);
      setNewName(null);
      await load(path);
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setCreating(false);
    }
  };

  const crumbs = listing
    ? (() => {
        const rel = listing.path.slice(listing.home.length).split("/").filter(Boolean);
        return [{ label: "Home", path: listing.home }, ...rel.map((part, i) => ({ label: part, path: `${listing.home}/${rel.slice(0, i + 1).join("/")}` }))];
      })()
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1">
          {listing?.shortcuts.map((s) => (
            <Button key={s.path} type="button" size="sm" variant={listing.path === s.path ? "secondary" : "ghost"} className="h-7 px-2 text-xs" onClick={() => void load(s.path)}>
              {s.label === "Home" ? <Home className="size-3.5" /> : <Folder className="size-3.5" />}
              {s.label}
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1.5">
          <Button type="button" size="icon" variant="ghost" className="size-7 shrink-0" aria-label="Up one folder" disabled={!listing?.parent || loading} onClick={() => listing?.parent && void load(listing.parent)}>
            <ArrowUp className="size-4" />
          </Button>
          <nav aria-label="Current folder" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto font-mono text-xs">
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex shrink-0 items-center gap-0.5">
                {i > 0 ? <ChevronRight className="size-3 text-muted-foreground" /> : null}
                <button type="button" className={cn("rounded px-1 py-0.5 hover:bg-accent", i === crumbs.length - 1 && "font-semibold")} onClick={() => void load(c.path)}>
                  {c.label}
                </button>
              </span>
            ))}
          </nav>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label={showHidden ? "Hide hidden folders" : "Show hidden folders"}
            aria-pressed={showHidden}
            onClick={() => {
              const next = !showHidden;
              setShowHidden(next);
              void load(listing?.path, next);
            }}
          >
            {showHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <ScrollArea className="h-80 rounded-md border">
          {loading && !listing ? (
            <div className="flex h-80 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
            </div>
          ) : listing && listing.entries.length === 0 ? (
            <div className="flex h-80 flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
              <FolderOpen className="size-6" />
              No folders here.
            </div>
          ) : (
            <ul role="list" className="divide-y">
              {listing?.entries.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none", e.hidden && "text-muted-foreground")}
                    onClick={() => void load(e.path)}
                  >
                    {e.isGitRepo ? <FolderGit2 className="size-4 shrink-0 text-primary" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    {e.isGitRepo ? (
                      <Badge variant="secondary" className="text-[10px]">
                        git
                      </Badge>
                    ) : null}
                    {e.hasPackageJson ? <Package className="size-3.5 text-muted-foreground" aria-label="Has package.json" /> : null}
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {listing?.truncated ? <p className="px-3 py-2 text-xs text-muted-foreground">Showing the first 500 folders.</p> : null}
        </ScrollArea>

        {newName !== null ? (
          <form className="flex items-end gap-2" onSubmit={(e) => void createFolder(e)}>
            <div className="grid flex-1 gap-1">
              <Label htmlFor="fp-new-folder" className="text-xs">
                New folder in {listing?.path.split("/").pop()}
              </Label>
              <Input id="fp-new-folder" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="my-new-app" spellCheck={false} />
            </div>
            <Button type="submit" disabled={!newName.trim() || creating}>
              {creating ? <Loader2 className="animate-spin" /> : <Check />} Create
            </Button>
            <Button type="button" variant="ghost" onClick={() => setNewName(null)}>
              Cancel
            </Button>
          </form>
        ) : null}

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {listing?.isGitRepo ? (
              <Badge variant="secondary">
                <FolderGit2 className="size-3" /> git repository
              </Badge>
            ) : null}
            <span className="truncate font-mono">{listing?.path}</span>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={!listing || newName !== null} onClick={() => setNewName("")}>
              <FolderPlus /> New folder
            </Button>
            <Button
              type="button"
              disabled={!listing || loading}
              onClick={() => {
                if (!listing) return;
                onSelect(listing.path, { isGitRepo: listing.isGitRepo });
                onOpenChange(false);
              }}
            >
              <Check /> {selectLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
