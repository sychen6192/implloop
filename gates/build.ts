// Build & test gates: the pipeline actually runs the commands and reads exit codes.
// The model never gets to claim "tests pass" — done is a shell exit code (goose
// retry.checks pattern; testgen principle 2).
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { GateResult } from "../libs/types";
import { buildFailureReport } from "../libs/feedback";
import { BUILD_CMD, TEST_CMD, GATE_TIMEOUT_MS, REPO_ROOT } from "../config";

export interface BuildConfig {
  kind: "maven" | "gradle" | "npm" | "pytest" | "custom";
  buildCmd: string; // "" = no separate build step (test cmd compiles too)
  testCmd: string;
}

export function detectBuildConfig(repoRoot: string = REPO_ROOT): BuildConfig | null {
  if (BUILD_CMD || TEST_CMD) {
    return { kind: "custom", buildCmd: BUILD_CMD, testCmd: TEST_CMD || BUILD_CMD };
  }
  const has = (f: string) => fs.existsSync(path.join(repoRoot, f));
  if (has("pom.xml")) {
    return { kind: "maven", buildCmd: "mvn -B -ntp compile", testCmd: "mvn -B -ntp test" };
  }
  if (has("build.gradle") || has("build.gradle.kts")) {
    const wrapper = has("gradlew") ? "./gradlew" : "gradle";
    return { kind: "gradle", buildCmd: `${wrapper} classes`, testCmd: `${wrapper} test` };
  }
  if (has("package.json")) {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const buildCmd = scripts.build ? "npm run build" : "";
    const testCmd = scripts.test ? "npm test" : "";
    if (!testCmd) return null; // no test script = no gate; require IL_TEST_CMD
    return { kind: "npm", buildCmd, testCmd };
  }
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.py") || has("tox.ini")) {
    return { kind: "pytest", buildCmd: "", testCmd: "python -m pytest -x -q" };
  }
  return null;
}

export interface CommandOutcome {
  ok: boolean;
  output: string;
  timedOut: boolean;
}

// Commands come from config/detection (operator-owned, never model-owned), so a shell is
// acceptable here and needed for things like "./gradlew test".
export function runCommand(cmd: string, cwd: string = REPO_ROOT): CommandOutcome {
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: GATE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  const timedOut = r.error?.name === "Error" && /ETIMEDOUT/.test(String(r.error.message ?? ""));
  const output = [r.stdout ?? "", r.stderr ?? ""].join("\n").trim();
  return {
    ok: r.status === 0 && !r.error,
    output: r.error && !output ? String(r.error.message) : output,
    timedOut: timedOut || (r.signal === "SIGTERM" && r.status === null),
  };
}

// A red test run caused by code that doesn't COMPILE must not satisfy the fail-to-pass
// gate (maven/gradle only compile test sources inside the test task).
const COMPILE_FAILURE =
  /COMPILATION ERROR|Compilation failed|error: cannot find symbol|error TS\d+|SyntaxError|ImportError|ERROR collecting|cannot compile/i;

export function looksLikeCompileFailure(raw: string): boolean {
  return COMPILE_FAILURE.test(raw);
}

export function runBuildGate(cfg: BuildConfig): GateResult {
  if (!cfg.buildCmd) return { passed: true, report: "（無獨立 build 步驟，直接進測試）" };
  const r = runCommand(cfg.buildCmd);
  if (r.ok) return { passed: true, report: "build OK", raw: r.output };
  return {
    passed: false,
    raw: r.output,
    report: buildFailureReport({
      gate: r.timedOut ? "build gate（逾時）" : "build gate",
      raw: r.output,
    }),
  };
}

export function runTestGate(cfg: BuildConfig): GateResult {
  const r = runCommand(cfg.testCmd);
  if (r.ok) return { passed: true, report: "tests OK", raw: r.output };
  return {
    passed: false,
    raw: r.output,
    report: buildFailureReport({
      gate: r.timedOut ? "test gate（逾時）" : "test gate",
      raw: r.output,
    }),
  };
}
