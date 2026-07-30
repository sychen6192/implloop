// OpencodeRunner: spawn `opencode run --agent impl-<role> --format json`, prompt over stdin.
// Ported from testloop's validated runner (JSONL tracing, Windows spawn planning,
// prompt via stdin, SIGTERM→SIGKILL timeout, fail-closed on spawn error).
import { spawn } from "node:child_process";
import { AgentRole, AgentRunner, AgentRunOutput } from "../libs/types";
import {
  REPO_ROOT,
  ROLE_MODELS,
  ROLE_SKIP_PERMS,
  AGENT_TIMEOUT_MS,
  OPENCODE_BIN,
  OPENCODE_JSON_EVENTS,
  OPENCODE_SKIP_PERMS,
} from "../config";
import { log, logVerbose, startHeartbeat } from "../libs/log";
import { explainSpawnError, planSpawn } from "../libs/shell";

// One JSONL event -> readable progress; text events accumulate into finalText.
// The real type is in part.type, hyphenated; the outer ev.type is an unreliable envelope
// label. Compat: accept both hyphen and underscore; fall back to ev.type when missing.
export function traceEvent(
  line: string,
  prefix: string,
  acc: { text: string; lastText: string; toolCalls?: Set<string> },
) {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line);
  } catch {
    return; // non-JSON line (diagnostic noise), skip
  }
  const part = (ev.part ?? {}) as Record<string, unknown>;
  const kindRaw = String(part.type ?? ev.type ?? "");
  const kind = kindRaw.replace(/_/g, "-");

  switch (kind) {
    case "step-start":
      logVerbose(`${prefix}  -- step 開始`);
      break;
    case "step-finish": {
      const tokens = (part.tokens ?? {}) as Record<string, unknown>;
      if (tokens.output !== undefined) {
        logVerbose(`${prefix}  -- step 結束（output tokens=${String(tokens.output)}）`);
      }
      break;
    }
    case "tool": {
      const tool = String(part.tool ?? "unknown");
      const state = (part.state ?? {}) as Record<string, unknown>;
      const status = String(state.status ?? "");
      const input = JSON.stringify(state.input ?? {});
      const shortInput = input.length > 140 ? input.slice(0, 140) + "…" : input;
      const outRaw = state.output;
      const outNote =
        typeof outRaw === "string" && outRaw.length <= 60 ? ` -> ${outRaw}` : "";
      logVerbose(`${prefix}  [tool] ${tool} [${status}] ${shortInput}${outNote}`);
      if (status === "completed" && acc.toolCalls) {
        acc.toolCalls.add(String(part.callID ?? `${tool}#${acc.toolCalls.size}`));
      }
      break;
    }
    case "text": {
      const t = String(part.text ?? "");
      if (t) {
        acc.text += t;
        acc.lastText = t; // models often put the final JSON in the last complete text part
        const oneLine = t.replace(/\s+/g, " ").trim();
        if (oneLine) {
          logVerbose(
            `${prefix}  ${oneLine.length > 160 ? oneLine.slice(0, 160) + "…" : oneLine}`,
          );
        }
      }
      break;
    }
    case "error":
      logVerbose(`${prefix}  [WARN] ${JSON.stringify(ev).slice(0, 300)}`);
      break;
  }
}

/**
 * Builds the argv for one `opencode run`. The prompt is deliberately NOT in it — the runner
 * writes it to the child's stdin.
 *
 * `opencode run` reads stdin to EOF whenever stdin is not a TTY and uses it as the message
 * (appended after the positional message, if any). Passing no positional message therefore
 * makes the piped text the entire prompt.
 *
 * That is the only route that is safe on Windows. Two earlier attempts were not:
 *
 * - Positional argument: an npm-installed `opencode.cmd` must be spawned through cmd.exe
 *   (Node refuses to spawn .cmd directly since the CVE-2024-27980 fix), and cmd.exe re-parses
 *   the command line, shredding a prompt full of quotes, newlines and JSON. It is capped at
 *   8191 chars besides. opencode also re-quotes positional messages itself, which corrupts
 *   any prompt containing a double quote even on POSIX.
 * - `--file <tmp>/prompt.md <instruction>`: opencode declares --file as a yargs array option,
 *   so it greedily swallows every following positional. The instruction was parsed as a
 *   second file path, giving `File not found: <the instruction text>`.
 *
 * stdin has no length limit and never passes through a shell, so this needs no
 * platform-specific branch at all.
 */
