export function decodeHtmlEntities(text: string) {
  if (!text) return text;
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function normalizeInlineCodeFences(text: string) {
  if (!text || typeof text !== 'string') return text;
  try {
    return text.replace(/```\s*([^\n\r]+?)\s*```/g, '`$1`');
  } catch {
    return text;
  }
}

// remark-math intentionally recognizes dollar delimiters, while Codex and
// Claude commonly emit the equivalent LaTeX \(...\) and \[...\] forms. Convert
// those forms before Markdown parsing, but leave literal examples inside code
// spans/fences untouched.
export function normalizeLatexDelimiters(text: string) {
  if (!text || typeof text !== 'string') return text;

  const codeSegments: string[] = [];
  const protectedText = text.replace(/(`+)[\s\S]*?\1/g, (segment) => {
    const token = `CCUI_CODE_SEGMENT_${codeSegments.length}_TOKEN`;
    codeSegments.push(segment);
    return token;
  });

  const normalized = protectedText
    .replace(
      /^([ \t]*>[ \t]*)\\{1,2}\[[ \t]*\n([\s\S]*?)^[ \t]*>[ \t]*\\{1,2}\][ \t]*$/gm,
      (_match, prefix: string, formula: string) => {
        const quotedFormula = formula
          .replace(/\n$/, '')
          .split('\n')
          .map((line) => line.replace(/^[ \t]*>[ \t]?/, ''))
          .map((line) => `${prefix}${line}`)
          .join('\n');
        return `${prefix}$$\n${quotedFormula}\n${prefix}$$`;
      },
    )
    .replace(/\\{1,2}\[([\s\S]*?)\\{1,2}\]/g, (_match, formula: string) =>
      `\n\n$$\n${formula.trim()}\n$$\n\n`,
    )
    .replace(/\\{1,2}\(([\s\S]*?)\\{1,2}\)/g, (_match, formula: string) =>
      `$${formula.trim()}$`,
    );

  return normalized.replace(/CCUI_CODE_SEGMENT_(\d+)_TOKEN/g, (_match, index: string) =>
    codeSegments[Number(index)] ?? _match,
  );
}

export function unescapeWithMathProtection(text: string) {
  if (!text || typeof text !== 'string') return text;

  const protectedSegments: string[] = [];
  const placeholderPrefix = 'CCUI_PROTECTED_SEGMENT_';
  const placeholderSuffix = '__';
  const protect = (value: string, pattern: RegExp) => value.replace(pattern, (match) => {
    const index = protectedSegments.length;
    protectedSegments.push(match);
    return `${placeholderPrefix}${index}${placeholderSuffix}`;
  });

  // Protect code first, then every math delimiter supported by the chat
  // normalizer. Without this, the generic escaped-whitespace conversion turns
  // LaTeX commands such as \rm, \right, \nabla and \text into control chars.
  let processedText = protect(text, /(`+)[\s\S]*?\1/g);
  processedText = protect(
    processedText,
    /\$\$[\s\S]*?\$\$|\\{1,2}\[[\s\S]*?\\{1,2}\]|\\{1,2}\([\s\S]*?\\{1,2}\)|\$[^$\n]+?\$/g,
  );

  // A standalone literal "\r" is ambiguous with common LaTeX commands and
  // must never be decoded globally. Normalize only the complete CRLF escape;
  // ordinary escaped newlines/tabs remain supported for legacy messages.
  processedText = processedText
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');

  processedText = processedText.replace(
    new RegExp(`${placeholderPrefix}(\\d+)${placeholderSuffix}`, 'g'),
    (match, index) => {
      return protectedSegments[parseInt(index, 10)] ?? match;
    },
  );

  return processedText;
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatUsageLimitText(text: string) {
  try {
    if (typeof text !== 'string') return text;
    return text.replace(/Claude AI usage limit reached\|(\d{10,13})/g, (match, ts) => {
      let timestampMs = parseInt(ts, 10);
      if (!Number.isFinite(timestampMs)) return match;
      if (timestampMs < 1e12) timestampMs *= 1000;
      const reset = new Date(timestampMs);

      const timeStr = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(reset);

      const offsetMinutesLocal = -reset.getTimezoneOffset();
      const sign = offsetMinutesLocal >= 0 ? '+' : '-';
      const abs = Math.abs(offsetMinutesLocal);
      const offH = Math.floor(abs / 60);
      const offM = abs % 60;
      const gmt = `GMT${sign}${offH}${offM ? ':' + String(offM).padStart(2, '0') : ''}`;
      const tzId = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const cityRaw = tzId.split('/').pop() || '';
      const city = cityRaw
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase());
      const tzHuman = city ? `${gmt} (${city})` : gmt;

      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const dateReadable = `${reset.getDate()} ${months[reset.getMonth()]} ${reset.getFullYear()}`;

      return `Claude usage limit reached. Your limit will reset at **${timeStr} ${tzHuman}** - ${dateReadable}`;
    });
  } catch {
    return text;
  }
}
