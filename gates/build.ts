// Build & test gates: the pipeline actually runs the commands and reads exit codes.
// The model never gets to claim "tests pass" — done is a shell exit code (goose
// retry.checks pattern; testgen principle 2).
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { GateResult } from "../libs/types";
import { buildFailureReport } from "../libs/feedback";
import { DETACH_CHILDREN, killTree, trackForShutdown } from "../libs/shell";
import { BUILD_CMD, TEST_CMD, GATE_TIMEOUT_MS, REPO_ROOT } from "../config";

export interface BuildConfig {
  kind: "maven" | "gradle" | "npm" | "pytest" | "custom";
  buildCmd: string; // "" = no separate build step (test cmd compiles too)
  testCmd: string;
}

export function detectBuildConfig(repoRoot: string = REPO_ROOT): BuildConfig | null {
  if (BUILD_CMD || TEST_CMD) {
    if (!TEST_CMD) {
      // A build command alone would silently become the test command too, removing the
      // test gate entirely — the one gate the whole design leans on.
      console.error("FATAL: IL_BUILD_CMD 已設定但缺 IL_TEST_CMD——test gate 不能沒有測試指令");
      process.exit(1);
    }
    return { kind: "custom", buildCmd: BUILD_CMD, testCmd: TEST_CMD };
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
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    } catch {
      return null; // malformed package.json = undetectable, same as no build file
    }
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
// Async spawn (not spawnSync) so a timeout can kill the whole process tree — spawnSync's
// built-in timeout signals only the shell, and a mvn/gradle grandchild survives it.
export function runCommand(cmd: string, cwd: string = REPO_ROOT): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      env: process.env,
      detached: DETACH_CHILDREN,
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackForShutdown(child);

    let out = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.stderr.on("data", (c: string) => (out += c));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGKILL");
    }, GATE_TIMEOUT_MS);

    let spawnErr: string | undefined;
    child.on("error", (e) => (spawnErr = e.message));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !spawnErr && !timedOut,
        output: spawnErr && !out.trim() ? spawnErr : out.trim(),
        timedOut,
      });
    });
  });
}

// A red test run caused by code that doesn't COMPILE must not satisfy the fail-to-pass
// gate (maven/gradle only compile test sources inside the test task).
const COMPILE_FAILURE =
  /COMPILATION ERROR|Compilation failed|error: cannot find symbol|error TS\d+|SyntaxError|ImportError|ERROR collecting|cannot compile/i;

export function looksLikeCompileFailure(raw: string): boolean {
  return COMPILE_FAILURE.test(raw);
}

export async function runBuildGate(cfg: BuildConfig): Promise<GateResult> {
  if (!cfg.buildCmd) return { passed: true, report: "（無獨立 build 步驟，直接進測試）" };
  const r = await runCommand(cfg.buildCmd);
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

export async function runTestGate(cfg: BuildConfig): Promise<GateResult> {
  const r = await runCommand(cfg.testCmd);
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
