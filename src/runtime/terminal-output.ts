/**
 * Keep terminal transcripts bounded while preserving the newest output.
 * A marker makes it explicit that the beginning of a noisy command was omitted.
 */
export const MAX_TERMINAL_OUTPUT_CHARS = 256 * 1024;
const TRUNCATION_MARKER = "[Earlier terminal output omitted; showing the latest output.]";
const RETAINED_OUTPUT_CHARS = MAX_TERMINAL_OUTPUT_CHARS - TRUNCATION_MARKER.length - 1;

export interface TerminalOutputBuffer {
  text: string;
  truncated: boolean;
}

export function appendTerminalOutput(
  buffer: TerminalOutputBuffer,
  chunk: string,
): TerminalOutputBuffer {
  if (chunk.length === 0) return buffer;
  if (chunk.length > RETAINED_OUTPUT_CHARS) {
    return { text: chunk.slice(-RETAINED_OUTPUT_CHARS), truncated: true };
  }

  const combined = buffer.text + chunk;
  if (combined.length <= RETAINED_OUTPUT_CHARS) {
    return { text: combined, truncated: buffer.truncated };
  }
  return { text: combined.slice(-RETAINED_OUTPUT_CHARS), truncated: true };
}

export function formatTerminalOutput(buffer: TerminalOutputBuffer): string {
  return buffer.truncated ? `${TRUNCATION_MARKER}\n${buffer.text}` : buffer.text;
}
