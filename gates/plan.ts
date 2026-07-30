// Plan gate: fail-closed parse + deterministic structure validation.
// Any parse failure, missing field, oversized plan, or implausible file path returns
// kind:"invalid" with a reason (fed back for a bounded planner retry), never throws.
// Non-empty clarifications → kind:"needs-clarification" (exit 4 — ask a human, don't guess).
import * as fs from "node:fs";
import * as path from "node:path";
import { Plan, PlanOutcome, PlanStep } from "../libs/types";
import { MAX_STEPS } from "../config";

export function extractJson(raw: string): unknown | null {
  const cleaned = raw.replace(/```json|```/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// A referenced file must exist, or be a plausible new file: its parent dir exists, or at
// most ONE new directory level is being introduced (src/newmodule/x.ts is a legitimate
// plan; nope/deep/dir/x.ts is a hallucinated tree). Deterministic hallucination check.
export function filePlausible(repoRoot: string, rel: string): boolean {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return false;
  const abs = path.join(repoRoot, rel);
  if (fs.existsSync(abs)) return true;
  const parent = path.dirname(abs);
  if (fs.existsSync(parent)) return true;
  return fs.existsSync(path.dirname(parent));
}

export function parsePlan(
  raw: string,
  repoRoot: string,
  maxSteps: number = MAX_STEPS,
): PlanOutcome {
  const invalid = (reason: string): PlanOutcome => ({ kind: "invalid", reason, raw });

  const obj = extractJson(raw);
  if (obj === null || typeof obj !== "object") {
    return invalid("找不到可解析的單一 JSON 物件");
  }
  const o = obj as Record<string, unknown>;

  const clarifications = Array.isArray(o.clarifications)
    ? (o.clarifications as unknown[]).map(String).filter((s) => s.trim())
    : [];
  if (clarifications.length > 0) {
    return { kind: "needs-clarification", questions: clarifications, raw };
  }

  if (!Array.isArray(o.steps) || o.steps.length === 0) return invalid("缺 steps 陣列或為空");
  if (o.steps.length > maxSteps) {
    return invalid(
      `steps 有 ${o.steps.length} 個，超過上限 ${maxSteps}。請合併或縮小任務範圍，` +
        "每步驟仍須小而可獨立驗證。",
    );
  }

  const steps: PlanStep[] = [];
  for (let i = 0; i < o.steps.length; i++) {
    const s = o.steps[i] as Record<string, unknown>;
    const goal = String(s.goal ?? "").trim();
    if (!goal) return invalid(`步驟 ${i + 1} 缺 goal`);
    if (!Array.isArray(s.files) || s.files.length === 0) {
      return invalid(`步驟 ${i + 1}（${goal}）缺 files 陣列`);
    }
    const files = (s.files as unknown[]).map(String);
    for (const f of files) {
      if (!filePlausible(repoRoot, f)) {
        return invalid(
          `步驟 ${i + 1} 引用的路徑不存在也不像合理的新檔案：${f}。` +
            "路徑必須是實際讀過或以 glob/grep 確認過的 repo 相對路徑。",
        );
      }
    }
    steps.push({ id: i + 1, goal, files, verify: String(s.verify ?? "").trim() });
  }

  const plan: Plan = {
    clarifications: [],
    testPlan: String(o.test_plan ?? "").trim(),
    steps,
  };
  return { kind: "ok", plan, raw };
}
