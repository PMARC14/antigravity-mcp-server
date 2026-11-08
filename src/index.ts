#!/usr/bin/env node
import {
  installRequestErrorReporting,
  trafficLog,
} from "./tools/traffic-log.js";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  SetLevelRequestSchema,
  CompleteRequestSchema,
  CallToolRequest,
  ListToolsRequest,
  ListPromptsRequest,
  GetPromptRequest,
  SetLevelRequest,
  CompleteRequest,
  Tool,
  Prompt,
  GetPromptResult,
  CallToolResult,
  CreateTaskResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Logger } from "./utils/logger.js";
import { PROTOCOL, ToolArguments } from "./constants.js";

import {
  getToolDefinitions,
  getPromptDefinitions,
  executeTool,
  toolExists,
  getPromptMessage,
  agyJobManager,
} from "./tools/index.js";
import { getCompletionValues } from "./utils/completions.js";
import { SERVER_VERSION } from "./version.js";
import { executeJobWatch, needsJobWatch } from "./tools/job-watch-progress.js";
import {
  registerMcpTasks,
  TaskStdioTransport,
  taskCapabilities,
} from "./tools/mcp-tasks.js";

const capabilities = {
  tools: {},
  prompts: {},
  logging: {},
  completions: {},
  tasks: taskCapabilities,
};

const server = new Server(
  {
    name: "antigravity-mcp",
    version: SERVER_VERSION,
  },
  {
    capabilities,
  },
);
installRequestErrorReporting(server);
const mcpTasks = registerMcpTasks(server, "agy", agyJobManager, {
  capabilities,
});

async function sendProgressNotification(
  progressToken: string | number | undefined,
  progress: number,
  total?: number,
  message?: string,
) {
  if (progressToken === undefined) return;
  try {
    const params: any = { progressToken, progress };
    if (total !== undefined) params.total = total;
    if (message) params.message = message;
    await server.notification({
      method: PROTOCOL.NOTIFICATIONS.PROGRESS,
      params,
    });
  } catch (error) {
    Logger.error("Failed to send progress notification:", error);
  }
}

function startProgressUpdates(
  operationName: string,
  progressToken?: string | number,
) {
  const state = {
    isProcessing: true,
    currentOperationName: operationName,
    latestOutput: "",
    progress: 0,
  };

  const progressMessages = [
    `🧠 ${operationName} - Antigravity is analyzing your request...`,
    `📊 ${operationName} - Processing files and generating insights...`,
    `✨ ${operationName} - Composing structured response...`,
    `⏱️ ${operationName} - Large analysis in progress (this is normal for big repos)...`,
    `🔍 ${operationName} - Still working — agentic runs are deliberate by design...`,
  ];

  let messageIndex = 0;

  if (progressToken !== undefined) {
    sendProgressNotification(
      progressToken,
      0,
      undefined,
      `🔍 Starting ${operationName}`,
    );
  }

  const progressInterval = setInterval(async () => {
    if (state.isProcessing && progressToken !== undefined) {
      state.progress += 1;
      const baseMessage =
        progressMessages[messageIndex % progressMessages.length];
      const outputPreview = state.latestOutput.slice(-150).trim();
      const message = outputPreview
        ? `${baseMessage}\n📝 Output: ...${outputPreview}`
        : baseMessage;
      await sendProgressNotification(
        progressToken,
        state.progress,
        undefined,
        message,
      );
      messageIndex++;
    } else if (!state.isProcessing) {
      clearInterval(progressInterval);
    }
  }, PROTOCOL.KEEPALIVE_INTERVAL);

  return { interval: progressInterval, progressToken, state };
}

function stopProgressUpdates(
  progressData: {
    interval: NodeJS.Timeout;
    progressToken?: string | number;
    state?: any;
  },
  success: boolean = true,
) {
  const operationName = progressData.state?.currentOperationName || "";
  if (progressData.state) progressData.state.isProcessing = false;
  clearInterval(progressData.interval);

  if (progressData.progressToken !== undefined) {
    sendProgressNotification(
      progressData.progressToken,
      (progressData.state.progress += 1),
      undefined,
      success
        ? `✅ ${operationName} completed successfully`
        : `❌ ${operationName} failed`,
    );
  }
}

