export type Tone = "neutral" | "info" | "accent" | "warning" | "success" | "danger" | "muted";

const PHASE_TONES: Record<string, Tone> = {
  claimed: "info",
  preparing: "info",
  working: "info",
  checking: "info",
  reviewing: "accent",
  pushing: "info",
  fixing: "warning",
  waiting_ci: "warning",
  needs_info: "accent",
  ready_for_review: "success",
  done: "success",
  failed: "danger",
  stopped: "muted",
};

export const phaseTone = (phase: string | null | undefined): Tone => (phase ? (PHASE_TONES[phase] ?? "neutral") : "muted");
