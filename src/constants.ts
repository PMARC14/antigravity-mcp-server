// Logging
export const LOG_PREFIX = "[AGY-MCP]";

// Error messages
export const ERROR_MESSAGES = {
  TOOL_NOT_FOUND: "not found in registry",
  NO_PROMPT_PROVIDED:
    "Please provide a prompt for analysis. Reference files by path (e.g., 'explain what src/index.ts does') or ask general questions",
  QUOTA_EXCEEDED: "Rate limit exceeded",
  AUTHENTICATION_FAILED:
    "Authentication failed - run `agy` once interactively to sign in with your Google account",
  AGY_NOT_FOUND:
    "Antigravity CLI not found - install from https://antigravity.google/docs/cli-getting-started (binary `agy` in ~/.local/bin)",
} as const;

// Status messages
export const STATUS_MESSAGES = {
  PRINT_EXECUTING: "🔒 Executing Antigravity CLI in print mode...",
  AGY_RESPONSE: "Antigravity response:",
  AUTHENTICATION_SUCCESS: "✅ Authentication successful",
  PROCESSING_START:
    "🔍 Starting analysis (may take 5-15 minutes for large codebases)",
  PROCESSING_CONTINUE: "⏳ Still processing...",
  PROCESSING_COMPLETE: "✅ Analysis completed successfully",
} as const;

// Known model IDs from agy 1.4.9.
export const MODELS = {
  GEMINI_4_ARGON_LOW: "gemini-4-argon-low",
  GEMINI_4_ARGON_MEDIUM: "gemini-4-argon-medium",
  GEMINI_4_ARGON_HIGH: "gemini-4-argon-high",
  GEMINI_3_8_FLASH_LOW: "gemini-3.8-flash-low",
  GEMINI_3_8_FLASH_MEDIUM: "gemini-3.8-flash-medium",
  GEMINI_3_8_FLASH_HIGH: "gemini-3.8-flash-high",
  CLAUDE_OPUS_5_5_LOW: "claude-opus-5-5-low",
  CLAUDE_OPUS_5_5_MEDIUM: "claude-opus-5-5-medium",
  CLAUDE_OPUS_5_5_HIGH: "claude-opus-5-5-high",
  CLAUDE_SONNET_5_5_LOW: "claude-sonnet-5-5-low",
  CLAUDE_SONNET_5_5_MEDIUM: "claude-sonnet-5-5-medium",
  CLAUDE_SONNET_5_5_HIGH: "claude-sonnet-5-5-high",
  GPT_OSS_120B_MEDIUM: "gpt-oss-120b-medium",
} as const;

export const DEFAULT_MODEL: string = MODELS.GEMINI_3_8_FLASH_HIGH;
export const REVIEW_MODEL: string = MODELS.GEMINI_4_ARGON_HIGH;

// MCP Protocol Constants
export const PROTOCOL = {
  ROLES: {
    USER: "user",
    ASSISTANT: "assistant",
    TOOL: "tool",
  },
  CONTENT_TYPES: {
    TEXT: "text",
  },
  STATUS: {
    SUCCESS: "success",
    ERROR: "error",
    FAILED: "failed",
    REPORT: "report",
  },
  NOTIFICATIONS: {
    PROGRESS: "notifications/progress",
  },
  KEEPALIVE_INTERVAL: 25000, // 25 seconds
} as const;

// CLI flags used by agy 1.4.9.
export const CLI = {
  COMMANDS: {
    AGY: "agy",
  },
  FLAGS: {
    // Print mode (non-interactive, required for MCP)
    PRINT: "-p", // also: --print / --prompt
    PRINT_TIMEOUT: "--print-timeout", // Go duration string, e.g. "5m0s" (default 5m)

    // Model — accepts either column of `agy models` (id or display label)
    MODEL: "--model",

    // Conversations
    CONTINUE: "--continue", // resume the most recent conversation
    CONVERSATION: "--conversation", // resume a previous conversation by ID

    // Workspace
    ADD_DIR: "--add-dir", // add a directory to the workspace (repeatable)

    // Approvals / isolation
    SKIP_PERMISSIONS: "--dangerously-skip-permissions", // auto-approve all tool calls
    SANDBOX: "--sandbox", // run with terminal restrictions

    // Diagnostics
    LOG_FILE: "--log-file", // fallback conversation diagnostics
    HELP: "--help",
    VERSION: "--version",

    // Structured input/output and reasoning controls.
    EFFORT: "--effort", // reasoning effort: low | medium | high | xhigh | max
    OUTPUT_FORMAT: "--output-format", // text | json | stream-json
    INPUT_FORMAT: "--input-format", // text | stream-json
    JSON_SCHEMA: "--json-schema", // enforce structured output
    AGENT: "--agent", // agent for the session (see `agy agents`)
    MODE: "--mode", // accept-edits | plan
    PROJECT: "--project", // project ID for the session
    NEW_PROJECT: "--new-project",
    DISABLE_SLASH_COMMANDS: "--disable-slash-commands",
  },
  SUBCOMMANDS: {
    MODELS: "models",
    AGENTS: "agents",
    CHANGELOG: "changelog",
    UPDATE: "update",
    INSTALL: "install",
    PLUGIN: "plugin",
  },
  ENV_VARS: {
    AGY_MCP_CWD: "AGY_MCP_CWD", // Primary: set in MCP client configuration
    PWD: "PWD",
    INIT_CWD: "INIT_CWD",
  },
} as const;

// Tool argument interface — superset of every tool's schema for type-safe dispatch.
export interface ToolArguments {
  prompt?: string;
  model?: string;
  mode?: "read" | "write" | "full";
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  jsonSchema?: string | Record<string, unknown>;
  skipPermissions?: boolean | string; // --dangerously-skip-permissions
  sandbox?: boolean | string; // --sandbox
  cd?: string; // Working directory (alias of workingDir)
  workingDir?: string; // Working directory for spawn cwd

  // Session management
  sessionId?: string; // Internal session id (workspace-isolated)
  conversationId?: string; // Native Antigravity conversation id passed to --conversation
  resetSession?: boolean; // Clear session before run
  continueLatest?: boolean; // --continue (most recent conversation)

  // Workspace
  addDirs?: string[]; // --add-dir (repeatable)

  // Misc
  timeout?: number;
  includeMetadata?: boolean;
  responseMode?: "clean" | "full";
  message?: string; // for ping
  verbose?: boolean; // for health

  // Brainstorming
  methodology?: string;
  domain?: string;
  constraints?: string;
  existingContext?: string;
  ideaCount?: number;
  includeAnalysis?: boolean;

  // Review
  uncommitted?: boolean;
  base?: string;
  commit?: string;
  title?: string;

  // List-sessions
  action?: "list" | "delete" | "clear";

  [key: string]:
    | string
    | boolean
    | number
    | string[]
    | Record<string, any>
    | undefined
    | any;
}
