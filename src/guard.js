// Shared writer guard — the `.ccsnoop/` capture-tree refusal.
//
// Two writers now need this: `ccsnoop apply` (settings) and `ccsnoop skill install`
// (the skill artifact). The check is identical — capture data is inviolable
// (ADR-0004; spec §1.3) — so it lives once here rather than cloned in each writer.
// Each caller supplies the Error subclass it throws and a noun for the message, so
// the failure still reads as coming from the surface that raised it.

import path from 'node:path';

/**
 * Refuse a path inside a `.ccsnoop/` capture tree. A `.ccsnoop` path segment
 * anywhere in the resolved path means we are about to write into capture data.
 * @param {string} file
 * @param {new (msg: string) => Error} ErrorCtor
 * @param {string} noun  What is being written, for the message (e.g. "settings").
 */
export function assertNotUnderCcsnoop(file, ErrorCtor, noun) {
  if (path.resolve(file).split(path.sep).includes('.ccsnoop')) {
    throw new ErrorCtor(`refusing to write ${noun} under .ccsnoop/ (capture data) — ${file}`);
  }
}
