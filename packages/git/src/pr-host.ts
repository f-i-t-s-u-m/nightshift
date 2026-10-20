export type PrInfo = { number: number; url: string; headSha: string | null };

export type CheckState = "pending" | "success" | "failure" | "neutral";

export type PrCheck = { name: string; state: CheckState; detailsUrl?: string; summary?: string };

export type PrReview = { id: string; author: string; state: string; body: string; submittedAt: string };

export type PrComment = { id: string; author: string; body: string; createdAt: string; path?: string; line?: number };

export type PrStatus = {
  state: "open" | "merged" | "closed";
  headSha: string | null;
  checks: PrCheck[];
  reviews: PrReview[];
  comments: PrComment[];
};

export type OpenPr = { number: number; url: string; branch: string; base: string; headSha: string | null };

export interface PrHost {
  readonly name: string;
  listOpen(): Promise<OpenPr[]>;
  findOpen(branch: string): Promise<PrInfo | null>;
  create(input: { branch: string; base: string; title: string; body: string }): Promise<PrInfo>;
  status(number: number): Promise<PrStatus>;
  failureLog(check: PrCheck): Promise<string | null>;
}

export function summarizeChecks(checks: PrCheck[]): CheckState {
  if (checks.some((c) => c.state === "failure")) return "failure";
  if (checks.some((c) => c.state === "pending")) return "pending";
  if (checks.length === 0) return "neutral";
  return "success";
}
