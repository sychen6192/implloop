// Runner factory: the only place that knows which runtimes exist.
import { AgentRunner } from "../libs/types";
import { RUNNER_KIND } from "../config";
import { OpencodeRunner } from "./opencode";

export async function createRunner(): Promise<AgentRunner> {
  // RUNNER_KIND is validated at config load; only one runtime exists today.
  void RUNNER_KIND;
  return new OpencodeRunner();
}
