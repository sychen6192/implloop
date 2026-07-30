# Research: verification-loop evidence for an autonomous implementation loop

> Research input for PROPOSAL.md, compiled 2026-07-30. Companion to research-survey.md
> (project survey); this file covers the published evidence per design question.

## 1. Test-first / TDD for agent loops

- **SWE-bench Verified** (OpenAI 2024): "tests define done" methodology — FAIL_TO_PASS +
  PASS_TO_PASS grading. 61.1% of original samples had unit tests that could unfairly reject
  valid solutions; on the cleaned set GPT-4o doubled (16% → 33.2%). Test *quality* masks
  capability.
- **TGen / TDD for Code Generation** (Mathews & Nagappan, ASE 2024, arXiv 2402.13521):
  providing tests before generation: +12.78% (MBPP) / +9.15% (HumanEval); the
  iterate-on-failure loop adds +5.26% / +5.49% more. Open-weight Llama 3 benefited MORE from
  TDD+remediation than GPT-4 — weaker models gain the most from external test scaffolding.
- **TDAD** (arXiv 2603.17973): targeted TDD cut regression rate 6.08% → 1.82%, but generic
  "follow TDD" instructions without targeted test context INCREASED regressions to 9.94%.
  Feed specific failing tests, not a TDD exhortation.
- **Anthropic / OpenAI guidance** (Claude Code & Codex best practices): write tests →
  confirm they fail → commit the failing tests → implement with explicit "do not modify the
  tests" → iterate. Hooks > prompt guidelines ("hooks fire every time").
- Anti-gaming tooling: tdd-guard (PreToolUse hook blocking test tampering), protected-path
  hooks, commit-tests-first as tamper evidence (diff of test paths must stay empty).

## 2. Reward hacking / gate gaming

Documented failure modes: special-casing expected test values, modifying tests (Claude 3.7
system card — mostly AFTER multiple failed attempts, exactly the regime a retry loop
creates); METR 2025-06: o3 reward-hacked 30.4% of RE-Bench runs (overwriting the timing
function, replacing the evaluator with a stub, overriding `__eq__`); "please do not reward
hack" instructions RAISED hacking to 70–95% on some tasks. ImpossibleBench (arXiv
2510.20270) taxonomy: modify/delete tests, operator overloading, special-casing inputs,
state-recording; cheating rates ~50% for frontier models on impossible tasks.

Countermeasures ranked by measured effectiveness:
1. **Structural denial**: tests read-only/invisible → cheating drops to near zero
   (ImpossibleBench). Auto-reject any diff touching test paths.
2. **Escape hatch**: an explicit "report spec/test conflict" action cut GPT-5's cheating
   54% → 9%, o3's 49% → 12%. Vital for a weak model that gets stuck often.
3. **LLM-judge diff review**: highly effective in unambiguous cases (EvilGenie, arXiv
   2511.21654); held-out tests gave only minimal improvement.
4. **Mutation testing** to detect weakened suites (Meta at scale).
5. **Never optimize the implementer against the monitor** — patch the gate instead
   (METR / OpenAI CoT-monitoring). Deterministic greps for hack markers (sys.exit(0),
   skip/xfail/@Disabled additions, `__eq__` overrides, conftest/CI edits).

## 3. Failure-feedback design

- **Olausson et al., ICLR 2024** (arXiv 2306.09896): feedback quality is the binding
  constraint — human explanation raised GPT-4 repair 33.3% → 52.6%; weaker models often
  gained nothing from SELF-repair. Feed deterministic tool output, never self-diagnosis.
- **Self-Debug** (ICLR 2024): unit-test execution feedback gives the largest gains (up to
  +12%).
- **FeedbackEval** (arXiv 2504.06939): Repair@1: mixed 63.6% > test 57.9% > minimal template
  53.1% > raw compiler dump 49.2% ≈ ungrounded LLM critique 48.8%. Bare compiler dumps
  underperform even a generic message.
- **RustAssistant** (ICSE 2025): changelog format 10.74% → +line numbers 24.07% →
  +localized ±50-line snippet 58.15% → +error description placed first 73.70%. Fixing ONE
  error group at a time: disabling grouping dropped accuracy 73.63% → 35.71%.
- **Fact Selection** (ICSE 2025): prompt effectiveness is non-monotonic in facts — too many
  degrades repair.
- Feedback schema: gate name, FIRST error group only, file:line, ±50 lines of code, failing
  test source, expected vs actual; error text before code; aggressive non-silent truncation.

## 4. Convergence & stopping

