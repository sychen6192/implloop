// Central config (SSOT: every threshold and param is defined only here).
// Loads the tool's own .env without overriding existing env vars.
// REPO_ROOT = cwd at run time (must run from the target repo root).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRole } from "./libs/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// implloop's own dir (independent of cwd).
export const TOOL_ROOT = __dirname;

// --- Minimal .env loader (TOOL_ROOT/.env; never overrides existing env vars) ---
(function loadDotEnv() {
  const p = path.join(TOOL_ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i <= 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
})();

// Target repo root (= cwd).
export const REPO_ROOT = process.cwd();
// First CLI arg: the task spec file (markdown).
export const TASK_ARG = process.argv[2];

// --- Iteration & convergence (see PROPOSAL §5.3) ---
// Total agent-session budget across all phases (SWE-agent-style cap; salvage on exhaustion).
export const MAX_SESSIONS = Number(process.env.IL_MAX_SESSIONS ?? 20);
// Repair attempts per plan step (repair gains concentrate in rounds 0-2; aider caps at 3).
export const STEP_RETRIES = Number(process.env.IL_STEP_RETRIES ?? 3);
// Consecutive identical failure signatures before the stuck detector stops the run.
export const STUCK_REPEATS = Number(process.env.IL_STUCK_REPEATS ?? 2);
// Plan gate rejects plans with more steps (forces right-sized decomposition).
export const MAX_STEPS = Number(process.env.IL_MAX_STEPS ?? 8);
// Planner retries on an unparseable/invalid plan.
export const PLAN_RETRIES = Number(process.env.IL_PLAN_RETRIES ?? 2);
// Review-blocker fix rounds (each = one writer fix session + gates + re-review).
export const REVIEW_ROUNDS = Number(process.env.IL_REVIEW_ROUNDS ?? 2);

// --- Phase toggles ---
// Test-first phase (write failing acceptance tests, verify fail-to-pass, freeze them).
export const TEST_FIRST = process.env.IL_TEST_FIRST !== "0";
export const SKIP_REVIEW = process.env.IL_SKIP_REVIEW === "1";
// 1 = skip the baseline test run in preflight (not recommended: a red baseline makes
// every later gate result meaningless).
export const SKIP_BASELINE = process.env.IL_SKIP_BASELINE === "1";
// 0 = accept reviewer verdicts produced without a single tool call (default: fail-closed).
export const REVIEWER_MUST_READ = process.env.IL_REVIEWER_MUST_READ !== "0";
export const QUIET = process.env.IL_QUIET === "1";
// 1 = skip the agent frontmatter permission guard (not recommended).
export const SKIP_GUARD = process.env.IL_SKIP_GUARD === "1";

// --- Gates ---
// Build/test commands; empty = auto-detect (maven / gradle / npm / pytest).
export const BUILD_CMD = process.env.IL_BUILD_CMD ?? "";
export const TEST_CMD = process.env.IL_TEST_CMD ?? "";
// Wall-clock timeout for one build/test gate run.
export const GATE_TIMEOUT_MS = Number(process.env.IL_GATE_TIMEOUT_MS ?? 15 * 60 * 1000);
// Extra protected globs on top of the built-in test/CI patterns (comma-separated).
export const EXTRA_PROTECT_GLOBS = (process.env.IL_PROTECT ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// --- Git ---
export const BRANCH_PREFIX = process.env.IL_BRANCH_PREFIX ?? "implloop/";

// --- Runner ---
export const RUNNER_KIND = (process.env.IL_RUNNER ?? "opencode") as "opencode";
// Models: empty = don't pass --model; the agent .md's model field decides.
export const ROLE_MODELS: Record<AgentRole, string> = {
  planner: process.env.IL_PLANNER_MODEL ?? process.env.IL_MODEL ?? "",
  writer: process.env.IL_WRITER_MODEL ?? process.env.IL_MODEL ?? "",
  reviewer: process.env.IL_REVIEWER_MODEL ?? "",
};
// --dangerously-skip-permissions may only ever be applied to the writer.
export const ROLE_SKIP_PERMS: Record<AgentRole, boolean> = {
  planner: false,
  writer: true,
  reviewer: false,
};
// Per-session agent wall-clock timeout. Dense ~27B models run 15-25 tok/s; a full
// implementation step needs headroom (same lesson as testgen's 25-minute setting).
export const AGENT_TIMEOUT_MS = Number(process.env.IL_AGENT_TIMEOUT_MS ?? 25 * 60 * 1000);
export const OPENCODE_BIN = process.env.IL_OPENCODE_BIN ?? "opencode";
// 0 = drop --format json (fallback for versions without JSONL events; loses live progress).
export const OPENCODE_JSON_EVENTS = process.env.IL_OPENCODE_JSON !== "0";
// 1 = append --dangerously-skip-permissions to writer calls (last resort when
// non-interactive permission blocks writes; writer bash/web are off at the tools layer).
export const OPENCODE_SKIP_PERMS = process.env.IL_OC_SKIP_PERMS === "1";

// Artifacts, namespaced per target repo: runs/<repo basename>/<timestamp>/.
export const RUNS_DIR = path.join(TOOL_ROOT, "runs", path.basename(REPO_ROOT));

// Global opencode config dir (agents installed here by scripts/setup.ts).
export const GLOBAL_OPENCODE_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "opencode",
);
