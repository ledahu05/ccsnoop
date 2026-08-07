// Fine-tune: the byte-accounted gain model — `shipped` + `waste` per lever
// (fine-tune-spec Part 5, issue #76 / FT6).
//
// Two byte figures per lever, both byte-lengths via the same proxy the rest of
// fine-tune uses (Segment.bytes — never re-tokenized, spec §2.4b):
//
//   • shipped — the gross bytes the lever contributes: what travels on the wire on
//     each request it appears in. A lever's content is static (re-shipped every
//     request), so its canonical size is the MAX single-request byte total across
//     the session — robust to a truncated/aborted final turn, which would otherwise
//     shrink the figure.
//
//   • waste  — the reused-uncached portion: the bytes actually RE-PAID after a
//     cache break. This is the classification waste.js already computes per segment
//     (`.kind === 'reused-uncached'`); the gain model only attributes those bytes to
//     a lever. Like `shipped` it is the MAX single-request re-payment (the worst turn
//     after a cache break), so `waste ≤ shipped` always and the headline stays a
//     per-request "what you'd stop re-paying" figure, not a cumulative total.
//
// Headline recoverable = Σ `waste` over the ACTIONABLE levers (denied tools, MCP
// under the T4 guard, above-floor hooks, excludable-above-floor CLAUDE.md). The
// harness floor is shown for context but is incompressible — never recoverable.
//
// Attribution. Built-in tools are segments `tool:<name>` (attributed straight from
// the slot, no body re-parse). The `system` levers ride `system[]` blocks AND, under
// `-p`, the first user message's content blocks (bench/SPEC.md §4 — the FT0 fixture
// confirms hook + CLAUDE.md + MCP land in `messages[0]`, not `system[]`). Each such
// block is carved by FT3's `classifySystemSpans` (the single source of "which lever
// owns which bytes of this block", issue #116) and each span charged to its lever — a
// block may hold several, since the deferred listing, its connecting-servers sub-list
// and the skills/agent catalogs can share one `<system-reminder>`. The spans tile the
// block, so every byte is charged exactly once. A block's re-payment is its CARRIER
// segment's `.kind` — a `system#<i>` block carries itself, content blocks inside
// `messages[<m>]` share the `message#<m>` carrier. Plain conversation content (an
// unmatched message block) is NOT the harness floor — only `system[]` blocks are —
// so a user prompt is never mistaken for incompressible harness bytes.

import { parseRequestBlob } from './report.js';
import { classifySystemSpans, isCatalogLever } from './finetune-system.js';
import { NULL_SOURCE } from './finetune-levers.js';

/**
 * Map key standing in for a CLAUDE.md source with no extractable path (managed /
 * unattributable). Re-exported from `finetune-levers.js` rather than redeclared: the
 * renderer looks each lever verdict up in this module's maps, so the two placeholders
 * MUST be the same byte — one definition makes that structural, not a coincidence.
 */
export { NULL_SOURCE } from './finetune-levers.js';

/**
 * @typedef {object} LeverGain
 * @property {number} shipped  Max single-request byte total this lever entry contributes.
 * @property {number} waste    Max single-request reused-uncached byte total (re-paid after a cache break).
 */

/**
 * @typedef {object} GainModel
 * @property {Map<string, LeverGain>} tool       Per built-in tool name → shipped/waste.
 * @property {Map<string, LeverGain>} claudeMd   Per CLAUDE.md source (path, or `NULL_SOURCE`) → shipped/waste.
 * @property {LeverGain} hook                    SessionStart hook output.
 * @property {LeverGain} mcp                     The MCP connecting-servers sub-list of the deferred listing.
 * @property {Map<import('./finetune-system.js').CatalogLever, LeverGain>} catalog
 *                                               Per catalog population (deferred tools / agent types /
 *                                               skills) → shipped/waste. Split out of `mcp` by #116:
 *                                               these bytes used to be charged wholesale to the MCP
 *                                               lever (the deferred listing) or dropped as conversation.
 * @property {LeverGain} harness                 The incompressible harness floor (`system[]` preamble).
 */

/** An all-zero gain — the no-op input when a session ships nothing the model sees. */
export const EMPTY_GAIN = /** @type {GainModel} */ ({
  tool: new Map(),
  claudeMd: new Map(),
  hook: { shipped: 0, waste: 0 },
  mcp: { shipped: 0, waste: 0 },
  catalog: new Map(),
  harness: { shipped: 0, waste: 0 },
});

