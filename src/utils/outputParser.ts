import { Logger } from "./logger.js";

export type ResponseMode = "clean" | "full";

export interface AgyOutput {
  /** Final response text — what a clean-mode caller wants. */
  response: string;
  rawStdout: string;
  rawStderr?: string;
  conversationId?: string;
  status?: string;
}

/** Extract the final response and native conversation ID from agy NDJSON. */
export function parseAgyOutput(
  rawStdout: string,
  rawStderr?: string,
): AgyOutput {
  let response: string | undefined;
  let conversationId: string | undefined;
  let status: string | undefined;
  let streamSeen = false;
  let eventError: string | undefined;
  for (const line of rawStdout.replace(/^\uFEFF/, "").split("\n")) {
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    if (!data || typeof data.event !== "string") continue;
    streamSeen = true;
    if (data.event === "init") {
      conversationId =
        data.init?.conversation_id || data.conversation_id || conversationId;
    } else if (data.event === "result") {
      const result = data.result;
      if (!result) continue;
      conversationId = result.conversation_id || conversationId;
      status = result.status;
      if (typeof result.response === "string" && result.response.trim())
        response = result.response;
      if (typeof result.error === "string") eventError = result.error;
    }
  }
  response = streamSeen
    ? response?.trim() ||
      rawStderr?.trim() ||
      eventError ||
      "(no final response produced)"
    : rawStdout.trim() || rawStderr?.trim() || "";
  if (response) Logger.agyResponse(response);
  return {
    response,
    rawStdout,
    rawStderr,
    conversationId,
    status,
  };
}

export function formatAgyResponseFull(output: AgyOutput): string {
  const stderr = output.rawStderr || "";

  if (!stderr.trim() && !output.response) return "(empty response)";

  let formatted = "";
  if (stderr.trim()) {
    formatted += `**Execution Log (stderr):**\n\`\`\`\n${stderr.trim()}\n\`\`\`\n\n`;
  }
  formatted += `**Final Response:**\n${output.response || "(empty)"}`;
  return formatted;
}

export function formatAgyResponseForMCP(
  result: string | AgyOutput,
  stderr?: string,
  responseMode: ResponseMode = "clean",
): string {
  const parsed =
    typeof result === "string" ? parseAgyOutput(result, stderr) : result;
  if (responseMode === "full") return formatAgyResponseFull(parsed);
  return parsed.response || "(empty response)";
}

export function extractCodeBlocks(text: string): string[] {
  const re = /```[\s\S]*?```/g;
  return text.match(re) || [];
}

export function extractDiffBlocks(text: string): string[] {
  const re = /```diff[\s\S]*?```/g;
  return text.match(re) || [];
}

export function isErrorResponse(output: AgyOutput | string): boolean {
  const keywords = [
    "error",
    "failed",
    "unable",
    "cannot",
    "authentication",
    "permission denied",
    "rate limit",
    "quota exceeded",
  ];
  const text =
    typeof output === "string"
      ? output.toLowerCase()
      : output.response.toLowerCase();
  return keywords.some((k) => text.includes(k));
}