export function buildInvocation(
  agent: string,
  model: string,
  opts: { jsonEvents: boolean; skipPerms: boolean },
): string[] {
  const args = ["run", "--agent", agent];
  if (model) args.push("--model", model);
  if (opts.jsonEvents) args.push("--format", "json");
  if (opts.skipPerms) args.push("--dangerously-skip-permissions");
  return args;
}

export class OpencodeRunner implements AgentRunner {
  run(role: AgentRole, prompt: string): Promise<AgentRunOutput> {
    const agent = `impl-${role}`;
    const model = ROLE_MODELS[role];
    // Skip-perms only ever applies to the writer; read-only roles never get it.
    const skipPerms = ROLE_SKIP_PERMS[role] && OPENCODE_SKIP_PERMS;
    return new Promise((resolve) => {
      log(`[${role}] session 啟動（agent=${agent}, model=${model || "（agent 預設）"}）`);
      const stopHeartbeat = startHeartbeat(`[${role}]`);
      const started = Date.now();

      if (skipPerms) {
        logVerbose(`[${role}] [WARN] IL_OC_SKIP_PERMS=1：已附加 --dangerously-skip-permissions`);
      }

      const args = buildInvocation(agent, model, {
        jsonEvents: OPENCODE_JSON_EVENTS,
        skipPerms,
      });
      logVerbose(`[${role}] prompt（${prompt.length} 字元）以 stdin 傳入`);

      // Windows needs the command resolved through PATHEXT, and .cmd shims routed via
      // cmd.exe — Node refuses to spawn them directly since the CVE-2024-27980 fix.
      const plan = planSpawn(OPENCODE_BIN, args);
      if (plan.error) {
        log(`[FAIL] [${role}] ${plan.error}`);
        stopHeartbeat();
        resolve({ text: "" });
        return;
      }

      const child = spawn(plan.file, plan.args, {
        cwd: REPO_ROOT,
        env: process.env,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // opencode blocks on reading stdin to EOF before it prompts the model, so this has to
      // be written and closed unconditionally — a piped-but-never-closed stdin hangs the run.
      // EPIPE is expected if the child dies first (bad flag, missing auth); the close handler
      // reports that, so swallow it here rather than let it surface as an unhandled error.
      child.stdin.on("error", () => {});
      child.stdin.end(prompt, "utf8");

      const acc = { text: "", lastText: "", toolCalls: new Set<string>() };
      let rawStdout = "";
      let stdoutBuf = "";

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        rawStdout += chunk;
        stdoutBuf += chunk;
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) traceEvent(line, `[${role}]`, acc);
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        for (const line of chunk.trim().split("\n")) {
          if (line.trim()) logVerbose(`[${role}] ${line}`);
        }
      });

      // timeout: SIGTERM, then SIGKILL if still alive after 10s
      let killEscalation: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        logVerbose(`[${role}] 逾時 ${AGENT_TIMEOUT_MS}ms，送出 SIGTERM`);
        child.kill("SIGTERM");
        killEscalation = setTimeout(() => {
          logVerbose(`[${role}] SIGTERM 未生效，SIGKILL`);
          child.kill("SIGKILL");
        }, 10_000);
      }, AGENT_TIMEOUT_MS);

      let finished = false;
      let spawnError: string | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (killEscalation) clearTimeout(killEscalation);
        stopHeartbeat();
        if (spawnError) {
          log(`[FAIL] [${role}] ${spawnError}`);
          resolve({ text: "" });
          return;
        }
        if (stdoutBuf.trim()) traceEvent(stdoutBuf, `[${role}]`, acc); // flush the partial line
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        log(`[OK] [${role}] 完成（耗時 ${secs} 秒）`);
        if (OPENCODE_JSON_EVENTS) {
          resolve({
            text: acc.text.trim() ? acc.text : acc.lastText,
            toolCallCount: acc.toolCalls.size,
          });
        } else {
          // non-JSONL fallback: whole stdout; tool usage unobservable (undefined), not zero
          resolve({ text: rawStdout });
        }
      };

      child.on("close", finish);
      child.on("error", (err) => {
        spawnError = `${explainSpawnError(err, OPENCODE_BIN)}——請確認已安裝 opencode CLI，或以 IL_OPENCODE_BIN 指定路徑`;
        finish();
      });
    });
  }
}
