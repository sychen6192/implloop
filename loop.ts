// Entry point: npx tsx <clone>/loop.ts <task.md> (or bin/implloop).
// Must run from the target repo root (REPO_ROOT = cwd).
import * as fs from "node:fs";
import * as path from "node:path";
import {
  REPO_ROOT,
  TASK_ARG,
  MAX_SESSIONS,
  STEP_RETRIES,
  MAX_STEPS,
  STUCK_REPEATS,
  TEST_FIRST,
  SKIP_REVIEW,
  SKIP_BASELINE,
  RUNS_DIR,
  RUNNER_KIND,
  ROLE_MODELS,
  BRANCH_PREFIX,
} from "./config";
import { banner, log, die } from "./libs/log";
import { assertAgents } from "./libs/guard";
import { getToolVersion } from "./libs/version";
import { detectBuildConfig, runTestGate } from "./gates/build";
import {
  isGitRepo,
  isCleanTree,
  currentBranch,
  headSha,
  createBranch,
  slugify,
  git,
} from "./libs/git";
import { createRunner } from "./runners/runner";
import { orchestrate } from "./orchestrator";
import { OrchestratorResult } from "./libs/types";

function exitCodeFor(r: OrchestratorResult): number {
  if (r.success) return 0;
  if (r.stopReason === "needs-clarification" || r.stopReason === "blocked") return 4;
  return 2;
}

