const MAX_SESSION_DATA_BYTES = 32 * 1024;

export interface BoundedSessionData {
  data: string;
  truncated: boolean;
  originalBytes: number;
}

/**
 * Retain the newest UTF-8-safe portion of a PTY chunk for durable replay.
 * The original byte count lets callers surface that truncation happened.
 */
export function boundSessionData(text: string, maxBytes = MAX_SESSION_DATA_BYTES): BoundedSessionData {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }

  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) {
    return { data: text, truncated: false, originalBytes };
  }

  let start = text.length;
  let bytes = 0;
  while (start > 0) {
    const codePoint = text.codePointAt(start - 1);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    start -= character.length;
  }

  return { data: text.slice(start), truncated: true, originalBytes };
}

export { MAX_SESSION_DATA_BYTES };
