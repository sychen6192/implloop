// Failure-report assembly: the pipeline composes feedback, never dumps raw logs.
// Evidence (PROPOSAL §5.3): one error group at a time, error text first, aggressive
// non-silent truncation — raw compiler dumps underperform even a template message.

const ERROR_LINE =
  /\b(error|failed|failure|exception|assert(ion)?)\b|^E\s|\[ERROR\]|✗|✖|FAIL/i;
// Lines that mention failure but are summary/noise, not the error itself.
const NOISE_LINE = /BUILD FAILURE|BUILD FAILED|For more information|Re-run|npm ERR! A complete log/i;

export const MAX_EXCERPT_LINES = 60;
export const MAX_EXCERPT_CHARS = 4000;

// Extract the first error group: from the first error-looking line, take a window of
// context until the excerpt budget runs out. Falls back to the tail when nothing matches.
export function firstErrorExcerpt(raw: string): string {
  const lines = raw.split(/\r?\n/);
  let start = lines.findIndex((l) => ERROR_LINE.test(l) && !NOISE_LINE.test(l));
  if (start < 0) start = Math.max(0, lines.length - MAX_EXCERPT_LINES);
  // A few lines of leading context help locate the error source.
  const from = Math.max(0, start - 3);
  const window = lines.slice(from, from + MAX_EXCERPT_LINES);
  let text = window.join("\n");
  if (text.length > MAX_EXCERPT_CHARS) text = text.slice(0, MAX_EXCERPT_CHARS);
  const omitted = lines.length - (from + window.length);
  if (omitted > 0) text += `\n…（截斷：後面還有 ${omitted} 行，先修上面這一組錯誤）`;
  return text;
}

export interface FeedbackInput {
  gate: string;
  raw: string;
  // Optional extra instruction appended after the excerpt (e.g. "只修測試碼").
  instruction?: string;
}

export function buildFailureReport(input: FeedbackInput): string {
  const parts = [
    `[${input.gate}] 未通過。以下是第一組錯誤（一次只修這一組）：`,
    "",
    firstErrorExcerpt(input.raw),
  ];
  if (input.instruction) parts.push("", input.instruction);
  return parts.join("\n");
}
