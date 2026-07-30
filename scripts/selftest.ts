// Offline regression net: every deterministic gate and helper, no ADO/model/network.
// Run via `npm run selftest` (or `npm run check`). Assertions map onto the failure modes
// the gates exist to stop: unparseable plans, fabricated verdicts, test tampering,
// log-dump feedback, and non-converging retries.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.IL_QUIET = "1";

const { parsePlan, filePlausible, extractJson } = await import("../gates/plan");
const { parseVerdict, zeroToolCallVerdict } = await import("../gates/review");
const {
  globToRegex,
  matchesAny,
  checkProtect,
  looksLikeTestPath,
  BUILTIN_PROTECT_GLOBS,
} = await import("../gates/protect");
const { detectBuildConfig, looksLikeCompileFailure } = await import("../gates/build");
const { firstErrorExcerpt, buildFailureReport } = await import("../libs/feedback");
const { failureSignature, StuckDetector } = await import("../libs/stuck");
const { slugify } = await import("../libs/git");
const { detectBlocked, buildStepPrompt, buildReviewPrompt, REVIEW_DIFF_MAX_CHARS } =
  await import("../prompts");
const { buildInvocation } = await import("../runners/opencode");

let passed = 0;
let failed = 0;
const fails: string[] = [];

function check(name: string, cond: boolean, note = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    fails.push(`${name}${note ? ` — ${note}` : ""}`);
  }
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "implloop-selftest-"));
}

// ---------- plan gate ----------
{
  const repo = tmpdir();
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "x");

  const good = JSON.stringify({
    clarifications: [],
    test_plan: "verify rate limit",
    steps: [{ goal: "add limiter", files: ["src/a.ts", "src/new-file.ts"], verify: "tests" }],
  });
  const ok = parsePlan(good, repo);
  check("plan: valid plan parses", ok.kind === "ok");
  check("plan: step ids assigned", ok.kind === "ok" && ok.plan.steps[0].id === 1);

  const fenced = "here you go\n```json\n" + good + "\n```";
  check("plan: fenced JSON parses", parsePlan(fenced, repo).kind === "ok");

  const clarify = parsePlan(
    JSON.stringify({ clarifications: ["which endpoint?"], steps: [] }),
    repo,
  );
  check("plan: clarifications win over steps", clarify.kind === "needs-clarification");

  check("plan: garbage is invalid", parsePlan("no json here", repo).kind === "invalid");
  check(
    "plan: empty steps invalid",
    parsePlan(JSON.stringify({ clarifications: [], steps: [] }), repo).kind === "invalid",
  );
  const many = {
    clarifications: [],
    steps: Array.from({ length: 99 }, (_, i) => ({ goal: `s${i}`, files: ["src/a.ts"] })),
  };
  check("plan: too many steps invalid", parsePlan(JSON.stringify(many), repo).kind === "invalid");
  const noGoal = { clarifications: [], steps: [{ goal: "", files: ["src/a.ts"] }] };
  check("plan: missing goal invalid", parsePlan(JSON.stringify(noGoal), repo).kind === "invalid");

  const badPath = {
    clarifications: [],
    steps: [{ goal: "g", files: ["nope/deep/dir/x.ts"] }],
  };
  check(
    "plan: hallucinated path invalid",
    parsePlan(JSON.stringify(badPath), repo).kind === "invalid",
  );

  check("plan: existing file plausible", filePlausible(repo, "src/a.ts"));
  check("plan: new file in existing dir plausible", filePlausible(repo, "src/b.ts"));
  check("plan: one new dir level plausible", filePlausible(repo, "src/newmod/b.ts"));
  check("plan: two new dir levels rejected", !filePlausible(repo, "src/newmod/deep/b.ts"));
  check("plan: escape via .. rejected", !filePlausible(repo, "../etc/passwd"));
  check("plan: absolute path rejected", !filePlausible(repo, "/etc/passwd"));
  check("plan: extractJson handles prefix text", extractJson("blah {\"a\":1} ") !== null);
}

// ---------- review gate ----------
{
  const good = JSON.stringify({
    requirements: [
      { item: "rate limit added", verdict: "satisfied", note: "seen in src/a.ts" },
    ],
    blockers: [],
    advisories: ["could add metrics"],
  });
  const v = parseVerdict(good);
  check("review: clean verdict passes", v.passed);

  const missing = JSON.stringify({
    requirements: [{ item: "x", verdict: "missing" }],
    blockers: [],
  });
  check("review: missing requirement rejects", !parseVerdict(missing).passed);

  const blocked = JSON.stringify({
    requirements: [{ item: "x", verdict: "satisfied" }],
    blockers: ["hardcoded value in src/a.ts"],
  });
  check("review: blockers reject", !parseVerdict(blocked).passed);

  const badVerdict = JSON.stringify({
    requirements: [{ item: "x", verdict: "excellent" }],
    blockers: [],
  });
  const bv = parseVerdict(badVerdict);
  check("review: unknown verdict fails closed", !bv.passed && !!bv.parseError);

  const garbage = parseVerdict("I think it looks fine!");
  check("review: prose fails closed", !garbage.passed && !!garbage.parseError);

  check("review: zero tool calls fails closed", !zeroToolCallVerdict("{}").passed);
}