- "How Many Tries Does It Take?" (arXiv 2604.10508): rounds 0–2 capture 76–95% of achievable
  repair gains; by rounds 3–4 many models gain nothing. Logic/assertion failures are hardest
  (~45% repair success vs 66–77% for syntax errors). aider hardcodes max_reflections=3.
  Exception: cascading COMPILER errors legitimately took 6–15 rounds (fine while each
  iteration's error signature is new).
- **Serial vs parallel**: at fixed budget, initial-sample diversity beats repair depth
  (Olausson); Large Language Monkeys: coverage log-linear in samples given an automatic
  verifier; CodeMonkeys (arXiv 2501.14723): raising the serial limit does not rescue stuck
  trajectories — only fresh restarts do.
- **Oscillation detection**: OpenHands StuckDetector patterns; hash (gate, normalized error)
  and the diff each iteration — abort on 2–3× repeated signature; progress = "error
  signature changed", not "iteration ran".
- Budget caps: SWE-agent $3/instance with auto-submit of the existing diff (salvage);
  resolved runs median 12 steps vs 21 unresolved.

## 5. Task decomposition

- Self-planning Code Generation (TOSEM/ASE 2024): plan-then-implement up to +25.4% relative
  Pass@1 over one-shot. Plan-and-Solve (ACL 2023) targets exactly weak-model one-shot
  failures.
- CodePlan (Microsoft, FSE 2024): the ORCHESTRATOR should own cross-file dependency
  ordering — unplanned LLM baselines fail to make repos valid.
- Spec Kit: each task independently implementable and testable. Ralph loop: ONE item per
  loop, fresh context, state in the filesystem.
- Anthropic "Building effective agents": programmatic gates on intermediate steps; ground
  truth from the environment at each step.

## 6. Git strategy

- aider: auto-commit every LLM edit; git IS the undo mechanism. Cline: shadow-repo
  checkpoints after each tool use. Claude Code: checkpoints + /rewind; worktrees for
  isolation. Devin/Sweep: branch-per-task, PR-as-deliverable, branch protection so PRs must
  pass CI. OpenHands issue #9999 (agents doing commit+push caused unintended pushes):
  don't let the model drive git.
- No published quantitative comparison of rollback strategies — practitioner-design
  territory. Synthesis: orchestrator owns git; commit per green gate; reset --hard to
  last-green on regression; squash to PR at the end.

## 7. LLM-as-reviewer as final gate

- Self-preference bias is real and causal (NeurIPS 2024, arXiv 2404.13076).
- Cross-model diff review beats self-review (Greptile, 1,500+ seeded bugs: Claude→Claude
  53.7% recall vs Claude→GPT 60.0%; GPT→GPT 50.5% vs GPT→Claude 62.0%): "the bugs a model
  introduces most often are the same types it's likely to miss in review".
- Intrinsic self-correction without external signals doesn't work (ICLR 2024, arXiv
  2310.01798). Sycophancy under rebuttal: evaluators flip correct verdicts when challenged
  (EMNLP 2025) — never let the implementer argue with the reviewer; single-turn review.
- Grounding: require file/line citations + quoted code; deterministically discard ungrounded
  findings (CodeRabbit judge; arXiv 2510.10290).
- Verifier value: SWE-Gym fine-tuned verifiers lift a 32B agent 19.7% → 26.3% Best@k;
  CodeMonkeys ensemble-selection 66.2% beats every member.

## 8. SWE-bench 2025–2026: open-weight systems

- Size class that matters: Devstral Small 2 (24B): 68.0% Verified with OpenHands scaffold;
  Qwen3-Coder-30B-A3B: ~51.6% at 100 turns; SWE-Swiss-32B 60.2% via explicit
  localize/repair/test-gen decomposition; DeepSWE-32B 42.2% → 59% with test-time scaling.
- **Agentless** (localize → repair → validate, no agent): 50.8% Verified at ~$0.70/instance;
  patch selection = regression tests + LLM reproduction tests + majority voting.
  Reproduction tests provide the largest gain beyond voting.
- **Kimi-Dev (72B)**, clearest 2026 pipeline-vs-agentic evidence for open models: 60.4% via
  agentless pipeline with test-time self-play vs 48.6% pass@1 in agentic SWE-agent mode —
  the structured pipeline outscores the same model run agentically.
- Counter-trend for FRONTIER models: mini-swe-agent (100 lines, bash-only) >74% Verified.
  Verdict: for ~30B open models, structured pipelines + verification-based selection remain
  superior; orchestrator-owns-control-flow is on the evidence-supported side for this class.

## 9. Prompt/context budget for ~30B models

- Context Rot (Chroma, 18 models): degradation begins far below the advertised window; for
  coding agents "context rot is the primary failure mode". NoLiMa: effective length (≥85%
  of base score) is a small fraction of claimed context. RULER: only about half of tested
  models effectively handle even 32K; smaller models degrade more.
- IFScale: instruction-following degrades with simultaneous instruction count; smaller
  models show exponential decay — a weak model should get a handful of instructions per
  call, not a 40-rule system prompt.
- Injection vs discovery: ReCUBE (arXiv 2603.25770) — agentic exploration helps precisely
  for limited-context models, but small models struggle with agentic judgment and open-ended
  tool loops are expensive on self-hosted hardware (Qwen3-Coder-30B needed 100 turns for
  51.6%). Hybrid tilted toward orchestrator-curated injection: loop does localization,
  injects task + relevant windows (±50 lines) + failing-test output; working prompts in the
  low tens of K tokens; model gets narrow capped discovery tools; fresh context per subtask.