server.setRequestHandler(
  SetLevelRequestSchema,
  async (request: SetLevelRequest): Promise<Record<string, never>> => {
    Logger.setLevel(request.params.level);
    Logger.debug(
      `Log level updated to '${request.params.level}' via client request.`,
    );
    return {};
  },
);

server.setRequestHandler(
  ListToolsRequestSchema,
  async (_request: ListToolsRequest): Promise<{ tools: Tool[] }> => {
    return { tools: getToolDefinitions() as unknown as Tool[] };
  },
);

server.setRequestHandler(
  CallToolRequestSchema,
  async (
    request: CallToolRequest,
    extra,
  ): Promise<CallToolResult | CreateTaskResult> => {
    const toolName: string = request.params.name;

    if (request.params.task !== undefined) {
      return mcpTasks.call(
        toolName,
        request.params.arguments || {},
        request.params._meta,
      );
    }

    if (toolExists(toolName)) {
      const progressToken = (request.params as any)._meta?.progressToken;
      const watching = needsJobWatch(toolName);
      const progressData = watching
        ? undefined
        : startProgressUpdates(toolName, progressToken);

      try {
        const args: ToolArguments =
          (request.params.arguments as ToolArguments) || {};
        Logger.toolInvocation(toolName, request.params.arguments);

        const result = watching
          ? await executeJobWatch(toolName, args, {
              progressToken,
              signal: extra.signal,
              manager: agyJobManager,
              notify: (params) =>
                extra.sendNotification({
                  method: PROTOCOL.NOTIFICATIONS.PROGRESS,
                  params,
                }),
            })
          : await executeTool(
              toolName,
              args,
              (newOutput) => {
                if (progressData?.state) {
                  progressData.state.latestOutput = newOutput;
                }
              },
              extra.signal,
            );

        if (progressData) stopProgressUpdates(progressData, true);

        if (typeof result === "string") {
          return {
            content: [{ type: "text", text: result }],
            isError: false,
          };
        }
        return {
          content: [{ type: "text", text: result.text }],
          structuredContent: result.structuredContent,
          isError: false,
        } as CallToolResult;
      } catch (error) {
        if (progressData) stopProgressUpdates(progressData, false);
        trafficLog.error(`tools/call ${toolName}`, error);
        Logger.error(`Error in tool '${toolName}':`, error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error executing ${toolName}: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
    throw new Error(`Unknown tool: ${request.params.name}`);
  },
);

server.setRequestHandler(
  ListPromptsRequestSchema,
  async (
    _request: ListPromptsRequest,
  ): Promise<{
    prompts: Prompt[];
  }> => {
    return { prompts: getPromptDefinitions() as unknown as Prompt[] };
  },
);

server.setRequestHandler(
  GetPromptRequestSchema,
  async (request: GetPromptRequest): Promise<GetPromptResult> => {
    const promptName = request.params.name;
    const args = request.params.arguments || {};
    const promptMessage = getPromptMessage(promptName, args);
    if (!promptMessage) throw new Error(`Unknown prompt: ${promptName}`);
    return {
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: promptMessage },
        },
      ],
    };
  },
);

server.setRequestHandler(
  CompleteRequestSchema,
  async (request: CompleteRequest) => {
    const { argument } = request.params;
    const completion = getCompletionValues(argument.name, argument.value);
    return { completion };
  },
);

async function main() {
  Logger.debug("init antigravity-mcp-server");
  const transport = new TaskStdioTransport("agy");
  server.onclose = () => {
    mcpTasks.close();
    // The SDK aborts in-flight requests. Job processes and their queue keep running;
    // their open pipes keep this server alive until their results have been saved.
  };
  let disconnected = false;
  const disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    void server
      .close()
      .catch((error) => Logger.error("Failed to close MCP transport:", error));
  };
  // The stdio transport does not close itself on EOF or a broken output pipe.
  process.stdin.once("end", disconnect);
  process.stdin.once("close", disconnect);
  process.stdout.once("error", disconnect);
  await server.connect(transport);
  Logger.debug("antigravity-mcp-server listening on stdio");
  // Discovery must be served before recovery/lock/process inspection can delay startup.
  // Job tools and task handlers await the same idempotent initialization promise.
  await agyJobManager.initialize();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    mcpTasks.close();
    void agyJobManager.dispose().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  Logger.error("Fatal error:", error);
  process.exit(1);
});
