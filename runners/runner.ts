// Runner factory: the only place that knows which runtimes exist.
import { AgentRunner } from "../libs/types";
import { RUNNER_KIND } from "../config";
import { OpencodeRunner } from "./opencode";

export async function createRunner(): Promise<AgentRunner> {
  switch (RUNNER_KIND) {
    case "opencode":
      return new OpencodeRunner();
    default:
      throw new Error(`未知的 IL_RUNNER：${RUNNER_KIND}`);
  }
}
