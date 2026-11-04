import type { ToolArguments } from "../constants.js";
import { executeTool } from "./registry.js";

// Kept here because this fork has no shared progress reporter utility.
class ProgressReporter {
  private value = -1;

  constructor(
    private token: string | number | undefined,
    private notify: (params: {
      progressToken: string | number;
      progress: number;
      message?: string;
    }) => Promise<void>,
  ) {}

  async send(message?: string): Promise<void> {
    if (this.token === undefined) return;
    await this.notify({
      progressToken: this.token,
      progress: ++this.value,
      message,
    });
  }
}

/** Watch tools supply their own heartbeat instead of the server's generic keepalive. */
export async function executeJobWatch(
  name: string,
  args: ToolArguments,
  options: {
    progressToken?: string | number;
    signal: AbortSignal;
    notify: (params: {
      progressToken: string | number;
      progress: number;
      message?: string;
    }) => Promise<void>;
  },
) {
  let active = true;
  const reporter = new ProgressReporter(
    options.progressToken,
    async (params) => {
      if (active && !options.signal.aborted) await options.notify(params);
    },
  );
  try {
    return await executeTool(
      name,
      args,
      options.progressToken === undefined
        ? undefined
        : (message) => {
            // A broken notification transport must not affect the watched job or leave its wait hanging.
            void reporter.send(message).catch(() => {});
          },
      options.signal,
    );
  } finally {
    active = false;
  }
}