/** @returns {LeverGain} */
function zero() {
  return { shipped: 0, waste: 0 };
}

/**
 * The `system#<i>` / `message#<m>` carrier slot a block rides, so its `.kind` can be
 * looked up in the request's classified segments. `system[i]` carries itself; every
 * content block inside `messages[m]` shares the `message#<m>` carrier (waste.js
 * segments at message granularity, not per content block).
 * @param {'system' | 'message'} surface
 * @param {number} index
 * @returns {string}
 */
function carrierSlot(surface, index) {
  return surface === 'system' ? `system#${index}` : `message#${index}`;
}

/**
 * Roll a per-request charge map into the running maxes (shipped/waste per entry).
 * @param {Map<string, { shipped: number, waste: number }>} req
 * @param {Map<string, LeverGain>} roll
 */
function rollMax(req, roll) {
  for (const [key, r] of req) {
    let g = roll.get(key);
    if (!g) {
      g = zero();
      roll.set(key, g);
    }
    if (r.shipped > g.shipped) g.shipped = r.shipped;
    if (r.waste > g.waste) g.waste = r.waste;
  }
}

/**
 * The pure core of the gain model: attribute ONE parsed request body's levers and
 * fold them into the running aggregates (`acc`). Built-in tools come from the
 * classified `segments` (`tool:<name>`); the `system` levers come from walking the
 * body's text surfaces (`system[]` + `messages[*].content`), each block carved into
 * lever spans by `classifySystemSpans` and re-paid per its carrier segment's `.kind`.
 * Call once per exchange; `acc` keeps the cross-request MAXes. Exposed for direct unit tests.
 *
 * @param {{ segments: Array<{ slot: string, bytes: number, kind?: string }>, body: any }} exchange
 * @param {GainModel} acc  Mutated in place with this exchange's contribution.
 */
export function chargeExchange(exchange, acc) {
  const { segments, body } = exchange;
  /** slot → segment, for the carrier `.kind` lookup. */
  const segBySlot = new Map((segments ?? []).map((s) => [s.slot, s]));

  // Per-request charge maps/scalars (rolled into `acc`'s maxes at the end of the
  // exchange). A lever can appear in several blocks of one request (the harness floor
  // spans every `system[]` preamble block), so per-request is a SUM, then the cross-
  // request roll is a MAX — never a per-block max, which would drop the floor's tail.
  /** @type {Map<string, { shipped: number, waste: number }>} */
  const toolReq = new Map();
  /** @type {Map<string, { shipped: number, waste: number }>} */
  const claudeMdReq = new Map();
  /** @type {{ shipped: number, waste: number }} */
  const hookReq = { shipped: 0, waste: 0 };
  /** @type {{ shipped: number, waste: number }} */
  const mcpReq = { shipped: 0, waste: 0 };
  /** @type {Map<string, { shipped: number, waste: number }>} */
  const catalogReq = new Map();
  /** @type {{ shipped: number, waste: number }} */
  const harnessReq = { shipped: 0, waste: 0 };

  // Built-in tools — one segment per `tool:<name>`; attributed straight from the slot.
  for (const seg of segments ?? []) {
    if (typeof seg.slot !== 'string' || seg.slot.indexOf('tool:') !== 0) continue;
    const name = seg.slot.slice(5);
    if (name.length === 0 || name[0] === '#') continue; // anonymous tool — no name, no lever
    const waste = seg.kind === 'reused-uncached' ? seg.bytes : 0;
    let r = toolReq.get(name);
    if (!r) {
      r = { shipped: 0, waste: 0 };
      toolReq.set(name, r);
    }
    r.shipped += seg.bytes;
    r.waste += waste;
  }

  // The `system` levers — walk every text surface (system[] + messages content),
  // classify each block, and charge it to its lever. A block's re-payment is its
  // CARRIER segment's `.kind` (system#<i> carries itself; message content shares
  // message#<m>). Plain conversation (an unmatched message block) is NOT the harness
  // floor — only system[] blocks are — so a user prompt never becomes harness bytes.
  walkBodyBlocks(body, (block, surface, index) => {
    const carrier = segBySlot.get(carrierSlot(surface, index));
    const uncached = Boolean(carrier && carrier.kind === 'reused-uncached');

    // A block may carry SEVERAL levers — the deferred listing and its connecting-servers
    // sub-list ride one block, and a combined `<system-reminder>` can hold all three
    // catalogs. The shared classifier carves it into spans that TILE the block, so
    // charging span by span attributes every byte exactly once (issue #116).
    for (const span of classifySystemSpans(block)) {
      const bytes = span.bytes;
      const waste = uncached ? bytes : 0;

      if (span.lever === 'claude-md') {
        const key = span.source ?? NULL_SOURCE;
        let r = claudeMdReq.get(key);
        if (!r) {
          r = { shipped: 0, waste: 0 };
          claudeMdReq.set(key, r);
        }
        r.shipped += bytes;
        r.waste += waste;
      } else if (span.lever === 'hook') {
        hookReq.shipped += bytes;
        hookReq.waste += waste;
      } else if (span.lever === 'mcp-deferred') {
        mcpReq.shipped += bytes;
        mcpReq.waste += waste;
      } else if (isCatalogLever(span.lever)) {
        // A catalog population — charged on EITHER surface. These blocks ride
        // `messages[0].content`, so a surface guard would zero them out; unlike the
        // harness fallback they are positively identified by their own header, so
        // charging them is never mistaking conversation for config. Asking the shared
        // predicate (not `!== 'harness'`) is what keeps an eighth lever added later from
        // silently landing in the catalog bucket.
        let r = catalogReq.get(span.lever);
        if (!r) {
          r = { shipped: 0, waste: 0 };
          catalogReq.set(span.lever, r);
        }
        r.shipped += bytes;
        r.waste += waste;
      } else if (span.lever === 'harness' && surface === 'system') {
        // Only system[] preamble blocks are the harness floor; a message block that
        // merely fails to match a lever marker is conversation, not harness.
        harnessReq.shipped += bytes;
        harnessReq.waste += waste;
      }
    }
  });

  // Roll this request's sums into the running cross-request maxes.
  rollMax(toolReq, acc.tool);
  rollMax(claudeMdReq, acc.claudeMd);
  rollMax(catalogReq, acc.catalog);
  for (const [req, roll] of /** @type {[{shipped:number,waste:number}, LeverGain][]} */ ([
    [hookReq, acc.hook],
    [mcpReq, acc.mcp],
    [harnessReq, acc.harness],
  ])) {
    if (req.shipped > roll.shipped) roll.shipped = req.shipped;
    if (req.waste > roll.waste) roll.waste = req.waste;
  }
}

