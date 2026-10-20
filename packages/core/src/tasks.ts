export type TaskStatus = "ready_for_ai" | "in_progress" | "needs_info" | "ready_for_review" | "done" | "failed";

export type TaskRef = {
  id: string;
  title: string;
  updatedAt?: string;
};

export type TaskComment = {
  id: string;
  author: string;
  authorIsAgent: boolean;
  body: string;
  createdAt: string;
};

export type TaskAttachment = {
  id: string;
  name: string;
  url?: string;
};

export type TaskDetail = {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  url?: string;
  acceptanceCriteria?: string[];
  attachments?: TaskAttachment[];
};

export type Lease = {
  taskId: string;
  leaseId: string;
  expiresAt: string;
};

export type TaskSummary = {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt?: string;
  updatedAt?: string;
};

export interface TaskSource {
  readonly name: string;
  listTasks(): Promise<TaskSummary[]>;
  createTask(input: { title: string; body: string }): Promise<TaskDetail>;
  connect(): Promise<void>;
  close(): Promise<void>;
  listReady(): Promise<TaskRef[]>;
  claim(taskId: string): Promise<Lease | null>;
  renew(lease: Lease): Promise<Lease | null>;
  release(lease: Lease): Promise<void>;
  getTask(taskId: string): Promise<TaskDetail>;
  listComments(taskId: string): Promise<TaskComment[]>;
  comment(taskId: string, body: string, idempotencyKey: string): Promise<TaskComment>;
  setStatus(taskId: string, status: TaskStatus, idempotencyKey: string): Promise<void>;
}
