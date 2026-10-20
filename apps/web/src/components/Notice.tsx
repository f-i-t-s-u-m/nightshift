import type { ReactNode } from "react";
import { AlertTriangle, CircleAlert, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";

type NoticeTone = "info" | "warning" | "danger";

const ICONS: Record<NoticeTone, ReactNode> = {
  info: <Info />,
  warning: <AlertTriangle />,
  danger: <CircleAlert />,
};

export function Notice({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Alert
      variant={tone === "danger" ? "destructive" : "default"}
      role={tone === "danger" ? "alert" : "status"}
      className={cn(tone === "warning" && "border-amber-500/40 bg-amber-500/5 text-amber-800 dark:text-amber-200", className)}
    >
      {ICONS[tone]}
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      {children ? <AlertDescription className={cn(tone === "warning" && "text-amber-800/90 dark:text-amber-200/90")}>{children}</AlertDescription> : null}
      {action ? <AlertAction>{action}</AlertAction> : null}
    </Alert>
  );
}
