// Synthetic stdio MCP endpoint. No FlowKit, credentials, receipt signer or network.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';
const [, , log, gate, nonce] = process.argv;
const record = (kind, fields = {}) => appendFileSync(log, JSON.stringify({ kind, at: Date.now(), pid: process.pid, ...fields }) + '\n');
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === 'initialize') {
    record('initialize', { protocolVersion: request.params?.protocolVersion });
    send(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'flowkitg03', version: '0.1.0' } });
  } else if (request.method === 'tools/list') {
    record('tools/list');
    send(request.id, { tools: [{ name: 'probe', description: 'Submit synthetic test data; waits for a separate observer to acknowledge seeing the CLI start event.', inputSchema: { type: 'object', properties: { nonce: { type: 'string' }, payload: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } }, required: ['nonce','payload'], additionalProperties: false } }] });
  } else if (request.method === 'tools/call' && request.params?.name === 'probe') {
    const args = request.params.arguments;
    const good = args?.nonce === nonce && Object.keys(args).length === 2 && (typeof args.payload === 'string' || (Array.isArray(args.payload) && args.payload.every(x=>typeof x==='string')));
    const canonical = good ? JSON.stringify({ nonce, payload: args.payload }) : '';
    const digest = good ? createHash('sha256').update(canonical).digest('hex') : null;
    record('tools/call', { rpcId: request.id, bytes: Buffer.byteLength(canonical), digest });
    const until = Date.now() + 4000;
    while (good && !existsSync(gate) && Date.now() < until) await setTimeout(20);
    const released = good && existsSync(gate) && readFileSync(gate,'utf8').trim() === digest;
    record('respond', { rpcId: request.id, released, digest });
    send(request.id, { isError: !released, content: [{ type: 'text', text: released ? `observed ${digest}` : 'probe gate closed; no native start match' }] });
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
  }
}
