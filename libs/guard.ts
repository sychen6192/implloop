// Startup guard: assert the agent permission contract at launch.
// Docs drift, this doesn't — it fails instantly if the writer gets bash or a read-only
// role (planner/reviewer) can write.
// Resolution order: target repo .opencode/agent/ first, then the global opencode dir.
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, GLOBAL_OPENCODE_DIR, SKIP_GUARD } from "../config";
import { AgentRole } from "./types";
import { die, log } from "./log";

export type ContractRule = readonly [string, "true" | "false"];

const READ_ONLY_RULES: readonly ContractRule[] = [
  ["write", "false"],
  ["edit", "false"],
  ["bash", "false"],
];

export const ROLE_RULES: Record<AgentRole, readonly ContractRule[]> = {
  // Planner plans, it does not touch the tree.
  planner: READ_ONLY_RULES,
  // Writer edits code; verification stays in the loop (no bash).
  writer: [
    ["write", "true"],
    ["edit", "true"],
    ["bash", "false"],
  ],
  // Reviewer is fully read-only — a checker that can edit "fixes it and passes it".
  reviewer: READ_ONLY_RULES,
};

export function resolveAgentPath(
  name: string,
  repoRoot: string,
  globalDir: string,
): { path: string; source: "repo" | "global" } | null {
  const repoPath = path.join(repoRoot, ".opencode", "agent", `${name}.md`);
  if (fs.existsSync(repoPath)) return { path: repoPath, source: "repo" };
  const globalPath = path.join(globalDir, "agent", `${name}.md`);
  if (fs.existsSync(globalPath)) return { path: globalPath, source: "global" };
  return null;
}

// Contract violations for one agent file; empty array = compliant.
export function contractViolations(filePath: string, rules: readonly ContractRule[]): string[] {
  if (!fs.existsSync(filePath)) return [`缺少 agent 定義：${filePath}`];
  const t = fs.readFileSync(filePath, "utf8");
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [`${filePath} 缺少 frontmatter（--- ... ---）`];
  const fm = m[1];
  const errs: string[] = [];
  for (const [key, value] of rules) {
    if (!new RegExp(`${key}:\\s*${value}\\b`).test(fm)) {
      errs.push(
        `${path.basename(filePath)} 必須明確設定 tools.${key}: ${value}（架構契約，見 PROPOSAL.md）`,
      );
    }
  }
  return errs;
}

export function assertAgents(roles: readonly AgentRole[]) {
  if (SKIP_GUARD) {
    log("[WARN] 已跳過 agent 權限 guard（IL_SKIP_GUARD=1）");
    return;
  }
  for (const role of roles) {
    const name = `impl-${role}`;
    const res = resolveAgentPath(name, REPO_ROOT, GLOBAL_OPENCODE_DIR);
    if (!res) {
      die(
        `找不到 agent 定義 ${name}.md（目標 repo .opencode/agent/ 與 global 皆無）。` +
          `請先在工具 clone 目錄執行 npm run setup`,
      );
    }
    const errs = contractViolations(res.path, ROLE_RULES[role]);
    if (errs.length) die(errs.join("\n"));
    log(`[OK] agent ${name}：${res.source}（${res.path}）`);
  }
  log("[OK] agent 權限 guard 通過（writer 無 bash / planner・reviewer 唯讀）");
}
