/**
 * Flatten and neutralize fragments that can break Markdown structure when
 * interpolated into list items, notes, or table cells (e.g. open-response text).
 */
export function sanitizeMarkdownFragment(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|')
    .replace(/^([#>\-+*])/u, '\\$1');
}

/** Locale-stable integer formatting for report scores. */
export function formatScore(score: number): string {
  const n = Math.trunc(score);
  const abs = Math.abs(n).toString();
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${withCommas}` : withCommas;
}
