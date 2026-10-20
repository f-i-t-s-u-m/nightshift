import { useEffect, useState } from "react";
import { api, messageOf } from "../api";
import { Notice } from "../components/Notice";
import { EmptyState, Page, Spinner } from "../components/TaskBits";
import { navigate, taskHref } from "../routing";
import { useLive } from "../live";

export function RunRedirect({ id }: { id: string }) {
  const { runs } = useLive();
  const known = runs?.[id];
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (known) {
      navigate(taskHref(known.projectId, known.taskId), true);
      return;
    }
    let cancelled = false;
    api
      .run(id)
      .then((res) => {
        if (!cancelled) navigate(taskHref(res.run.projectId, res.run.taskId), true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageOf(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id, known]);

  return (
    <Page narrow>
      {error ? (
        <Notice tone="warning" title="Run not found">
          Could not open run <code>{id}</code>: {error}. <a href="#/">Go home</a>.
        </Notice>
      ) : (
        <EmptyState icon={<Spinner />} title="Opening task…" />
      )}
    </Page>
  );
}