async function main() {
  banner("implloop pipeline 啟動");
  const toolVersion = getToolVersion();
  log(`工具版本：${toolVersion}`);

  if (!TASK_ARG) {
    die(
      "請提供任務規格檔（markdown），例如：\n" +
        "  implloop tasks/add-rate-limit.md\n" +
        "task 檔應描述要實作什麼、驗收條件是什麼。",
    );
  }
  const taskPath = path.resolve(REPO_ROOT, TASK_ARG);
  if (!fs.existsSync(taskPath)) die(`找不到 task 檔：${taskPath}`);
  const task = fs.readFileSync(taskPath, "utf8").trim();
  if (!task) die(`task 檔是空的：${taskPath}`);

  // --- git preflight（git 主權在 pipeline）---
  if (!isGitRepo()) die("目前目錄不是 git repo。implloop 需要 git 來做 checkpoint 與 rollback。");
  if (!isCleanTree()) {
    die(
      "working tree 不乾淨。請先 commit 或 stash 你自己的改動——\n" +
        "implloop 需要乾淨的起點才能安全地 reset 失敗的迭代。",
    );
  }
  const baseBranch = currentBranch();
  const baseSha = headSha();

  const buildCfg = detectBuildConfig();
  if (!buildCfg) {
    die(
      "偵測不到建置/測試方式（pom.xml / build.gradle / package.json(test script) / pytest）。\n" +
        "請以 IL_BUILD_CMD / IL_TEST_CMD 指定。",
    );
  }

  log(`目標 repo：${REPO_ROOT}`);
  log(`基準 branch：${baseBranch}（${baseSha.slice(0, 8)}）`);
  log(`建置設定：${buildCfg.kind}（build=${buildCfg.buildCmd || "（無）"}, test=${buildCfg.testCmd}）`);
  log(
    `模型：planner=${ROLE_MODELS.planner || "（agent 預設）"}, ` +
      `writer=${ROLE_MODELS.writer || "（agent 預設）"}, ` +
      `reviewer=${ROLE_MODELS.reviewer || "（agent 預設）"}`,
  );
  log(
    `參數：MAX_SESSIONS=${MAX_SESSIONS}, STEP_RETRIES=${STEP_RETRIES}, MAX_STEPS=${MAX_STEPS}, ` +
      `STUCK_REPEATS=${STUCK_REPEATS}, test_first=${TEST_FIRST ? "on" : "off"}, ` +
      `review=${SKIP_REVIEW ? "off" : "on"}`,
  );

  if (RUNNER_KIND === "opencode") assertAgents(["planner", "writer", "reviewer"]);

  // Baseline: existing tests must be green, or every later gate result is meaningless.
  if (SKIP_BASELINE) {
    log("[WARN] 已跳過 baseline 測試（IL_SKIP_BASELINE=1）");
  } else {
    log("執行 baseline 測試（起點必須是綠的）…");
    const baseline = runTestGate(buildCfg);
    if (!baseline.passed) {
      die(
        "baseline 測試未通過。起點是紅的，之後所有 gate 都無法歸因。\n" +
          "請先修好既有測試，或確定要硬跑時設 IL_SKIP_BASELINE=1（不建議）。\n\n" +
          baseline.report,
      );
    }
    log("[OK] baseline 綠燈");
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.copyFileSync(taskPath, path.join(runDir, "task.md"));

  const branch = `${BRANCH_PREFIX}${slugify(path.basename(taskPath))}-${runId.slice(0, 10)}`;
  createBranch(branch);
  log(`已開 branch：${branch}`);

  fs.writeFileSync(
    path.join(runDir, "params.json"),
    JSON.stringify(
      {
        task: TASK_ARG,
        branch,
        baseBranch,
        baseSha,
        buildCfg,
        limits: { MAX_SESSIONS, STEP_RETRIES, MAX_STEPS, STUCK_REPEATS },
        testFirst: TEST_FIRST,
        runner: RUNNER_KIND,
        toolVersion,
      },
      null,
      2,
    ),
  );
  log(`artifacts：${runDir}`);

  const runner = await createRunner();
  const result = await orchestrate({ task, runner, buildCfg, runDir, branch, baseSha });

  banner("SUMMARY");
  const reasonLabel: Record<string, string> = {
    "all-green": "全部關卡通過",
    stuck: "停損（同一失敗重複出現）",
    "session-budget": "session 預算用盡",
    "step-retries": "單一步驟重試用盡",
    "review-rejected": "review gate 未通過",
    blocked: "writer 回報 BLOCKED（規格/測試矛盾）",
    "needs-clarification": "規格不清，需要人類回答",
    "plan-invalid": "planner 產不出合法計畫",
  };
  log(
    `結果：${result.success ? "[OK]" : "[FAIL]"} ${reasonLabel[result.stopReason] ?? result.stopReason}` +
      `（steps ${result.stepsCompleted}/${result.stepsTotal}，sessions ${result.sessionsUsed}/${MAX_SESSIONS}）`,
  );
  if (result.clarifications?.length) {
    console.log("需要回答的問題：");
    result.clarifications.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
  }
  if (result.blockedReason) console.log(`BLOCKED 理由：${result.blockedReason}`);
  if (result.finalVerdict && !result.finalVerdict.passed) {
    console.log("review blockers：");
    result.finalVerdict.blockers.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
  }
  if (!result.success && result.finalFeedback) {
    console.log(`最後失敗報告：\n${result.finalFeedback}`);
  }

  // Salvage bookkeeping: no commits → drop the empty branch; any commits → keep it.
  const madeCommits = headSha() !== baseSha;
  if (madeCommits) {
    log(`成果在 branch ${branch}（每個 commit 都通過當下的 gate；基準 branch 未動）。`);
    if (result.success) {
      log(`下一步：檢視 diff 後 squash 開 PR，例如 git diff ${baseBranch}...${branch}`);
    } else {
      log("已完成的步驟保留在 branch 上（salvage）；可續跑或人工接手。");
    }
  } else {
    git(["checkout", baseBranch]);
    git(["branch", "-D", branch], true);
    log("沒有產生任何 commit，已刪除空 branch 並切回原 branch。");
  }

  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify(result, (k, v) => (k === "raw" ? undefined : v), 2),
  );
  log(`artifacts 已寫入：${runDir}`);
  process.exit(exitCodeFor(result));
}

main().catch((e) => die(String(e?.stack ?? e)));
