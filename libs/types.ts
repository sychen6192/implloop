// Shared types (SSOT: all other modules import from here).

// Agent roles. Each maps to an opencode agent definition impl-<role>.md with its own
// permission contract (see libs/guard.ts): planner/reviewer read-only, writer write+edit.
export type AgentRole = "planner" | "writer" | "reviewer";

export interface GateResult {
  passed: boolean;
  report: string;
  // Full raw output (persisted to the iteration dir).
  raw?: string;
}

// Agent-run output: final text plus tool-call observability.
// toolCallCount undefined = the runner cannot observe tool usage (must-read check disabled).
export interface AgentRunOutput {
  text: string;
  toolCallCount?: number;
}

// Runtime adapter: the interface that keeps the core free of SDK imports.
export interface AgentRunner {
  run(role: AgentRole, prompt: string): Promise<AgentRunOutput>;
}

// --- Plan (Phase P) ---

export interface PlanStep {
  id: number;
  goal: string;
  files: string[];
  // How the planner expects this step to be verified (informational; gates decide).
  verify: string;
}

export interface Plan {
  clarifications: string[];
  testPlan: string;
  steps: PlanStep[];
}

export type PlanOutcome =
  | { kind: "ok"; plan: Plan; raw: string }
  // Spec is ambiguous — stop and ask a human, never guess (exit 4).
  | { kind: "needs-clarification"; questions: string[]; raw: string }
  // Unparseable/invalid plan; reason is fed back for a bounded retry, then fatal.
  | { kind: "invalid"; reason: string; raw: string };

// --- Review (Phase R) ---

export const REQ_VERDICTS = [
  "satisfied",
  "missing",
  "partial",
  "misunderstood",
  "not-verifiable",
] as const;
export type ReqVerdict = (typeof REQ_VERDICTS)[number];

export interface RequirementJudgement {
  item: string;
  verdict: ReqVerdict;
  note?: string;
}

export interface ReviewVerdict {
  passed: boolean;
  requirements: RequirementJudgement[];
  // Hard problems: all must be fixed to pass. Non-empty = REJECT.
  blockers: string[];
  // Advisory improvements: non-blocking, kept out of feedback to avoid thrash.
  advisories: string[];
  parseError?: string;
  raw?: string;
}

// --- Run result ---

export type StopReason =
  | "all-green"
  | "stuck"
  | "session-budget"
  | "step-retries"
  | "review-rejected"
  | "blocked"
  | "needs-clarification"
  | "plan-invalid";

export interface OrchestratorResult {
  success: boolean;
  stopReason: StopReason;
  sessionsUsed: number;
  stepsCompleted: number;
  stepsTotal: number;
  branch: string;
  finalFeedback?: string;
  finalVerdict?: ReviewVerdict;
  blockedReason?: string;
  clarifications?: string[];
}
