// Iteration orchestrator: the single deterministic control loop.
// Zero SDK imports — all agent interaction goes through the AgentRunner interface.
// Phases: Plan → Test-first → Implement (one fresh session per step) → Review.
// Cross-phase state lives only in artifacts and git (state in artifacts, not context);
// every stop path salvages — green commits stay on the branch, dirty work is reset.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MAX_SESSIONS,
  STEP_RETRIES,
  STUCK_REPEATS,
  PLAN_RETRIES,
  REVIEW_ROUNDS,
  TEST_FIRST,
  SKIP_REVIEW,
  REPO_ROOT,
} from "./config";
import { log, banner, tail } from "./libs/log";
import { AgentRunner, OrchestratorResult, Plan, ReviewVerdict } from "./libs/types";
import {
  buildPlanPrompt,
  buildTestFirstPrompt,
  buildStepPrompt,
  buildReviewFixPrompt,
  buildReviewPrompt,
  detectBlocked,
} from "./prompts";
import { parsePlan } from "./gates/plan";
import { BuildConfig, looksLikeCompileFailure, runBuildGate, runTestGate } from "./gates/build";
import { checkProtect, looksLikeTestPath, violationReport } from "./gates/protect";
import { runReviewGate } from "./gates/review";
import { buildFailureReport } from "./libs/feedback";
import { StuckDetector } from "./libs/stuck";
import {
  commitAll,
  resetHardClean,
  uncommittedFiles,
  uncommittedAddedLines,
  diffAgainst,
  changedFilesSince,
} from "./libs/git";

export interface OrchestratorConfig {
  task: string;
  runner: AgentRunner;
  buildCfg: BuildConfig;
  runDir: string;
  branch: string;
  baseSha: string;
}

interface Ctx extends OrchestratorConfig {
  sessionsUsed: number;
  frozenFiles: string[];
}

function saveTo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  return (name: string, content: string) =>
    fs.writeFileSync(path.join(dir, name), content ?? "");
}

// One budgeted agent session. Returns null when the session budget is exhausted.
async function session(
  ctx: Ctx,
  role: "planner" | "writer" | "reviewer",
  prompt: string,
): Promise<{ text: string; toolCallCount?: number } | null> {
  if (ctx.sessionsUsed >= MAX_SESSIONS) return null;
  ctx.sessionsUsed += 1;
  log(`（session ${ctx.sessionsUsed}/${MAX_SESSIONS}）`);
  return ctx.runner.run(role, prompt);
}

function result(
  ctx: Ctx,
  partial: Omit<
    OrchestratorResult,
    "sessionsUsed" | "branch" | "stepsCompleted" | "stepsTotal"
  > & { stepsCompleted?: number; stepsTotal?: number },
): OrchestratorResult {
  return {
    sessionsUsed: ctx.sessionsUsed,
    branch: ctx.branch,
    stepsCompleted: partial.stepsCompleted ?? 0,
    stepsTotal: partial.stepsTotal ?? 0,
    ...partial,
  };
}

// --- Phase P ---

async function phasePlan(
  ctx: Ctx,
): Promise<{ plan?: Plan; stop?: OrchestratorResult }> {
  banner("Phase P：Plan（唯讀規劃）");
  let fixNote: string | undefined;
  for (let attempt = 1; attempt <= PLAN_RETRIES + 1; attempt++) {
    const save = saveTo(path.join(ctx.runDir, `plan-${attempt}`));
    const prompt = buildPlanPrompt(ctx.task, fixNote);
    save("prompt.md", prompt);
    const out = await session(ctx, "planner", prompt);
    if (!out) return { stop: result(ctx, { success: false, stopReason: "session-budget" }) };
    save("raw.txt", out.text);

    const outcome = parsePlan(out.text, REPO_ROOT);
    if (outcome.kind === "needs-clarification") {
      log("[STOP] 規格不清，planner 提出問題（不猜，交還人類）：");
      outcome.questions.forEach((q, i) => log(`  ${i + 1}. ${q}`));
      return {
        stop: result(ctx, {
          success: false,
          stopReason: "needs-clarification",
          clarifications: outcome.questions,
        }),
      };
    }
    if (outcome.kind === "invalid") {
      log(`[FAIL] plan gate：${outcome.reason}`);
      fixNote = outcome.reason;
      continue;
    }
    save("plan.json", JSON.stringify(outcome.plan, null, 2));
    log(`[OK] plan gate：${outcome.plan.steps.length} 個步驟`);
    outcome.plan.steps.forEach((s) => log(`  ${s.id}. ${s.goal}`));
    return { plan: outcome.plan };
  }
  return {
    stop: result(ctx, {
      success: false,
      stopReason: "plan-invalid",
      finalFeedback: fixNote,
    }),
  };
}

