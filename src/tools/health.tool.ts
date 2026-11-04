import { z } from "zod";
import { UnifiedTool, StructuredToolResult } from "./registry.js";
import { AgyConnector } from "../connectors/agy.js";
import { readConfig } from "../jobs/config.js";
import { DEFAULT_MODEL, MODELS, REVIEW_MODEL } from "../constants.js";
import { fetchModels } from "../utils/modelList.js";
import { getSessionStats, getSession } from "../utils/sessionStorage.js";
import { Logger } from "../utils/logger.js";

const healthArgsSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe("Optional session ID to check specific session health"),
  verbose: z
    .boolean()
    .default(false)
    .describe("Include detailed diagnostic information"),
});

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  agyCli: {
    installed: boolean;
    version: string;
    authenticated: boolean;
    models: string[];
    available: boolean;
    exe?: string;
    reason?: string;
    reviewModel: string;
    defaultModel: string | null;
    jobsEnabled: boolean;
  };
  sessions: {
    total: number;
    withResume: number;
    maxSessions: number;
    ttlHours: number;
  };
  session?: {
    found: boolean;
    hasConversationId: boolean;
    lastActivity: string;
    workspaceId: string;
  };
  issues: string[];
}

/**
 * `agy models` requires a valid login (it queries the backend for available
 * models), so a non-empty result doubles as an authentication check.
 */
