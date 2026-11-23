import type { ReactNode } from 'react';

const KEYWORDS = new Set(
  (
    'select from where join left right inner outer full cross on as and or not in is null ' +
    'case when then else end with group by order having limit distinct union all coalesce ' +
    'nullif cast over partition row_number count min max sum avg asc desc exists between like'
  ).split(' '),
);

// Comments, quoted strings, words and everything else, in that order.
const TOKEN = /(--[^\n]*)|('(?:[^']|'')*')|([A-Za-z_][A-Za-z0-9_]*)|([^A-Za-z_'-]+|-|')/g;

function highlight(sql: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let index = 0;
  for (const match of sql.matchAll(TOKEN)) {
    const [text, comment, quoted, word] = match;
    const key = index++;
    if (comment) {
      parts.push(
        <span key={key} className="text-muted-foreground italic">
          {text}
        </span>,
      );
    } else if (quoted) {
      parts.push(
        <span key={key} className="text-muted-foreground">
          {text}
        </span>,
      );
    } else if (word && KEYWORDS.has(word.toLowerCase())) {
      parts.push(
        <span key={key} className="font-semibold text-primary">
          {text}
        </span>,
      );
    } else {
      parts.push(text);
    }
  }
  return parts;
}

/** A read-only, scrollable SQL block with light keyword highlighting (theme tokens only). */
export function SqlCode({ sql, label }: { sql: string; label: string }) {
  return (
    <pre
      tabIndex={0}
      aria-label={label}
      className="max-h-96 overflow-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <code>{highlight(sql)}</code>
    </pre>
  );
}