// --- Shared gate chain (protect → build → test) ---

interface GateChainOutcome {
  green: boolean;
  feedback?: string;
  gate?: string;
  raw?: string;
  // true = the working tree was reset (protect violation); writer starts over.
  wasReset?: boolean;
}

function runGateChain(
  ctx: Ctx,
  phase: "tests" | "impl",
  expectTestFailure: boolean,
): GateChainOutcome {
  const violations = checkProtect({
    changedFiles: uncommittedFiles(),
    addedLines: uncommittedAddedLines(),
    frozenFiles: ctx.frozenFiles,
    phase,
  });
  if (violations.length > 0) {
    const report = violationReport(violations);
    log(`[FAIL] protect gate：${violations.length} 項違規，還原本輪改動`);
    resetHardClean();
    return { green: false, feedback: report, gate: "protect", wasReset: true };
  }

  const build = runBuildGate(ctx.buildCfg);
  if (!build.passed) {
    log("[FAIL] build gate");
    return { green: false, feedback: build.report, gate: "build", raw: build.raw };
  }
  log("[OK] build gate");

  const test = runTestGate(ctx.buildCfg);
  if (expectTestFailure) {
    // Red because the test code doesn't compile is not a valid "failing test".
    if (!test.passed && looksLikeCompileFailure(test.raw ?? "")) {
      log("[FAIL] fail-to-pass gate：測試碼編譯失敗（不是合法的紅燈）");
      return {
        green: false,
        gate: "test-compile",
        feedback: buildFailureReport({
          gate: "fail-to-pass gate",
          raw: test.raw ?? "",
          instruction: "測試必須「可編譯且執行後斷言失敗」；請先修正測試碼的編譯錯誤。",
        }),
        raw: test.raw,
      };
    }
    // Phase T: the new acceptance tests MUST fail (fail-to-pass verified by the loop).
    if (test.passed) {
      log("[FAIL] fail-to-pass gate：新測試沒有失敗");
      return {
        green: false,
        gate: "fail-to-pass",
        feedback:
          "測試全數通過了，但此階段的驗收測試必須「失敗」（功能還沒實作）。\n" +
          "可能原因：測試沒有真的驗到新行為（無意義斷言）、或你實作了功能本身。\n" +
          "請改寫測試使其驗證 task 要求的新行為，且不要實作功能。",
        raw: test.raw,
      };
    }
    log("[OK] fail-to-pass gate：新測試如預期失敗");
    return { green: true };
  }
  if (!test.passed) {
    log("[FAIL] test gate");
    return { green: false, feedback: test.report, gate: "test", raw: test.raw };
  }
  log("[OK] test gate");
  return { green: true };
}

// --- Writer attempt loop shared by Phase T / Phase I / review-fix ---

interface AttemptLoopInput {
  label: string;
  artifactPrefix: string;
  phase: "tests" | "impl";
  expectTestFailure: boolean;
  buildPrompt: (feedback?: string) => string;
  commitMessage: string;
}

type AttemptLoopOutcome =
  | { kind: "green"; changed: string[] }
  | { kind: "blocked"; reason: string }
  | { kind: "budget" }
  | { kind: "stuck"; feedback: string }
  | { kind: "retries"; feedback: string };

