// Frozen bench fixture — a minimal MCP stdio server (bench/SPEC.md §1, L4).
//
// It declares exactly 64 tools with short names (t00…t63) so the lever bench can
// measure the deferred-tool listing weight under ENABLE_TOOL_SEARCH. Bare node,
// no dependencies, and it opens NO network connection: the whole protocol runs
// over newline-delimited JSON-RPC on stdin/stdout. Do NOT add tools — the count
// (64) is a calibrated fixture constant.

import process from 'node:process';
import readline from 'node:readline';

const TOOL_COUNT = 64;

/** The 64 frozen tool descriptors: short names, one-line descriptions. */
const TOOLS = Array.from({ length: TOOL_COUNT }, (_, i) => {
  const id = String(i).padStart(2, '0');
  return {
    name: `t${id}`,
    description: `bench stub tool ${id} — returns a fixed string, does nothing`,
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: [],
    },
  };
});

/** Write one JSON-RPC message as a single newline-delimited line to stdout. */
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/** Dispatch one parsed JSON-RPC request; notifications (no id) get no reply. */
function handle(msg) {
  const { id, method } = msg;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'bench-stub', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: 'ok' }], isError: false },
    });
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  // Any other request gets a method-not-found error; notifications are ignored.
  if (!isNotification) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return; // ignore unparseable input
  }
  handle(msg);
});
