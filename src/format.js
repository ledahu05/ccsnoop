// Shared render-layer formatting primitives — no I/O, no wall clock.
//
// Every renderer (`report`, `cache`, `isolate`) escapes the same attacker-shaped
// strings and groups the same numbers, so both helpers live here once rather than
// being re-derived per command (three drifting copies of the escape table is how a
// missed entity ships). The same reasoning covers column fitting: every fixed-width
// table (`fine-tune`'s ranking, `verify`'s per-block delta) must keep its figures
// aligned when a label overruns, so that rule lives here once too.

const HTML_ENTITIES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

/**
 * Escape a value for HTML text/attribute context. Every interpolation into a rendered
 * document goes through here — a session id is a directory name, i.e. attacker-shaped input.
 * @param {unknown} s
 * @returns {string}
 */
export function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

/**
 * A number as a locale-stable, comma-grouped string (30874 → "30,874"; 18492.5 →
 * "18,492.5"). `toLocaleString` is avoided so the output is identical across Node
 * locales/icu builds — the renderers are asserted on for shape.
 * @param {number} n
 * @returns {string}
 */
export function fmtNum(n) {
  const rounded = Math.round((Number(n) || 0) * 100) / 100;
  const [int, dec] = String(rounded).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec ? `${grouped}.${dec}` : grouped;
}

/** Leading characters kept when a label is elided — enough to hold `CLAUDE.md /hom…`. */
export const ELIDE_HEAD = 14;

/**
 * A table label in EXACTLY `width` characters: padded when it fits, else middle-elided.
 * A CLAUDE.md source is an absolute path and routinely overruns its column; `padEnd`
 * alone would shove the figure columns right on precisely the rows a maintainer wants
 * to compare. Eliding the MIDDLE keeps both the kind prefix (`tool` / `MCP` /
 * `CLAUDE.md`) and the tail that identifies the entry (a basename).
 * @param {string} label
 * @param {number} width
 * @param {number} [head]  Leading characters kept before the ellipsis.
 * @returns {string}
 */
export function fitLabel(label, width, head = ELIDE_HEAD) {
  if (label.length <= width) return label.padEnd(width);
  // Too narrow to hold a head + ellipsis + tail: a hard truncation is all that fits.
  if (width <= head + 1) return label.slice(0, width);
  const tail = width - head - 1; // 1 for the ellipsis
  return `${label.slice(0, head)}…${label.slice(label.length - tail)}`;
}
