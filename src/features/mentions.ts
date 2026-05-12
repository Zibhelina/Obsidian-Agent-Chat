export interface ParsedMentionOccurrence {
  tokenStart: number;
  tokenEnd: number;
  path: string;
  label?: string;
}

/**
 * Canonical inline mention syntax used by the composer:
 *   @[Display Name](vault/path.md)
 *
 * The editor stores that plain text verbatim so undo/redo, copy/paste,
 * persistence, and context bundle parsing remain transparent. `]`, `)`, and
 * backslashes are escaped with `\` inside the textual token.
 */
export function formatInlineMention(label: string, path: string): string {
  return `@[${escapeMentionLabel(label)}](${escapeMentionPath(path)})`;
}

export function parseMentions(text: string): string[] {
  const paths: string[] = [];
  for (const mention of parseMentionOccurrences(text)) {
    if (mention.path && !paths.includes(mention.path)) paths.push(mention.path);
  }
  return paths;
}

export function parseMentionOccurrences(text: string): ParsedMentionOccurrence[] {
  const mentions: ParsedMentionOccurrence[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "@") {
      i++;
      continue;
    }

    const markdownMention = parseMarkdownMentionAt(text, i);
    if (markdownMention) {
      mentions.push(markdownMention);
      i = markdownMention.tokenEnd;
      continue;
    }

    const quotedMention = parseQuotedMentionAt(text, i);
    if (quotedMention) {
      mentions.push(quotedMention);
      i = quotedMention.tokenEnd;
      continue;
    }

    const simpleMention = parseSimpleMentionAt(text, i);
    if (simpleMention) {
      mentions.push(simpleMention);
      i = simpleMention.tokenEnd;
      continue;
    }

    i++;
  }
  return mentions;
}

function escapeMentionLabel(label: string): string {
  return label.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function escapeMentionPath(path: string): string {
  return path
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function parseMarkdownMentionAt(text: string, start: number): ParsedMentionOccurrence | null {
  if (text[start + 1] !== "[") return null;
  const label = readEscapedUntil(text, start + 2, "]");
  if (!label || text[label.end] !== "(") return null;
  const path = readEscapedUntil(text, label.end + 1, ")");
  if (!path) return null;
  return {
    tokenStart: start,
    tokenEnd: path.end + 1,
    label: label.value,
    path: path.value,
  };
}

function parseQuotedMentionAt(text: string, start: number): ParsedMentionOccurrence | null {
  if (text[start + 1] !== '"') return null;
  const path = readEscapedUntil(text, start + 2, '"');
  if (!path) return null;
  return {
    tokenStart: start,
    tokenEnd: path.end + 1,
    path: path.value,
  };
}

function parseSimpleMentionAt(text: string, start: number): ParsedMentionOccurrence | null {
  const prev = start > 0 ? text[start - 1] : "";
  if (prev && /[^\s([{:;,]/.test(prev)) return null;
  const next = text[start + 1] ?? "";
  if (!next || /[\s@["]/.test(next)) return null;

  let end = start + 1;
  while (end < text.length && !/\s|@/.test(text[end])) end++;
  const path = text.slice(start + 1, end);
  if (!path) return null;
  return {
    tokenStart: start,
    tokenEnd: end,
    path,
  };
}

function readEscapedUntil(
  text: string,
  start: number,
  terminator: string
): { value: string; end: number } | null {
  let value = "";
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      if (i + 1 >= text.length) return null;
      value += text[i + 1];
      i++;
      continue;
    }
    if (ch === terminator) return { value, end: i };
    value += ch;
  }
  return null;
}
