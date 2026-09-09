export type ChatSubmissionPostResult = {
  ok: boolean;
  report: string;
  accepted?: boolean;
};

export type ChatSubmissionFallback = {
  content: string;
  isError: boolean;
};

/**
 * The chat stream is preferred, but the submission POST is also durable evidence
 * that Chef accepted or rejected the request. Keep that evidence user-visible
 * when the SSE acknowledgement is delayed or missed.
 */
export function chatSubmissionFallback(result: ChatSubmissionPostResult): ChatSubmissionFallback | null {
  const report = result.report.trim();
  if (!result.ok) {
    return {
      content: report || "I couldn't start that work yet. Please try again.",
      isError: true,
    };
  }
  if (report) return { content: report, isError: false };
  if (result.accepted) return { content: "Got it. I’m starting this now.", isError: false };
  return null;
}

/** Avoid replaying the same acknowledgement when POST fallback and SSE race. */
export function assistantContentSeenSinceLastUser(
  messages: Array<{ role: string; content: string }>,
  content: string,
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return false;
    if (message.role === "assistant" && message.content === content) return true;
  }
  return false;
}
