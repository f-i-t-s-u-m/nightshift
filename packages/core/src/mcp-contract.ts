export const WONDERCALL_SERVICE_TOOLS = {
  listReady: "list_ready_tasks",
  claim: "claim_task",
  renew: "renew_claim",
  release: "release_task",
  setStatus: "set_task_status",
  listTasks: "list_tasks",
  createTask: "create_task",
} as const;

export const WONDERCALL_TASK_TOOLS = {
  get: "get_task",
  listComments: "list_comments",
  comment: "post_comment",
  askQuestion: "ask_question",
} as const;

export type McpListReadyResult = { tasks: Array<{ id: string; title: string; updatedAt?: string }> };
export type McpClaimResult = { claimed: true; leaseId: string; expiresAt: string } | { claimed: false; reason: string };
export type McpRenewResult = { renewed: true; expiresAt: string } | { renewed: false; reason: string };
