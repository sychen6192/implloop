// Protect gate (zero LLM): structural denial of gate gaming.
// After Phase T freezes the acceptance tests, any uncommitted diff touching a protected
// path — frozen test files, test-looking paths, CI config — is rejected at exit-code level
// (ImpossibleBench: read-only tests push cheating to near zero). Added lines are also
// scanned for hack markers (skip/xfail/@Disabled/exit(0)).
import * as path from "node:path";
import { EXTRA_PROTECT_GLOBS } from "../config";

// Built-in protected patterns: test trees, test-file conventions, CI config.
export const BUILTIN_PROTECT_GLOBS: readonly string[] = [
  "**/src/test/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/test_*.py",
  "**/*_test.py",
  "**/*_test.go",
  "**/conftest.py",
  ".github/workflows/**",
  "azure-pipelines*.yml",
  "Jenkinsfile",
];

// Minimal glob→regex: ** = any depth, * = within one segment. Enough for the patterns
// above; not a general glob engine on purpose.
export function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more whole segments; bare "**" matches anything
        if (glob[i + 2] === "/") {
          re += "(?:[^/]+/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (".+?^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(file: string, globs: readonly string[]): boolean {
  const norm = file.replace(/\\/g, "/");
  return globs.some((g) => globToRegex(g).test(norm));
}

// Hack markers on ADDED lines only (a pre-existing skip is not the writer's doing).
export const HACK_MARKERS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /@Disabled|@Ignore\b/, label: "以 @Disabled/@Ignore 停用測試" },
  { re: /\.skip\s*\(|\bit\.skip|\bdescribe\.skip|\btest\.skip/, label: "以 .skip 跳過測試" },
  { re: /@pytest\.mark\.(skip|xfail)|unittest\.skip/, label: "以 skip/xfail 跳過測試" },
  { re: /\b(sys|process)\.exit\s*\(\s*0\s*\)/, label: "以 exit(0) 偽造成功" },
];

export interface ProtectViolation {
  kind: "protected-path" | "hack-marker";
  detail: string;
}

// CI config stays protected in every phase; test paths only once tests are frozen.
const CI_GLOBS = BUILTIN_PROTECT_GLOBS.slice(8);

export function checkProtect(input: {
  changedFiles: string[];
  addedLines: string[];
  frozenFiles: readonly string[];
  // "tests" = Phase T (the writer is SUPPOSED to create test files; only CI config and
  // hack markers are checked). "impl" = Phase I (full protection).
  phase: "tests" | "impl";
}): ProtectViolation[] {
  const globs =
    input.phase === "tests" ? CI_GLOBS : [...BUILTIN_PROTECT_GLOBS, ...EXTRA_PROTECT_GLOBS];
  const violations: ProtectViolation[] = [];

  const frozen = new Set(input.frozenFiles.map((f) => f.replace(/\\/g, "/")));
  for (const f of input.changedFiles) {
    const norm = f.replace(/\\/g, "/");
    if (frozen.has(norm)) {
      violations.push({ kind: "protected-path", detail: `修改了已凍結的驗收測試：${f}` });
    } else if (matchesAny(norm, globs)) {
      violations.push({ kind: "protected-path", detail: `修改了保護路徑：${f}` });
    }
  }

  for (const line of input.addedLines) {
    for (const m of HACK_MARKERS) {
      if (m.re.test(line)) {
        violations.push({
          kind: "hack-marker",
          detail: `${m.label}：${line.trim().slice(0, 120)}`,
        });
        break;
      }
    }
  }
  return violations;
}

export function violationReport(violations: ProtectViolation[]): string {
  const lines = [
    "protect gate 攔截：以下改動違反硬性規則，本輪改動已全部還原。",
    "驗收測試與保護路徑不可修改；也不可用 skip/停用/exit(0) 讓測試「看起來」通過。",
    "若你認為測試本身與規格矛盾，請回覆 BLOCKED: <理由>，不要繞過測試。",
    "",
  ];
  violations.forEach((v, i) => lines.push(`${i + 1}. ${v.detail}`));
  return lines.join("\n");
}

// Test-path heuristic used by Phase T to freeze exactly what the test writer created.
export function looksLikeTestPath(file: string): boolean {
  return matchesAny(file.replace(/\\/g, "/"), BUILTIN_PROTECT_GLOBS.slice(0, 8));
}

export function normalizeRel(repoRoot: string, p: string): string {
  return path.relative(repoRoot, path.resolve(repoRoot, p)).replace(/\\/g, "/");
}
