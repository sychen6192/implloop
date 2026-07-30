// Review gate: read-only cross-model reviewer, single turn, fail-closed parsing,
// must-read enforcement (a verdict with zero tool calls = fabricated; observed in testgen).
// Pass = blockers empty AND no requirement judged missing/misunderstood.
import {
  AgentRunOutput,
  REQ_VERDICTS,
  RequirementJudgement,
  ReqVerdict,
  ReviewVerdict,
} from "../libs/types";
import { REVIEWER_MUST_READ } from "../config";
import { extractJson } from "./plan";
import { tail } from "../libs/log";

export function parseVerdict(raw: string): ReviewVerdict {
  const failed = (why: string): ReviewVerdict => ({
    passed: false,
    requirements: [],
    blockers: [
      `Reviewer 輸出無法解析（${why}），依 fail-closed 原則判 REJECT。` +
        `請重新輸出符合 schema 的單一 JSON 物件。原文節錄：${tail(raw, 800)}`,
    ],
    advisories: [],
    parseError: why,
    raw,
  });

  const obj = extractJson(raw);
  if (obj === null || typeof obj !== "object") return failed("找不到 JSON 物件");
  const o = obj as Record<string, unknown>;

  if (!Array.isArray(o.requirements)) return failed("缺 requirements 陣列");
  const requirements: RequirementJudgement[] = [];
  for (let i = 0; i < o.requirements.length; i++) {
    const r = o.requirements[i] as Record<string, unknown>;
    const item = String(r.item ?? "").trim();
    const verdict = String(r.verdict ?? "") as ReqVerdict;
    if (!item) return failed(`requirements[${i}] 缺 item`);
    if (!REQ_VERDICTS.includes(verdict)) {
      return failed(`requirements[${i}] verdict 不合法：${String(r.verdict)}`);
    }
    requirements.push({
      item,
      verdict,
      note: r.note !== undefined ? String(r.note) : undefined,
    });
  }

  if (!Array.isArray(o.blockers)) return failed("缺 blockers 陣列");
  const blockers = (o.blockers as unknown[]).map(String).filter((s) => s.trim());
  const advisories = Array.isArray(o.advisories)
    ? (o.advisories as unknown[]).map(String).filter((s) => s.trim())
    : [];

  const unmet = requirements.filter(
    (r) => r.verdict === "missing" || r.verdict === "misunderstood",
  );
  const passed = blockers.length === 0 && unmet.length === 0;
  return { passed, requirements, blockers, advisories, raw };
}

export function zeroToolCallVerdict(raw: string): ReviewVerdict {
  return {
    passed: false,
    requirements: [],
    blockers: [
      "Reviewer 未呼叫任何工具即輸出判決（tool calls = 0），視同未實際讀取程式碼，" +
        "依 fail-closed 原則判 REJECT。請考慮更換 IL_REVIEWER_MODEL；" +
        "確定要放行可設 IL_REVIEWER_MUST_READ=0。",
    ],
    advisories: [],
    parseError: "reviewer 0 tool calls",
    raw,
  };
}

// Judges an already-run reviewer session. The session itself is executed by the
// orchestrator's budgeted session() so budget accounting has exactly one owner.
export function runReviewGate(out: Pick<AgentRunOutput, "text" | "toolCallCount">): ReviewVerdict {
  if (REVIEWER_MUST_READ && out.toolCallCount === 0) return zeroToolCallVerdict(out.text);
  return parseVerdict(out.text);
}