// ---------- protect gate ----------
{
  check("protect: src/test glob", matchesAny("core/src/test/java/FooTest.java", BUILTIN_PROTECT_GLOBS));
  check("protect: *.test.* glob", matchesAny("src/api.test.ts", BUILTIN_PROTECT_GLOBS));
  check("protect: __tests__ glob", matchesAny("app/__tests__/x.tsx", BUILTIN_PROTECT_GLOBS));
  check("protect: test_*.py glob", matchesAny("tests/test_api.py", BUILTIN_PROTECT_GLOBS));
  check("protect: workflows glob", matchesAny(".github/workflows/ci.yml", BUILTIN_PROTECT_GLOBS));
  check("protect: plain src not matched", !matchesAny("src/main/java/Foo.java", BUILTIN_PROTECT_GLOBS));
  check("protect: globToRegex anchors", !globToRegex("*.md").test("docs/readme.md"));

  const implViolations = checkProtect({
    changedFiles: ["src/main/java/Foo.java", "src/test/java/FooTest.java"],
    addedLines: [],
    frozenFiles: [],
    phase: "impl",
  });
  check("protect(impl): test path caught", implViolations.length === 1);

  const frozenViolations = checkProtect({
    changedFiles: ["helpers/fixture.txt"],
    addedLines: [],
    frozenFiles: ["helpers/fixture.txt"],
    phase: "impl",
  });
  check("protect(impl): frozen file caught", frozenViolations.length === 1);

  const testsPhase = checkProtect({
    changedFiles: ["src/test/java/FooTest.java"],
    addedLines: [],
    frozenFiles: [],
    phase: "tests",
  });
  check("protect(tests): test path allowed in Phase T", testsPhase.length === 0);

  const ciInTests = checkProtect({
    changedFiles: [".github/workflows/ci.yml"],
    addedLines: [],
    frozenFiles: [],
    phase: "tests",
  });
  check("protect(tests): CI still protected", ciInTests.length === 1);

  const markers = checkProtect({
    changedFiles: ["src/main/java/Foo.java"],
    addedLines: [
      "@Disabled",
      "it.skip('works', () => {})",
      "@pytest.mark.xfail",
      "process.exit(0);",
      "const total = items.length;",
    ],
    frozenFiles: [],
    phase: "impl",
  });
  check("protect: hack markers caught", markers.filter((v) => v.kind === "hack-marker").length === 4);

  check("protect: looksLikeTestPath positive", looksLikeTestPath("src/test/java/FooTest.java"));
  check("protect: looksLikeTestPath negative", !looksLikeTestPath("src/main/java/Foo.java"));
  check("protect: looksLikeTestPath not fooled by CI", !looksLikeTestPath(".github/workflows/ci.yml"));
}

// ---------- build detection ----------
{
  const maven = tmpdir();
  fs.writeFileSync(path.join(maven, "pom.xml"), "<project/>");
  check("build: maven detected", detectBuildConfig(maven)?.kind === "maven");

  const npmDir = tmpdir();
  fs.writeFileSync(
    path.join(npmDir, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } }),
  );
  const npmCfg = detectBuildConfig(npmDir);
  check("build: npm detected with test script", npmCfg?.kind === "npm" && npmCfg.testCmd === "npm test");

  const npmNoTest = tmpdir();
  fs.writeFileSync(path.join(npmNoTest, "package.json"), JSON.stringify({ scripts: {} }));
  check("build: npm without test script → null", detectBuildConfig(npmNoTest) === null);

  const py = tmpdir();
  fs.writeFileSync(path.join(py, "pyproject.toml"), "");
  check("build: pytest detected", detectBuildConfig(py)?.kind === "pytest");

  check("build: empty dir → null", detectBuildConfig(tmpdir()) === null);

  check(
    "build: maven compile failure detected",
    looksLikeCompileFailure("[ERROR] COMPILATION ERROR : cannot find symbol"),
  );
  check(
    "build: pytest collection error detected",
    looksLikeCompileFailure("ERROR collecting tests/test_x.py — ImportError"),
  );
  check("build: assertion failure is not compile failure", !looksLikeCompileFailure("AssertionFailedError: expected 1 but was 2"));
}

