import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { ProjectSummary } from "@nightshift/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, messageOf } from "../api";
import { Spinner } from "./TaskBits";

export function ProjectDeleteCard({ project, onDeleted }: { project: ProjectSummary; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [removeWorkspaces, setRemoveWorkspaces] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim() === project.name;

  const remove = async () => {
    if (!matches || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await api.deleteProject(project.id, removeWorkspaces);
      toast.success(`${project.name} deleted`, {
        description: [res.stopped.length ? `Stopped ${res.stopped.join(", ")}.` : "", res.removedWorkspaces ? `Removed ${res.removedWorkspaces} task workspace(s).` : ""].filter(Boolean).join(" ") || undefined,
      });
      setOpen(false);
      onDeleted();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <Trash2 className="size-4" /> Delete project
        </CardTitle>
        <CardDescription>
          Stops its agents and previews and removes the project and its tasks from Nightshift. Your repository at <code>{project.repo.path}</code>, its branches and pull requests are not touched.
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="outline"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              setTyped("");
              setError(null);
              setOpen(true);
            }}
          >
            Delete…
          </Button>
        </CardAction>
      </CardHeader>
      <AlertDialog open={open} onOpenChange={(v) => (deleting ? null : setOpen(v))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {project.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Running agents are stopped and the project's tasks, messages and settings are removed. Usage history is kept. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-3">
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={removeWorkspaces} onCheckedChange={(v) => setRemoveWorkspaces(v === true)} disabled={deleting} className="mt-0.5" />
              <span>
                Also delete the task workspaces and databases
                <span className="block text-xs text-muted-foreground">Uncommitted changes in them are lost. Committed work stays on its branches in the repository.</span>
              </span>
            </label>
            <div className="grid gap-1.5">
              <Label htmlFor="delete-project-name" className="text-xs text-muted-foreground">
                Type <span className="font-mono text-foreground">{project.name}</span> to confirm
              </Label>
              <Input id="delete-project-name" value={typed} autoComplete="off" disabled={deleting} onChange={(e) => setTyped(e.target.value)} />
            </div>
            {error ? (
              <p className="text-xs text-destructive" role="alert">
                Could not delete: {error}
              </p>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!matches || deleting}
              onClick={(e) => {
                e.preventDefault();
                void remove();
              }}
            >
              {deleting ? <Spinner className="size-3.5 text-current" /> : null}
              Delete project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