/**
 * Visit every text surface of a request body — `system[]` (indexed, for the
 * `system#<i>` carrier) and every `messages[*].content` block (indexed by message,
 * for the `message#<m>` carrier) — handing each to `fn(block, surface, index)`.
 * Mirrors the surface walk `finetune-mcp.js` / `finetune-levers.js` use.
 *
 * @param {any} body  Parsed request JSON.
 * @param {(block: any, surface: 'system' | 'message', index: number) => void} fn
 */
function walkBodyBlocks(body, fn) {
  if (!body || typeof body !== 'object') return;
  const sys = body.system;
  const sysBlocks = Array.isArray(sys) ? sys : sys == null ? [] : [sys];
  sysBlocks.forEach((block, i) => fn(block, 'system', i));

  const msgs = Array.isArray(body.messages) ? body.messages : [];
  msgs.forEach((m, mi) => {
    if (!m || typeof m !== 'object') return;
    const c = m.content;
    if (Array.isArray(c)) c.forEach((block) => fn(block, 'message', mi));
    else fn(c, 'message', mi); // a bare-string message content
  });
}

/**
 * The byte-accounted gain model of one loaded session: `shipped` + `waste` per lever
 * (spec Part 5). Re-parses each exchange's request body from its captured blob (the
 * model keeps `requestBlob`, not the parsed JSON) so `system` blocks can be classified
 * by source; tool bytes come straight from the classified `segments`.
 *
 * Pure given the model — no I/O (the blobs are already in memory). Degrades, never
 * throws, on a body that fails to parse (an aborted exchange): it contributes no
 * `system`-lever bytes, while its `tool:` segments still charge.
 *
 * @param {{ exchanges?: Array<{ segments?: any[], requestBlob?: string }> }} model
 * @returns {GainModel}
 */
export function computeGain(model) {
  /** @type {GainModel} */
  const acc = {
    tool: new Map(),
    claudeMd: new Map(),
    hook: zero(),
    mcp: zero(),
    catalog: new Map(),
    harness: zero(),
  };
  for (const ex of model?.exchanges ?? []) {
    const body = parseRequestBlob(ex?.requestBlob ?? '').json;
    chargeExchange({ segments: ex?.segments ?? [], body }, acc);
  }
  return acc;
}
