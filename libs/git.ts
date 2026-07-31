// Git sovereignty layer: the pipeline owns every git operation; agents never touch git
// (writer has no bash). Commit per green step = checkpoint; reset --hard = rollback.
// All calls go through execFileSync (no shell) — file paths and messages are arguments.
import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "../config";

export function git(args: string[], allowFail = false): string {
  try {
    // core.quotePath=false: porcelain output must carry non-ASCII paths verbatim, not
    // C-quoted with octal escapes — the protect gate compares these paths literally.
    return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (e) {
    if (allowFail) return "";
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr = err.stderr ? String(err.stderr).trim() : "";
    throw new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`);
  }
}

export function isGitRepo(): boolean {
  try {
    return git(["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

// Clean = no staged/unstaged changes and no untracked files.
export function isCleanTree(): boolean {
  return git(["status", "--porcelain"]) === "";
}

export function currentBranch(): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function headSha(): string {
  return git(["rev-parse", "HEAD"]);
}

export function createBranch(name: string) {
  git(["checkout", "-b", name]);
}

// Stage everything and commit. Returns false when there was nothing to commit.
export function commitAll(message: string): boolean {
  git(["add", "-A"]);
  if (git(["status", "--porcelain"]) === "") return false;
  git(["commit", "-m", message, "--no-verify"]);
  return true;
}

// Drop every uncommitted change (tracked and untracked) — rollback to the last checkpoint.
export function resetHardClean() {
  git(["reset", "--hard", "HEAD"]);
  git(["clean", "-fd"]);
}

// Files changed but not yet committed (staged + unstaged + untracked).
export function uncommittedFiles(): string[] {
  const out = git(["status", "--porcelain"]);
  if (!out) return [];
  // porcelain v1: "XY <path>" or "XY <old> -> <new>" for renames.
  return out.split("\n").map((l) => {
    const p = l.slice(3);
    const arrow = p.indexOf(" -> ");
    return (arrow >= 0 ? p.slice(arrow + 4) : p).replace(/^"|"$/g, "");
  });
}

// Added lines of the uncommitted diff (for hack-marker scanning). Includes untracked files.
export function uncommittedAddedLines(): string[] {
  git(["add", "-N", "."], true); // make untracked files visible to diff
  const out = git(["diff", "-U0"], true);
  return out
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
}

// Full diff of the run branch against its base commit (for the review gate).
export function diffAgainst(baseSha: string): string {
  return git(["diff", baseSha, "HEAD"], true);
}

export function changedFilesSince(baseSha: string): string[] {
  const out = git(["diff", "--name-only", baseSha, "HEAD"], true);
  return out ? out.split("\n").filter(Boolean) : [];
}

// Branch-safe slug from a task file name: "fix login bug.md" -> "fix-login-bug".
export function slugify(name: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "task";
}
