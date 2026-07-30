# Survey: architecture of the most-starred autonomous coding agents

> Research input for PROPOSAL.md. Star counts fetched from the GitHub API on 2026-07-30.
> Target use case: deterministic TypeScript orchestrator + weak self-hosted model
> (Qwen3-coder ~27B class) + build/test/review gates.

| Project | Stars (2026-07-30) | Status note |
|---|---|---|
| github/spec-kit | 124,498 | created 2025-08, explosive growth |
| google-gemini/gemini-cli | 106,240 | active |
| openai/codex | 102,417 | active, Rust core |
| OpenHands (ex All-Hands-AI) | 82,536 | pivoted to agent-orchestration hub; core → software-agent-sdk |
| cline/cline | 65,211 | active; agent loop being extracted into an SDK |
| AntonOsika/gpt-engineer | 55,180 | archived 2026-04-22 |
| goose (ex block/, now aaif-goose/) | 51,930 | active, moved to Agentic AI Foundation |
| Aider-AI/aider | 47,789 | development slowed (last push 2026-05) |
| RooCodeInc/Roo-Code | 24,362 | archived; extension shut down 2026-05-15 |
| SWE-agent/SWE-agent | 19,950 | superseded by mini-swe-agent |
| stitionai/devika | 19,546 | effectively dead |
| plandex-ai/plandex | 15,544 | active |

## 1. OpenHands (formerly OpenDevin) — 82.5k★

