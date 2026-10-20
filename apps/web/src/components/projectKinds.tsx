import { Boxes, Folder, Globe, Layers, Monitor, Package, Palette, Server, Smartphone, type LucideIcon } from "lucide-react";
import { PROJECT_KINDS, type ProjectKind } from "@nightshift/core";
import { cn } from "@/lib/utils";

export const KIND_ICON: Record<ProjectKind, LucideIcon> = {
  web: Globe,
  mobile: Smartphone,
  backend: Server,
  fullstack: Layers,
  desktop: Monitor,
  library: Package,
  design: Palette,
  monorepo: Boxes,
  other: Folder,
};

const EXTRA_KINDS: Array<{ kind: ProjectKind; label: string; description: string }> = [
  { kind: "monorepo", label: "Monorepo", description: "Several apps and packages in one repository." },
];

export const kindDef = (kind: ProjectKind | undefined) =>
  [...PROJECT_KINDS, ...EXTRA_KINDS].find((k) => k.kind === kind) ?? { kind: kind ?? "other", label: kind ?? "Other", description: "" };

export const kindOptions = (current?: ProjectKind) =>
  current && !PROJECT_KINDS.some((k) => k.kind === current) ? [...PROJECT_KINDS, kindDef(current)] : PROJECT_KINDS;

export function KindIcon({ kind, className }: { kind: ProjectKind | undefined; className?: string }) {
  const Icon = KIND_ICON[kind ?? "other"] ?? Folder;
  return <Icon className={cn("size-4 shrink-0", className)} aria-hidden="true" />;
}