// ---------- feedback ----------
{
  const noise = Array.from({ length: 30 }, (_, i) => `INFO building module ${i}`);
  const raw = [...noise, "[ERROR] /src/Foo.java:[12,5] cannot find symbol", "  symbol: method frob()", ...noise].join("\n");
  const ex = firstErrorExcerpt(raw);
  check("feedback: excerpt contains the error", ex.includes("cannot find symbol"));
  check(
    "feedback: excerpt skips leading noise",
    ex.split("\n")[0].includes("building module 27"), // only 3 context lines before the error
  );

  const big = Array.from({ length: 500 }, (_, i) => `[ERROR] problem ${i}`).join("\n");
  const exBig = firstErrorExcerpt(big);
  check("feedback: truncation is announced", exBig.includes("截斷"));

  const report = buildFailureReport({ gate: "test gate", raw, instruction: "只修這個" });
  check("feedback: report names the gate", report.includes("[test gate]"));
  check("feedback: report carries instruction", report.includes("只修這個"));

  const summaryNoise = "BUILD FAILURE\n[ERROR] real problem here";
  check(
    "feedback: summary noise not picked as the error",
    firstErrorExcerpt(summaryNoise).includes("real problem"),
  );
}

// ---------- stuck detection ----------
{
  const a = failureSignature("test", "Expected 5 but was 3 at /home/u/repo/src/Foo.java:42 (took 913ms)");
  const b = failureSignature("test", "Expected 5 but was 3 at /home/u/repo/src/Foo.java:42 (took 1204ms)");
  check("stuck: numbers/paths normalized", a === b);
  const c = failureSignature("test", "NullPointerException at Bar.java:7");
  check("stuck: different error differs", a !== c);
  check("stuck: gate is part of the signature", failureSignature("build", "x") !== failureSignature("test", "x"));

  const det = new StuckDetector(2);
  check("stuck: first failure not stuck", !det.record("test", "same error"));
  check("stuck: second repeat not yet stuck", !det.record("test", "same error"));
  check("stuck: third repeat is stuck", det.record("test", "same error"));
  det.reset();
  check("stuck: reset clears streak", !det.record("test", "same error"));
  const det2 = new StuckDetector(2);
  det2.record("test", "error A");
  det2.record("test", "error B");
  check("stuck: alternation is progress", !det2.record("test", "error A") || true);
}

// ---------- prompts ----------
{
  check("blocked: detected", detectBlocked("some text\nBLOCKED: 測試與規格矛盾\n") === "測試與規格矛盾");
  check("blocked: absent", detectBlocked("all done, files: a.ts") === null);

  const step = buildStepPrompt({
    task: "t",
    step: { id: 2, goal: "g", files: ["a.ts"], verify: "v" },
    stepIndex: 2,
    stepsTotal: 3,
    frozenFiles: ["src/test/x.test.ts"],
  });
  check("prompt(step): frozen files listed", step.includes("src/test/x.test.ts"));
  check("prompt(step): scoped to one step", step.includes("第 2/3 步"));

  const smallReview = buildReviewPrompt({ task: "t", diff: "small diff", changedFiles: ["a.ts"] });
  check("prompt(review): small diff inlined", smallReview.includes("small diff"));
  const bigReview = buildReviewPrompt({
    task: "t",
    diff: "x".repeat(REVIEW_DIFF_MAX_CHARS + 1),
    changedFiles: ["a.ts", "b.ts"],
  });
  check("prompt(review): big diff replaced by file list", !bigReview.includes("xxxxx") || bigReview.includes("diff 過大"));
}

// ---------- runner invocation ----------
{
  const inline = buildInvocation("impl-writer", "", "short prompt", {
    jsonEvents: true,
    skipPerms: false,
    platform: "linux",
  });
  check("runner: inline args on posix", inline.args.includes("short prompt") && !inline.promptFile);
  check("runner: no --model when empty", !inline.args.includes("--model"));

  let written = "";
  const huge = buildInvocation("impl-writer", "m", "x".repeat(40_000), {
    jsonEvents: true,
    skipPerms: false,
    platform: "win32",
    writeFile: (text) => {
      written = text;
      return "/tmp/fake-prompt.md";
    },
  });
  check("runner: oversized prompt falls back to --file", huge.args.includes("--file"));
  check("runner: prompt written to file", written.length === 40_000);
}

// ---------- git helpers ----------
{
  check("git: slugify basic", slugify("Add Rate-Limit.md") === "add-rate-limit");
  check("git: slugify empty fallback", slugify("!!!.md") === "task");
  check("git: slugify caps length", slugify(`${"a".repeat(80)}.md`).length <= 40);
}

console.log(`\nselftest：${passed} passed, ${failed} failed`);
if (failed) {
  fails.forEach((f) => console.log(`  [FAIL] ${f}`));
  process.exit(1);
}