async function getModels(): Promise<string[]> {
  try {
    return (await fetchModels()).map((m) => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

export async function buildHealthStatus(sessionId?: string, connector = new AgyConnector(), liveModels = getModels): Promise<HealthStatus> {
  const issues: string[] = [];
  let status: HealthStatus["status"] = "healthy";

  const detection = await connector.detect();
  const config = readConfig().connectors.agy;
  const installed = detection.available;
  const fetchedModels = installed ? await liveModels() : [];
  const models = fetchedModels.length ? fetchedModels : Object.values(MODELS);
  const authenticated = fetchedModels.length > 0;

  if (!installed) {
    issues.push("Antigravity CLI not installed or not in PATH");
    status = "unhealthy";
  } else if (!authenticated) {
    issues.push(
      "Antigravity CLI may not be authenticated — run `agy` interactively and sign in with Google",
    );
    status = "degraded";
  }

  const sessionStats = getSessionStats();

  if (sessionStats.total >= sessionStats.maxSessions * 0.9) {
    issues.push(
      `Session limit nearly reached (${sessionStats.total}/${sessionStats.maxSessions})`,
    );
    if (status === "healthy") status = "degraded";
  }

  let sessionInfo: HealthStatus["session"] | undefined;
  if (sessionId) {
    const session = getSession(sessionId);
    if (session) {
      sessionInfo = {
        found: true,
        hasConversationId: !!session.conversationId,
        lastActivity: new Date(session.updatedAt).toISOString(),
        workspaceId: session.workspaceId,
      };
      if (!session.conversationId) {
        issues.push(
          `Session "${sessionId}" exists but has no native conversation ID for resume`,
        );
      }
    } else {
      sessionInfo = {
        found: false,
        hasConversationId: false,
        lastActivity: "N/A",
        workspaceId: "N/A",
      };
      issues.push(`Session "${sessionId}" not found or expired`);
    }
  }

  return {
    status,
    agyCli: {
      ...detection,
      installed,
      version: detection.version || "unknown",
      reviewModel: config?.reviewModel ?? REVIEW_MODEL,
      defaultModel: config?.defaultModel ?? DEFAULT_MODEL,
      jobsEnabled: config?.enabled !== false,
      authenticated,
      models,
    },
    sessions: {
      total: sessionStats.total,
      withResume: sessionStats.withResume,
      maxSessions: sessionStats.maxSessions,
      ttlHours: Math.round(sessionStats.ttlMs / (60 * 60 * 1000)),
    },
    session: sessionInfo,
    issues,
  };
}

function formatReport(h: HealthStatus, verbose: boolean): string {
  const emoji =
    h.status === "healthy" ? "✅" : h.status === "degraded" ? "⚠️" : "❌";
  let out = `## Health Check ${emoji} ${h.status.toUpperCase()}\n\n`;

  out += `### Antigravity CLI\n`;
  out += `| Property | Value |\n|----------|-------|\n`;
  out += `| Installed | ${h.agyCli.installed ? "✅ Yes" : "❌ No"} |\n`;
  out += `| Version | ${h.agyCli.version} |\n`;
  out += `| Authenticated | ${h.agyCli.authenticated ? "✅ Yes" : "⚠️ Unknown"} |\n\n`;

  out += `Review model: ${h.agyCli.reviewModel}\n\n`;
  if (h.agyCli.models.length > 0) {
    out += `### Available Models\n`;
    for (const m of h.agyCli.models) out += `- ${m}\n`;
    out += `\n`;
  }

  out += `### Sessions\n`;
  out += `| Metric | Value |\n|--------|-------|\n`;
  out += `| Active Sessions | ${h.sessions.total}/${h.sessions.maxSessions} |\n`;
  out += `| With Resume | ${h.sessions.withResume} |\n`;
  out += `| TTL | ${h.sessions.ttlHours} hours |\n\n`;

  if (h.session) {
    out += `### Session Details\n`;
    out += `| Property | Value |\n|----------|-------|\n`;
    out += `| Found | ${h.session.found ? "✅ Yes" : "❌ No"} |\n`;
    if (h.session.found) {
      out += `| Has conversation ID | ${h.session.hasConversationId ? "✅ Yes" : "❌ No"} |\n`;
      out += `| Last Activity | ${h.session.lastActivity} |\n`;
      out += `| Workspace ID | ${h.session.workspaceId} |\n`;
    }
    out += `\n`;
  }

  if (h.issues.length > 0) {
    out += `### Issues Found\n`;
    for (const i of h.issues) out += `- ⚠️ ${i}\n`;
    out += `\n`;
  }

  if (h.status !== "healthy") {
    out += `### Recommended Actions\n`;
    if (!h.agyCli.installed) {
      out += `1. Install Antigravity CLI: https://antigravity.google/docs/cli-getting-started\n`;
    }
    if (!h.agyCli.authenticated) {
      out += `2. Authenticate: run \`agy\` interactively and sign in with your Google account\n`;
    }
  }

  if (verbose) {
    out += `\n### Environment\n`;
    out += `- AGY_MCP_CWD: ${process.env.AGY_MCP_CWD || "(unset)"}\n`;
    out += `- AGY_SESSION_TTL_MS: ${process.env.AGY_SESSION_TTL_MS || "(default 24h)"}\n`;
    out += `- AGY_MAX_SESSIONS: ${process.env.AGY_MAX_SESSIONS || "(default 50)"}\n`;
  }

  return out;
}

export const healthTool: UnifiedTool = {
  name: "health",
  description:
    "Check Antigravity CLI installation, authentication, available models, and session health",
  zodSchema: healthArgsSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "string" },
      agyCli: { type: "object" },
      sessions: { type: "object" },
      issues: { type: "array" },
      error: { type: "string" },
    },
    required: ["status", "agyCli", "sessions", "issues"],
  },
  prompt: {
    description:
      "Diagnose Antigravity CLI installation, authentication, and session health",
  },
  category: "utility",
  execute: async (args) => {
    const { sessionId, verbose } = args;
    try {
      const h = await buildHealthStatus(sessionId as string | undefined);
      return {
        text: formatReport(h, verbose as boolean),
        structuredContent: h as unknown as Record<string, unknown>,
      } as StructuredToolResult;
    } catch (error) {
      Logger.error("Health check failed:", error);
      const msg = error instanceof Error ? error.message : String(error);
      return {
        text: `Health check failed: ${msg}`,
        structuredContent: {
          status: "unhealthy",
          agyCli: { available: false, installed: false, version: "unknown", authenticated: false,
            models: [], reviewModel: REVIEW_MODEL, defaultModel: DEFAULT_MODEL, jobsEnabled: false },
          sessions: { total: 0, withResume: 0, maxSessions: 0, ttlHours: 0 },
          issues: [msg], error: msg,
        },
      } as StructuredToolResult;
    }
  },
};
