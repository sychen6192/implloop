// Preflight for the central-clone pipeline. Run from the target repo root.
// Usage: npx tsx <tool>/scripts/doctor.ts [task.md] [--smoke]
// The env default below MUST run before importing ../config (dynamic imports only).
if (!process.env.IL_AGENT_TIMEOUT_MS) process.env.IL_AGENT_TIMEOUT_MS = "60000"; // short --smoke

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const config = await import("../config");
const { resolveAgentPath, contractViolations, ROLE_RULES } = await import("../libs/guard");
const { planSpawn, explainSpawnError } = await import("../libs/shell");
const { detectBuildConfig } = await import("../gates/build");
const gitlib = await import("../libs/git");

type Status = "OK" | "WARN" | "FAIL";
const rows: Array<{ status: Status; name: string; note: string }> = [];
const add = (status: Status, name: string, note = "") => rows.push({ status, name, note });

const args = process.argv.slice(2);
const smoke = args.includes("--smoke");
const taskArg = args.find((a) => !a.startsWith("--"));

// 1. node
const major = Number(process.versions.node.split(".")[0]);
add(major >= 20 ? "OK" : "FAIL", "node >= 20", `目前 ${process.versions.node}`);

// 2. opencode CLI — resolved exactly the way the runner will spawn it.
const verPlan = planSpawn(config.OPENCODE_BIN, ["--version"]);
const ver = spawnSync(verPlan.file, verPlan.args, {
  encoding: "utf8",
  windowsVerbatimArguments: verPlan.windowsVerbatimArguments,
});
if (ver.status === 0) {
  const via = verPlan.file === config.OPENCODE_BIN ? "" : `，實際執行 ${verPlan.file}`;
  add("OK", "opencode CLI", `${ver.stdout.trim()}${via}`);
} else {
  const why = ver.error
    ? explainSpawnError(ver.error as NodeJS.ErrnoException, config.OPENCODE_BIN)
    : `找不到 ${config.OPENCODE_BIN}`;
  add("FAIL", "opencode CLI", `${why}——安裝 opencode 或設 IL_OPENCODE_BIN`);
}

// 3. agents (repo-local wins, global fallback)
for (const role of ["planner", "writer", "reviewer"] as const) {
  const name = `impl-${role}`;
  const res = resolveAgentPath(name, config.REPO_ROOT, config.GLOBAL_OPENCODE_DIR);
  if (!res) add("FAIL", `agent ${name}`, "repo 與 global 皆無——在工具 clone 執行 npm run setup");
  else {
    const errs = contractViolations(res.path, ROLE_RULES[role]);
    if (errs.length) add("FAIL", `agent ${name}`, errs.join("；"));
    else add("OK", `agent ${name}`, `${res.source}：${res.path}`);
  }
}

// 4. target repo: git + clean tree
const isToolItself =
  fs.existsSync(path.join(config.REPO_ROOT, "orchestrator.ts")) &&
  fs.existsSync(path.join(config.REPO_ROOT, "scripts", "doctor.ts"));
if (isToolItself) {
  add("WARN", "目標 repo（cwd）", "目前在工具 clone 內——到目標 repo 根再跑一次以檢查 repo 項目");
} else if (!gitlib.isGitRepo()) {
  add("FAIL", "git repo", "cwd 不是 git repo——implloop 需要 git 做 checkpoint/rollback");
} else {
  add("OK", "git repo", gitlib.currentBranch());
  add(
    gitlib.isCleanTree() ? "OK" : "FAIL",
    "clean working tree",
    gitlib.isCleanTree() ? "" : "有未 commit 的改動——先 commit 或 stash",
  );
}

// 5. build/test detection
if (!isToolItself) {
  const cfg = detectBuildConfig();
  if (cfg) {
    add("OK", "build/test 偵測", `${cfg.kind}（test=${cfg.testCmd}）`);
  } else {
    add("FAIL", "build/test 偵測", "偵測不到——設 IL_BUILD_CMD / IL_TEST_CMD");
  }
}

// 6. task file
if (taskArg) {
  const p = path.resolve(config.REPO_ROOT, taskArg);
  if (!fs.existsSync(p)) add("FAIL", "task 檔", `不存在：${p}`);
  else if (!fs.readFileSync(p, "utf8").trim()) add("FAIL", "task 檔", "是空的");
  else add("OK", "task 檔", p);
} else {
  add("WARN", "task 檔", "未提供——帶上 <task.md> 可一併檢查");
}

// 7. --smoke: one read-only planner ping via AgentRunner
if (smoke) {
  const { createRunner } = await import("../runners/runner");
  try {
    const runner = await createRunner();
    const out = await runner.run("planner", "這是連線測試，請只回覆：OK");
    const txt = out.text.trim();
    if (txt) add("OK", "smoke（planner）", txt.slice(0, 60));
    else add("FAIL", "smoke（planner）", "無回應——檢查 provider 設定（opencode auth）與 agent 的 model 欄位");
  } catch (e) {
    add("FAIL", "smoke（planner）", e instanceof Error ? e.message : String(e));
  }
}

console.log("\nimplloop doctor\n");
for (const r of rows) console.log(`  [${r.status}] ${r.name}${r.note ? ` — ${r.note}` : ""}`);
const fails = rows.filter((r) => r.status === "FAIL").length;
console.log(fails ? `\n${fails} 項 FAIL——依提示修復後重跑` : "\n全部通過（WARN 為提示性）");
process.exit(fails ? 1 : 0);
