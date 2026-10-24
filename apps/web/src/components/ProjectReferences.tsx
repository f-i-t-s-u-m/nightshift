import { useEffect, useId, useState } from "react";
import { FolderOpen, Library, X } from "lucide-react";
import { REFERENCE_NAME_PATTERN, type ProjectReference, type ProjectSummary } from "@nightshift/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "../api";
import { FolderPicker } from "./FolderPicker";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "ref";

/** Read-only reference folders: other projects or folders the owner can @-mention as `@name:path` and agents may read. */
export function ProjectReferencesCard({
  projectId,
  repoPath,
  value,
  onChange,
  disabled,
}: {
  projectId: string;
  repoPath: string;
  value: ProjectReference[];
  onChange: (next: ProjectReference[]) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [draft, setDraft] = useState<ProjectReference | null>(null);

  useEffect(() => {
    void api
      .projects()
      .then((res) => setProjects(res.projects))
      .catch(() => {});
  }, []);

  const others = projects.filter((p) => p.id !== projectId && p.repo.path !== repoPath && !value.some((r) => r.path === p.repo.path));
  const uniqueName = (base: string) => {
    let name = slug(base);
    for (let n = 2; value.some((r) => r.name === name); n++) name = `${slug(base).slice(0, 29)}-${n}`;
    return name;
  };
  const nameError = draft && (!REFERENCE_NAME_PATTERN.test(draft.name) ? "Lower-case letters, digits and -, up to 32" : value.some((r) => r.name === draft.name) ? "Already used" : null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Library className="size-4 text-muted-foreground" /> References
        </CardTitle>
        <CardDescription>
          Other projects or folders agents may read but never change, for example an app whose patterns this one should follow. Point at a file in one with <code className="font-mono">@name:path</code> in a message, a task or the brief.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {value.length ? (
          <ul className="divide-y rounded-lg border text-sm">
            {value.map((r) => (
              <li key={r.name} className="flex items-center gap-3 px-3 py-2">
                <code className="shrink-0 font-mono text-xs font-semibold">@{r.name}:</code>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={r.path}>
                  {r.path}
                </span>
                <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={`Remove the reference ${r.name}`} onClick={() => onChange(value.filter((x) => x.name !== r.name))}>
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No references yet.</p>
        )}
        {draft ? (
          <div className="grid gap-2 rounded-lg border bg-muted/30 p-3">
            <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
              <div className="grid gap-1">
                <Label htmlFor={`${id}-name`} className="text-xs">
                  Name
                </Label>
                <Input id={`${id}-name`} className="h-8 font-mono text-xs" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value.toLowerCase() })} aria-invalid={Boolean(nameError)} />
              </div>
              <div className="grid gap-1">
                <span className="text-xs font-medium">Folder</span>
                <code className="truncate rounded-md border bg-background px-2 py-1.5 font-mono text-xs" title={draft.path}>
                  {draft.path}
                </code>
              </div>
            </div>
            {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={Boolean(nameError) || disabled}
                onClick={() => {
                  onChange([...value, draft]);
                  setDraft(null);
                }}
              >
                Add reference
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {others.length ? (
              <Select
                value=""
                onValueChange={(pid) => {
                  const p = others.find((x) => x.id === pid);
                  if (p) setDraft({ name: uniqueName(p.id), path: p.repo.path });
                }}
                disabled={disabled}
              >
                <SelectTrigger className="h-8 w-56" aria-label="Add another project as a reference">
                  <SelectValue placeholder="Add another project…" />
                </SelectTrigger>
                <SelectContent>
                  {others.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button type="button" variant="outline" size="sm" disabled={disabled || value.length >= 10} onClick={() => setBrowsing(true)}>
              <FolderOpen /> Add a folder…
            </Button>
            <span className="text-xs text-muted-foreground">
              Hidden, env, key and credential files are never read.
            </span>
          </div>
        )}
        <FolderPicker
          open={browsing}
          onOpenChange={setBrowsing}
          title="Choose a reference folder"
          description="Agents may read this folder but never change it."
          initialPath={repoPath.split("/").slice(0, -1).join("/")}
          selectLabel="Use as a reference"
          onSelect={(folder: string) => {
            setBrowsing(false);
            setDraft({ name: uniqueName(folder.split("/").filter(Boolean).pop() ?? "ref"), path: folder });
          }}
        />
      </CardContent>
    </Card>
  );
}
