import type { Billing } from "@nightshift/core";
import { formatUsd } from "@nightshift/ui";
import { cn } from "@/lib/utils";
import { useLive } from "./live";

export const ESTIMATE_NOTE = "Estimated at API list prices. Models on a subscription sign-in use your plan's limits and are not billed per token.";

export function useBilling(): Record<string, Billing> {
  return useLive().status?.billing ?? {};
}

export const billingOf = (billing: Record<string, Billing>, model: string | null | undefined): Billing =>
  model ? (billing[model.split("/")[0]] ?? "none") : "none";

export const anySubscription = (billing: Record<string, Billing>) => Object.values(billing).includes("subscription");

export function Cost({ usd, model, className }: { usd: number; model?: string | null; className?: string }) {
  const billing = useBilling();
  const subscription = model ? billingOf(billing, model) === "subscription" : anySubscription(billing);
  if (!subscription) return <span className={cn("tabular-nums", className)}>{formatUsd(usd)}</span>;
  return (
    <span className={cn("tabular-nums", className)} title={ESTIMATE_NOTE}>
      ≈{formatUsd(usd)}
      <span className="ml-1 rounded bg-muted px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">plan</span>
    </span>
  );
}
