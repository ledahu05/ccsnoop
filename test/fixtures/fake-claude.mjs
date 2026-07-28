#!/usr/bin/env node
// A stand-in for the `claude` binary, so the bench's steps 11–21 can be tested
// without spending a token. Behaviour is switched by `CCSNOOP_FAKE_MODE`:
//
//   (unset)  live run — writes a synthetic two-turn session dir, exits 0
//   silent   exits 0 having captured NOTHING (the dangerous silent failure)
//   noinit   emits stream-json with no system/init event (settings rejected)
//   notools  emits a system/init event declaring zero tools
//   hang     never exits (the timeout path)
//
// `--version` and the `--output-format stream-json` pre-flight are recognised
// regardless of mode.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const mode = process.env.CCSNOOP_FAKE_MODE ?? '';

// `node --test` discovers everything under test/ (**/test/**/*.mjs) and would
// otherwise EXECUTE this stub as a test file. Every real call carries `-p` or
// `--version`; anything else is the test runner, and does nothing.
const isMcpList = argv[0] === 'mcp' && argv[1] === 'list';
if (!argv.includes('-p') && !argv.includes('--version') && !isMcpList) process.exit(0);

if (isMcpList) {
  // Step 11b's instrument. `mcppending` reproduces the failure that shipped a
  // lever-less witness: a project-scoped server never approved under `-p`.
  const status =
    mode === 'mcppending' ? '⏸ Pending approval (run `claude` to approve)' : '✔ Connected';
  process.stdout.write('Checking MCP server health…\n\n');
  process.stdout.write(`stub: node ./mcp-stub.mjs - ${status}\n`);
  process.exit(0);
}

if (argv.includes('--version')) {
  process.stdout.write('2.1.220 (Claude Code)\n');
  process.exit(0);
}

if (mode === 'hang') {
  setInterval(() => {}, 1000); // never resolves; the caller's timeout must fire
} else if (argv.includes('--output-format')) {
  // Step 11's pre-flight. Against a dead port the real binary emits system/init
  // and then exits non-zero on the failed POST — reproduce both.
  if (mode !== 'noinit') {
    const tools = mode === 'notools' ? [] : ['Bash', 'Read', 'Edit', 'Glob', 'Grep', 'Workflow'];
    process.stdout.write(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'fake-preflight',
        tools,
        mcp_servers: [{ name: 'stub', status: 'connected' }],
      }) + '\n',
    );
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error' }) + '\n');
  process.exit(1);
} else if (mode === 'silent') {
  process.exit(0); // exit 0, nothing captured
} else {
  writeSyntheticSession();
  process.exit(0);
}

/** Write the two-turn session dir the proxy would have written. */
function writeSyntheticSession() {
  const sessionId = 'fake-0000-1111-2222';
  const dir = path.join(process.cwd(), '.ccsnoop', 'sessions', sessionId);
  fs.mkdirSync(dir, { recursive: true });

  const lines = [];
  for (const turn of [1, 2]) {
    const stem = String(turn).padStart(4, '0');
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      system: [{ type: 'text', text: 'You are Claude Code.' }],
      tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }],
      messages:
        turn === 1
          ? [{ role: 'user', content: 'Read the file FIXED.txt and reply with only its first word.' }]
          : [
              { role: 'user', content: 'Read the file FIXED.txt and reply with only its first word.' },
              { role: 'assistant', content: 'SNOOPWORD' },
            ],
    });
    const head =
      `POST /v1/messages HTTP/1.1\r\n` +
      `Host: api.anthropic.com\r\n` +
      `content-type: application/json\r\n` +
      `authorization: ‹REDACTED›\r\n\r\n`;
    fs.writeFileSync(path.join(dir, `${stem}.request.http`), head + body);

    // Gzipped SSE — the raw `1f 8b` magic is what step 18's guard reads.
    const sse =
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: turn === 1 ? 10 : 8,
            output_tokens: 0,
            cache_read_input_tokens: turn === 1 ? 0 : 29367,
            cache_creation_input_tokens: turn === 1 ? 29367 : 142,
          },
        },
      })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        usage: { output_tokens: turn === 1 ? 103 : 51 },
        delta: { stop_reason: 'end_turn' },
      })}\n\n`;
    fs.writeFileSync(path.join(dir, `${stem}.response.sse`), zlib.gzipSync(Buffer.from(sse, 'utf8')));

    lines.push(
      JSON.stringify({
        turn,
        request_received_at: `2026-07-26T10:0${turn}:00.000Z`,
        response_completed_at: `2026-07-26T10:0${turn}:08.412Z`,
        parent_session_id: null,
        thread_id: sessionId,
        request_blob: `${stem}.request.http`,
        response_blob: `${stem}.response.sse`,
      }),
    );
  }
  fs.writeFileSync(path.join(dir, 'manifest.jsonl'), lines.join('\n') + '\n');
}
