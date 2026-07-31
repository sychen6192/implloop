// Role prompts. Everything the model needs is injected by the loop (injection over
// discovery); prompts stay short — instruction-following degrades with instruction count
// (IFScale), so each call carries only its phase's rules.
import { MAX_STEPS } from "./config";
import { PlanStep } from "./libs/types";

export const BLOCKED_PREFIX = "BLOCKED:";

// Detect the writer's honest escape hatch (PROPOSAL §5.1: an explicit conflict-report
// channel measurably reduces gate gaming).
// Only the first and last non-empty lines are checked: models put verdicts at the reply's
// edges, while a writer merely ECHOING its instructions (which contain the literal
// "BLOCKED: <理由>") produces a mid-reply match that must not abort the run.
export function detectBlocked(text: string): string | null {
  const lines = text.split("\n").filter((l) => l.trim());
  const edges = lines.length <= 1 ? lines : [lines[0], lines[lines.length - 1]];
  for (const line of edges) {
    const m = line.match(/^\s*BLOCKED:\s*(.+)$/);
    if (m && !m[1].includes("<理由>")) return m[1].trim();
  }
  return null;
}

export function buildPlanPrompt(task: string, fixNote?: string): string {
  const fix = fixNote
    ? `\n上一次的計畫被 pipeline 退回，原因：\n${fixNote}\n請修正後重新輸出。\n`
    : "";
  return `請為以下任務產生實作計畫。先實際讀取相關程式碼再規劃，路徑不可用猜的。
${fix}
<task>
${task}
</task>

規則：
- 步驟至多 ${MAX_STEPS} 個。每一步必須小、可獨立驗證（build+test 可過）、依依賴順序排列。
- 每一步列出會動到的檔案（repo 相對路徑）；新檔案也要列出完整預期路徑。
- test_plan：用一段話描述驗收測試要驗什麼行為（之後會先寫成「會失敗的」測試）。
- 只有在規格真的無法判斷時才填 clarifications（pipeline 會停下來找人）；能從程式碼
  推斷的不要問。

最終回覆必須是單一 JSON 物件，不得包含 markdown 圍欄、前言或任何其他文字。schema：
{"clarifications":["..."],"test_plan":"...","steps":[{"goal":"...","files":["..."],"verify":"..."}]}`;
}

export function buildTestFirstPrompt(task: string, testPlan: string): string {
  return `你的任務：為以下需求撰寫「驗收測試」。只寫測試，不要實作功能本身。

<task>
${task}
</task>

測試計畫（由規劃階段產出）：
${testPlan || "（無，請依 task 自行判斷要驗的行為）"}

規則：
- 先讀既有測試，沿用專案的測試框架與風格；測試檔放在專案慣例位置。
- 這些測試描述的是「尚未實作」的行為，現在執行必須失敗——這是預期的，pipeline 會驗證。
- 不要動 production code、不要執行任何指令。
- 測試要驗具體行為與值，不寫無意義斷言。

完成後以清單列出你建立/修改的檔案。`;
}

export interface StepPromptInput {
  task: string;
  step: PlanStep;
  stepIndex: number;
  stepsTotal: number;
  frozenFiles: readonly string[];
  feedback?: string;
}

export function buildStepPrompt(input: StepPromptInput): string {
  const frozen =
    input.frozenFiles.length > 0
      ? `\n已凍結的驗收測試（絕對不可修改）：\n${input.frozenFiles.map((f) => `- ${f}`).join("\n")}\n`
      : "";
  const feedback = input.feedback
    ? `\n上一輪未通過驗證，失敗報告：\n<gate_report>\n${input.feedback}\n</gate_report>\n請修正上述問題後完成本步驟。\n`
    : "";
  return `你的任務：完成實作計畫的第 ${input.stepIndex}/${input.stepsTotal} 步。只做這一步，不要超前。

<task>
${input.task}
</task>

當前步驟：
- 目標：${input.step.goal}
- 預計動到的檔案：${input.step.files.join("、")}
- 驗證方式：${input.step.verify || "build + 測試全綠"}
${frozen}${feedback}
規則：
- 只修改完成本步驟必要的檔案；不要「順手」重構無關程式碼。
- 不要執行任何建置或測試指令（由外部 pipeline 驗證）。
- 不可修改測試、不可用 skip/停用/exit(0) 讓測試通過。
- 若規格與測試矛盾、或缺少必要的外部資訊，回覆一行「${BLOCKED_PREFIX} <理由>」並停止。

完成後以清單列出你建立/修改的檔案，並各附一句修改摘要。`;
}

export function buildReviewFixPrompt(
  task: string,
  blockers: string[],
  frozenFiles: readonly string[],
  feedback?: string,
): string {
  const frozen =
    frozenFiles.length > 0
      ? `\n已凍結的驗收測試（絕對不可修改）：\n${frozenFiles.map((f) => `- ${f}`).join("\n")}\n`
      : "";
  // Retries keep the blockers in view — a fix attempt that only sees the gate report
  // is being told to fix problems it can no longer read.
  const gate = feedback
    ? `\n上一次修正未通過驗證，失敗報告：\n<gate_report>\n${feedback}\n</gate_report>\n`
    : "";
  return `審查者對目前的實作提出了必須修正的問題。請逐一修正。

<task>
${task}
</task>

Blockers（全部都要修）：
${blockers.map((b, i) => `${i + 1}. ${b}`).join("\n")}
${frozen}${gate}
規則：
- 只修 blockers 指出的問題，不要擴大改動範圍。
- 不要執行任何建置或測試指令；不可修改測試。
- 無法修正時回覆一行「${BLOCKED_PREFIX} <理由>」。

完成後以清單列出你修改的檔案。`;
}

// Diff bigger than this is not inlined — the reviewer gets the file list and reads on
// its own (must-read enforcement guarantees it actually does).
export const REVIEW_DIFF_MAX_CHARS = 30_000;

export interface ReviewPromptInput {
  task: string;
  diff: string;
  changedFiles: string[];
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const diffBlock =
    input.diff.length <= REVIEW_DIFF_MAX_CHARS
      ? `<diff>\n${input.diff}\n</diff>`
      : `（diff 過大未內附。變更檔案如下，請自行讀取比對：）\n${input.changedFiles
          .map((f) => `- ${f}`)
          .join("\n")}`;
  return `請審查以下實作是否滿足任務需求。這是單回合審查：一次到位，不會有追問機會。

<task>
${input.task}
</task>

${diffBlock}

要求：
- 必須實際讀取變更檔案的完整內容（不能只看 diff 片段）再下判決。
- 把 task 拆成一條條需求，逐條給 verdict：
  satisfied（已完成且 diff 中有對應證據）/ missing（完全沒做）/ partial（做了一部分）/
  misunderstood（做了但方向錯誤）/ not-verifiable（無法從程式碼判斷）。
- blockers：必須修正才能交付的具體問題（含檔名與位置）；實作被測試通過所掩蓋的
  硬編碼、特判、殘留 debug 碼也算。每條必須附你實際讀到的證據。
- advisories：建議級改善，不擋關。
- 測試是否通過不在你的職責內（pipeline 的 hard gate 負責），勿推估。

最終回覆必須是單一 JSON 物件，不得包含 markdown 圍欄、前言或任何其他文字。schema：
{"requirements":[{"item":"...","verdict":"satisfied|missing|partial|misunderstood|not-verifiable","note":"..."}],"blockers":["..."],"advisories":["..."]}`;
}