async function writerAttempts(ctx: Ctx, input: AttemptLoopInput): Promise<AttemptLoopOutcome> {
  const stuck = new StuckDetector(STUCK_REPEATS);
  let feedback: string | undefined;
  for (let attempt = 1; attempt <= STEP_RETRIES + 1; attempt++) {
    const save = saveTo(path.join(ctx.runDir, `${input.artifactPrefix}-attempt-${attempt}`));
    const prompt = input.buildPrompt(feedback);
    save("prompt.md", prompt);
    log(`${input.label}：第 ${attempt}/${STEP_RETRIES + 1} 次嘗試`);
    const out = await session(ctx, "writer", prompt);
    if (!out) {
      resetHardClean();
      return { kind: "budget" };
    }
    save("writer.md", out.text || "（writer 未回傳文字）");
    log(`[writer 總結] ${tail(out.text, 800)}`);

    const blocked = detectBlocked(out.text);
    if (blocked) {
      log(`[STOP] writer 回報 BLOCKED：${blocked}`);
      resetHardClean();
      return { kind: "blocked", reason: blocked };
    }

    const changedBefore = uncommittedFiles();
    const chain = runGateChain(ctx, input.phase, input.expectTestFailure);
    if (chain.raw) save(`${chain.gate}.log`, chain.raw);
    if (chain.green) {
      const changed = changedBefore;
      if (!commitAll(input.commitMessage)) {
        // Nothing changed but gates are green — treat as a failed attempt, not progress.
        feedback = "你沒有做出任何檔案改動。請實際完成本次任務要求的修改。";
        save("feedback.md", feedback);
        if (stuck.record("no-change", feedback)) {
          return { kind: "stuck", feedback };
        }
        continue;
      }
      log(`[OK] ${input.label} 全綠，已 commit checkpoint`);
      return { kind: "green", changed };
    }

    feedback = chain.feedback!;
    save("feedback.md", feedback);
    if (stuck.record(chain.gate!, feedback)) {
      log(`[STOP] 停損：同一失敗簽章連續出現 ${STUCK_REPEATS + 1} 次，沒有新資訊`);
      resetHardClean();
      return { kind: "stuck", feedback };
    }
    log("→ 帶著失敗報告進入下一次嘗試");
  }
  resetHardClean();
  return { kind: "retries", feedback: feedback ?? "重試次數用盡" };
}

// --- Main ---

