// Shared render-layer formatting primitives — no I/O, no wall clock.
//
// Every renderer (`report`, `cache`, `isolate`) escapes the same attacker-shaped
// strings and groups the same numbers, so both helpers live here once rather than
// being re-derived per command (three drifting copies of the escape table is how a
// missed entity ships).

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