1. **CodeAct — executable code as the unified action space** (arXiv 2402.01030, ICML 2024).
   Across 17 LLMs, code-as-action beat JSON/text tool-calling by up to ~20 pts success rate.
   Weak models fight bespoke tool schemas hardest (cf. Qwen3-Coder-30B's documented
   native-function-calling breakage, QwenLM/Qwen3-Coder#475).
2. **Append-only event stream with deterministic replay** (arXiv 2407.16741; SDK paper
   arXiv 2511.03690). Agent = pure function `event history → next action`; state = event log.
   Measured on 433 SWE-bench Verified runs: 0.20 ms median per-event persist, full replay
   4.1 ms median. A 15-day production A/B: the event-sourced V1 cut system-attributable
   failures 61%.
3. **Condenser (context management)**: keep first event (user goal); when history > 100
   events, replace oldest with an LLM summary preserving goals/progress/TODOs/failing tests.
   Measured: per-turn API cost less than halved, SWE-bench Verified unchanged (~54% vs ~53%).
4. **StuckDetector** (openhands/controller/stuck.py @0.59.0) — deterministic, checked every
   step; on trigger the run errors out: (a) 4 identical action-observation cycles; (b) same
   action 3× each followed by an error observation; (c) 3 identical agent messages in a row;
   (d) alternating A₁O₁A₂O₂ pattern ×3; (e) 10+ consecutive condensation events.
5. **Verification = attempts + external filtering, not longer episodes**: run agent 5× at
   temp 1.0, filter patches failing regression + reproduction tests, rank remainder with a
   fine-tuned Qwen2.5-Coder-32B critic: 60.6% → 66.4% SWE-bench Verified. A 32B open model
   demonstrably works as a *judge* even when it's a mediocre *author*.

## 2. Aider — 47.8k★

The single richest source of edit-format evidence for weak models.

1. **Repo map**: tree-sitter symbols + reference-graph PageRank under a fixed token budget
   (default 1k tokens), constant cost at any repo size (aider.chat/docs/repomap.html).
2. **Edit formats — weak models need `whole`** (aider.chat/docs/more/edit-formats.html):
   GPT-3.5: whole 46% vs diff 30%. Qwen3-32B measured: whole 45.8% vs diff 41.3%, only 83.6%
   well-formed diffs (aider.chat/2025/05/08/qwen3.html). Thinking mode *hurt* Qwen3 (49.8%
   vs 61.8% without). High-level diffs (whole functions) cut edit errors 30-50%; disabling
   lenient/fuzzy patch matching caused a 9× increase in edit errors.
3. **Architect/editor two-model split** (aider.chat/2024/09/26/architect.html): o1-mini +
   DeepSeek-whole editor 61.1% → 71.4%. QwQ-32B solo 42.1% (can't emit edits reliably) but
   QwQ-architect + Qwen2.5-Coder-32B-editor = 73.6% with 100.0% correct edit format
   (aider.chat/2024/12/03/qwq.html).
4. **Git auto-commit per LLM edit + bounded reflection loop**: every edit auto-committed
   (git is the checkpoint/undo). Inner loop: apply → auto-lint → optional auto-test → feed
   errors back verbatim; hard cap `max_reflections = 3`.
5. **Self-hosting trap** (aider.chat/2024/11/21/quantization.html): Qwen2.5-Coder-32B bf16
   = 72.2%, but Ollama's default 2k context silently truncating dropped it to 51.9% with
   format compliance collapsing to 46.2%. Serving config moves scores more than quantization.

## 3. SWE-agent (Princeton) — 20k★

Full published ablation table for interface design (arXiv 2405.15793, NeurIPS 2024;
SWE-bench Lite, GPT-4 Turbo, baseline 18.0%):

| Design choice | Removing/degrading it costs |
|---|---|
| Lint-on-edit guardrail (edit reverted + shown error on lint fail) | −3.0 pts |
| Purpose-built edit command (vs sed/redirects) | −7.7 pts |
| Summarized search (one line per match; >50 hits → "narrow the query") | −6.0 pts (iterative paging is worse than no search, −2.3) |
| 100-line file window vs full file | −5.3 pts (full file worse than a 30-line window) |
| Collapsing observations older than the last 5 | −3.0 pts |

- **Block the first bad edit** — 51.7% of GPT-4 trajectories contain ≥1 failed edit;
  recovery odds decline as failed edits accumulate. Malformed outputs get max 3 retries with
  all but the first error message dropped from context.
- **Budget generosity has sharply diminishing returns**: $4/instance cap with auto-submit of
  the existing diff on exhaustion; resolved runs finish at median 12 steps vs 21 unresolved.
- **Mini-SWE-agent**: ~100 lines, bash-only, >74% SWE-bench Verified with frontier models.
  ACI scaffolding was worth +64% relative for GPT-4-class models — a 27B is on the 2024 side
  of that line; the ablated components are exactly what a deterministic orchestrator should own.

## 4. Cline — 65.2k★ / Roo Code — 24.4k★ (archived 2026-05)

- **Plan/Act split**: Plan mode structurally read-only; different models bindable per mode.
- **Shadow-git checkpoints after every tool use**; restore workspace and conversation
  independently.
- **Two failure detectors with an escalation ladder** (SDK mistake-tracker.ts,
  loop-detection.ts): consecutive-mistake counter (default 3) → stop or inject corrective
  guidance + reset; identical-tool-call detection via canonical JSON signature — soft 3 =
  inject warning, hard 5 = stop.
- **Deterministic context budgeting**: LLM "Auto Compact" is gated to frontier models —
  non-frontier models get rule-based truncation (Cline itself doesn't trust a 27B to
  summarize its own context). Memory Bank pattern: durable state lives on disk.
- **Roo Boomerang** (fresh-context-per-subtask contract): each subtask runs in complete
  isolation; downward channel = serialized instructions only; upward channel = a summary,
  never file dumps; the orchestrator cannot read/write files or run commands. Rationale:
  preventing "context poisoning".

## 5. GitHub Spec Kit — 124.5k★

- Phased artifact pipeline: constitution → specify → clarify → plan → analyze → tasks →
  implement → converge, producing spec.md / plan.md / tasks.md per feature.
- Mechanics that transfer to weak models: mandatory `[NEEDS CLARIFICATION: …]` markers a
  deterministic gate can grep for; checklists as "unit tests for the spec"; tasks that are
  small, file-disjoint (`[P]` = parallelizable = different files), dependency-ordered,
  independently testable, tests-fail-first. No quantified evidence published.
- Measured downside (Scott Logic field test, 2025-11): ~2,500 lines of generated markdown
  per ~700 LOC, 3.5 h review; the same feature done iteratively took 23 min (~10× faster).
  Lesson: ceremony proportional to task size.

## 6. The Ralph Wiggum loop (Geoff Huntley)

- `while :; do cat PROMPT.md | agent; done` — same prompt, fresh context every iteration;
  progress lives in files (specs/*, fix_plan.md, AGENT.md) and git, not the context window.
  Two prompts: PLANNING (gap-analyze specs vs code → prioritized TODO) and BUILDING (pick
  ONE item, implement, tests as backpressure, update plan, commit).
- Why fresh context: prevents hallucination accumulation/context rot; each loop re-reads
  true repo+plan state from disk. Exactly one concurrent build/test lane.
- Documented failure modes (his own): falsely concluding features unimplemented; placeholder
  /stub implementations; marking items done prematurely and weakening tests → tests/
  compilers/static analysis as backpressure; last resort `git reset --hard`. Greenfield-only,
  ~90% not 100%, needs supervision.
- Sharpest critique (HN 46672413): the loop works for objective endpoints and fails for
  phased deliverables — the fix being isolated steps with explicit state artifacts and
  verification gates, i.e. a deterministic orchestrator.

## 7. goose (Block / AAIF) — 51.9k★

- **Recipes with `retry.checks`** — YAML recipes carry max_retries, timeout_seconds, and
  checks = shell commands whose exit codes define success, plus on_failure cleanup; re-runs
  until checks pass or retries exhaust. A deterministic done-gate independent of model
  self-assessment.
- Sub-recipes over ad-hoc subagents: subagents return summaries by default.
- Lead/worker mode was removed, replaced by explicit Planning Mode (planner model produces a
  plan the executor follows) — turn-count-based model handoff lost to plan-artifact handoff.

## 8. Others with distinct lessons

- **OpenAI Codex CLI (102.4k★)**: two-axis permission model — sandbox capability decoupled
  from approval policy, enforced by the OS; network off by default. Originated AGENTS.md.
- **Gemini CLI (106.2k★)**: LoopDetectionService — hashed tool-call cycles (length 1-5, fire
  at 5), content "chanting" detection, LLM judge after turn 30 at >0.9 confidence. Documented
  false-positive problem → tune warn-then-kill, don't hard-kill on first trigger.
- **Plandex (15.5k★)**: cumulative diff sandbox (edits accumulate outside the working tree
  until reviewed); granular model-role registry — planner / architect / coder / builder /
  whole-file-builder as the fallback when targeted edits fail, plus tree-sitter syntax
  validation with escalation to whole-file rewrite.
- **gpt-engineer (55.2k★, archived)**: clarify-then-spec was the durable idea; one-shot
  generation with no build/test feedback loop plateaued and lost to incremental
  test-verified editing.
- **Devika (19.5k★, dead)**: planner→researcher→coder with no verification gates or
  convergence criterion — demos well, dies in practice.

## Cross-cutting conclusions

1. **Plan-first**: directionally yes, strongest quantified evidence is aider's architect
   mode (+2 to +10 pts, biggest for models that reason well but edit poorly) and Laban et
   al. arXiv 2505.06120 (avg −39% when requirements arrive sharded across turns). Ceremony
   proportional to task size (Spec Kit's 10× overhead on small features).
2. **Fresh session per unit of work** is the converged pattern (Ralph, Boomerang, goose,
   Spec Kit, mini-swe-agent); long sessions survive only with condensation that Cline gates
   to frontier models. With a 27B: fresh session per gate-iteration, state in files.
3. **Stuck detection**: Cline's warn-then-kill ladder + OpenHands' deterministic
   action-observation patterns + SWE-agent's budget-with-salvage (never discard the partial
   diff) + cross-iteration same-failing-tests detection.
4. **Edit format for ~30B open models**: whole-file (or architect→whole-editor split), never
   strict diffs (Qwen3-32B: whole 45.8% > diff 41.3%, 16% malformed diffs); lenient
   application; lint-gate with revert-and-retry.
5. **Context scoping**: ranked repo map under a fixed budget (aider) or deterministic
   localization as a pipeline stage (Agentless 27.3% Lite at $0.34/issue); never hand a weak
   model whole files or raw grep dumps (SWE-agent ablations).
6. **Serving config is a first-class risk**: context-length truncation cost Qwen2.5-32B
   twenty points in aider's measurements — more than any architectural choice.
