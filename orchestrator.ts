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
  totalOutputTokens?: number;
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
): Promise<{ text: string; status: string; toolCallCount?: number } | null> {
  if (ctx.sessionsUsed >= MAX_SESSIONS) return null;
  ctx.sessionsUsed += 1;
  log(`（session ${ctx.sessionsUsed}/${MAX_SESSIONS}）`);
  const out = await ctx.runner.run(role, prompt);
  if (out.outputTokens !== undefined) {
    ctx.totalOutputTokens = (ctx.totalOutputTokens ?? 0) + out.outputTokens;
  }
  return out;
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
    totalOutputTokens: ctx.totalOutputTokens,
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
    if (out.status === "spawn-error") {
      return { stop: result(ctx, { success: false, stopReason: "runner-error" }) };
    }
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

// Test-gate modes. "tolerate-red" is what makes multi-step plans converge under
// test-first: the frozen acceptance tests are red BY CONSTRUCTION until the last step,
// so intermediate steps must not be judged on them. They still require a clean compile
// (a red caused by non-compiling code is never acceptable) — full green is demanded at
// the final step and at every review fix.
export type TestGateMode = "expect-red" | "tolerate-red" | "require-green";

interface GateChainOutcome {
  green: boolean;
  feedback?: string;
  gate?: string;
  raw?: string;
  // true = the working tree was reset (protect violation); writer starts over.
  wasReset?: boolean;
  // tolerate-red only: tests are still failing (expected mid-plan); logged, not gating.
  testsStillRed?: boolean;
}

async function runGateChain(
  ctx: Ctx,
  phase: "tests" | "impl",
  mode: TestGateMode,
): Promise<GateChainOutcome> {
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

  const build = await runBuildGate(ctx.buildCfg);
  if (!build.passed) {
    log("[FAIL] build gate");
    return { green: false, feedback: build.report, gate: "build", raw: build.raw };
  }
  log("[OK] build gate");

  const test = await runTestGate(ctx.buildCfg);

  // Any mode: a red caused by code that doesn't compile is a hard failure.
  if (!test.passed && looksLikeCompileFailure(test.raw ?? "")) {
    log("[FAIL] test gate：編譯失敗");
    return {
      green: false,
      gate: "test-compile",
      feedback: buildFailureReport({
        gate: mode === "expect-red" ? "fail-to-pass gate" : "test gate",
        raw: test.raw ?? "",
        instruction:
          mode === "expect-red"
            ? "測試必須「可編譯且執行後斷言失敗」；請先修正測試碼的編譯錯誤。"
            : "程式碼必須先能編譯。請修正編譯錯誤。",
      }),
      raw: test.raw,
    };
  }

  if (mode === "expect-red") {
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

  if (mode === "tolerate-red" && !test.passed) {
    log("[OK] test gate：仍有紅燈（多步驟計畫進行中，預期；最後一步需全綠）");
    return { green: true, testsStillRed: true, raw: test.raw };
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
  testMode: TestGateMode;
  buildPrompt: (feedback?: string) => string;
  commitMessage: string;
}

type AttemptLoopOutcome =
  | { kind: "green"; changed: string[] }
  | { kind: "blocked"; reason: string }
  | { kind: "budget" }
  | { kind: "runner-error" }
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
    if (out.status === "spawn-error") {
      // The agent never ran — burning retries on an environment failure helps nobody.
      resetHardClean();
      return { kind: "runner-error" };
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
    const chain = await runGateChain(ctx, input.phase, input.testMode);
    if (chain.raw) save(`${chain.gate ?? "test"}.log`, chain.raw);
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
      testMode: "expect-red",
      buildPrompt: () => buildTestFirstPrompt(ctx.task, plan.testPlan),
      commitMessage: "implloop: acceptance tests (red)",
    });
    if (outcome.kind === "green") {
      // Freeze EVERYTHING Phase T committed — acceptance tests at unconventional paths
      // (spec/, tests/acceptance.py, helpers, fixtures) must be frozen too, or Phase I
      // could rewrite them freely. looksLikeTestPath is reporting-only.
      ctx.frozenFiles = outcome.changed;
      const conventional = outcome.changed.filter(looksLikeTestPath).length;
      log(`已凍結驗收測試階段的全部 ${ctx.frozenFiles.length} 檔（其中 ${conventional} 檔符合測試路徑慣例）：`);
      ctx.frozenFiles.forEach((f) => log(`  - ${f}`));
      if (ctx.frozenFiles.length === 0) {
        // Cannot happen when commitAll succeeded, but a run with zero frozen files has
        // no anti-cheat protection at all — refuse to continue on that footing.
        return fail({
          stopReason: "stuck",
          finalFeedback: "Phase T 通過但凍結清單為空，無法保證驗收測試不被改寫，中止。",
        });
      }
    } else if (outcome.kind === "blocked") {
      return fail({ stopReason: "blocked", blockedReason: outcome.reason });
    } else if (outcome.kind === "budget") {
      return fail({ stopReason: "session-budget" });
    } else if (outcome.kind === "runner-error") {
      return fail({ stopReason: "runner-error" });
    } else {
      return fail({ stopReason: outcome.kind === "stuck" ? "stuck" : "step-retries", finalFeedback: outcome.feedback });
    }
  }

  // Phase I
  banner("Phase I：Implement（一步驟一 session）");
  for (const [idx, step] of plan.steps.entries()) {
    log(`── 步驟 ${step.id}/${stepsTotal}：${step.goal}`);
    // Intermediate steps of a test-first plan tolerate red tests (the acceptance tests
    // cannot pass until the feature is complete); the LAST step requires full green.
    // Without test-first there are no expected-red tests, so every step requires green.
    const isLast = idx === plan.steps.length - 1;
    const testMode: TestGateMode =
      TEST_FIRST && ctx.frozenFiles.length > 0 && !isLast ? "tolerate-red" : "require-green";
    const outcome = await writerAttempts(ctx, {
      label: `步驟 ${step.id}`,
      artifactPrefix: `step-${step.id}`,
      phase: "impl",
      testMode,
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
    if (outcome.kind === "runner-error") return fail({ stopReason: "runner-error" });
    return fail({
      stopReason: outcome.kind === "stuck" ? "stuck" : "step-retries",
      finalFeedback: outcome.feedback,
    });
  }

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
    const out = await session(ctx, "reviewer", prompt);
    if (!out) return fail({ stopReason: "session-budget" });
    if (out.status === "spawn-error") return fail({ stopReason: "runner-error" });
    const verdict = runReviewGate(out);
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
      testMode: "require-green",
      // Retries keep the blockers in view — earlier versions swapped to a step prompt on
      // retry and the writer was told to fix blockers it could no longer read.
      buildPrompt: (feedback) =>
        buildReviewFixPrompt(ctx.task, verdict.blockers, ctx.frozenFiles, feedback),
      commitMessage: `implloop: review fixes (round ${round})`,
    });
    if (fixOutcome.kind === "blocked") {
      return fail({ stopReason: "blocked", blockedReason: fixOutcome.reason });
    }
    if (fixOutcome.kind === "budget") return fail({ stopReason: "session-budget" });
    if (fixOutcome.kind === "runner-error") return fail({ stopReason: "runner-error" });
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