export async function orchestrate(cfg: OrchestratorConfig): Promise<OrchestratorResult> {
  const ctx: Ctx = { ...cfg, sessionsUsed: 0, frozenFiles: [] };

  // Phase P
  const planned = await phasePlan(ctx);
  if (planned.stop) return planned.stop;
  const plan = planned.plan!;
  const stepsTotal = plan.steps.length;
  let stepsCompleted = 0;
  const fail = (
    partial: Partial<OrchestratorResult> & { stopReason: OrchestratorResult["stopReason"] },
  ) => result(ctx, { success: false, stepsCompleted, stepsTotal, ...partial });

  // Phase T
  if (TEST_FIRST) {
    banner("Phase T：Test-first（先寫會失敗的驗收測試）");
    const outcome = await writerAttempts(ctx, {
      label: "驗收測試",
      artifactPrefix: "tests",
      phase: "tests",
      expectTestFailure: true,
      buildPrompt: () => buildTestFirstPrompt(ctx.task, plan.testPlan),
      commitMessage: "implloop: acceptance tests (red)",
    });
    if (outcome.kind === "green") {
      ctx.frozenFiles = outcome.changed.filter(looksLikeTestPath);
      log(`已凍結驗收測試 ${ctx.frozenFiles.length} 檔：`);
      ctx.frozenFiles.forEach((f) => log(`  - ${f}`));
    } else if (outcome.kind === "blocked") {
      return fail({ stopReason: "blocked", blockedReason: outcome.reason });
    } else if (outcome.kind === "budget") {
      return fail({ stopReason: "session-budget" });
    } else {
      return fail({ stopReason: outcome.kind === "stuck" ? "stuck" : "step-retries", finalFeedback: outcome.feedback });
    }
  }

  // Phase I
  banner("Phase I：Implement（一步驟一 session）");
  for (const step of plan.steps) {
    log(`── 步驟 ${step.id}/${stepsTotal}：${step.goal}`);
    const outcome = await writerAttempts(ctx, {
      label: `步驟 ${step.id}`,
      artifactPrefix: `step-${step.id}`,
      phase: "impl",
      expectTestFailure: false,
      buildPrompt: (feedback) =>
        buildStepPrompt({
          task: ctx.task,
          step,
          stepIndex: step.id,
          stepsTotal,
          frozenFiles: ctx.frozenFiles,
          feedback,
        }),
      commitMessage: `implloop: step ${step.id} — ${step.goal.slice(0, 60)}`,
    });
    if (outcome.kind === "green") {
      stepsCompleted += 1;
      continue;
    }
    if (outcome.kind === "blocked") {
      return fail({ stopReason: "blocked", blockedReason: outcome.reason });
    }
    if (outcome.kind === "budget") return fail({ stopReason: "session-budget" });
    return fail({
      stopReason: outcome.kind === "stuck" ? "stuck" : "step-retries",
      finalFeedback: outcome.feedback,
    });
  }

  // Phase T sanity: with test-first on, the frozen acceptance tests must now pass —
  // already guaranteed by the last step's test gate (whole suite green).

  // Phase R
  if (SKIP_REVIEW) {
    log("依設定跳過 review gate");
    return result(ctx, {
      success: true,
      stopReason: "all-green",
      stepsCompleted,
      stepsTotal,
    });
  }
  banner("Phase R：Review（跨模型單回合審查）");
  let lastVerdict: ReviewVerdict | undefined;
  for (let round = 1; round <= REVIEW_ROUNDS; round++) {
    const save = saveTo(path.join(ctx.runDir, `review-${round}`));
    const diff = diffAgainst(cfg.baseSha);
    const changedFiles = changedFilesSince(cfg.baseSha);
    const prompt = buildReviewPrompt({ task: ctx.task, diff, changedFiles });
    save("prompt.md", prompt);
    if (ctx.sessionsUsed >= MAX_SESSIONS) return fail({ stopReason: "session-budget" });
    ctx.sessionsUsed += 1;
    const verdict = await runReviewGate(ctx.runner, prompt);
    lastVerdict = verdict;
    save("verdict.json", JSON.stringify(verdict, (k, v) => (k === "raw" ? undefined : v), 2));
    if (verdict.raw) save("review-raw.txt", verdict.raw);

    if (verdict.passed) {
      log("[OK] review gate：PASS");
      return result(ctx, {
        success: true,
        stopReason: "all-green",
        stepsCompleted,
        stepsTotal,
        finalVerdict: verdict,
      });
    }
    log(`[FAIL] review gate：REJECT（blockers ${verdict.blockers.length}）`);
    verdict.blockers.forEach((b, i) => log(`  blocker ${i + 1}. ${b}`));
    if (round === REVIEW_ROUNDS) break;

    const fixOutcome = await writerAttempts(ctx, {
      label: `review 修正（round ${round}）`,
      artifactPrefix: `review-${round}-fix`,
      phase: "impl",
      expectTestFailure: false,
      buildPrompt: (feedback) =>
        feedback
          ? buildStepPrompt({
              task: ctx.task,
              step: { id: 0, goal: "修正 review blockers", files: [], verify: "" },
              stepIndex: stepsTotal,
              stepsTotal,
              frozenFiles: ctx.frozenFiles,
              feedback,
            })
          : buildReviewFixPrompt(ctx.task, verdict.blockers, ctx.frozenFiles),
      commitMessage: `implloop: review fixes (round ${round})`,
    });
    if (fixOutcome.kind === "blocked") {
      return fail({ stopReason: "blocked", blockedReason: fixOutcome.reason });
    }
    if (fixOutcome.kind === "budget") return fail({ stopReason: "session-budget" });
    if (fixOutcome.kind !== "green") {
      return fail({
        stopReason: fixOutcome.kind === "stuck" ? "stuck" : "step-retries",
        finalFeedback: fixOutcome.feedback,
        finalVerdict: verdict,
      });
    }
  }
  return fail({ stopReason: "review-rejected", finalVerdict: lastVerdict });
}
