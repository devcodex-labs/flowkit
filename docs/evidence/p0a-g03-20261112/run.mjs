// Capture raw streams from the actual Grok Build executable, with a bounded timeout.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const [exe, cwd, node = process.execPath, mode = 'untrusted', targetBytesText = '0'] = process.argv.slice(2);
const here = fileURLToPath(new URL('.', import.meta.url));
const dir = join(here, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(dir);
mkdirSync(cwd, { recursive: true });
const nonce = randomUUID(), rpc = join(dir,'mcp-rpc.ndjson'), gate = join(dir,'observed.gate');
const timeline = join(dir, 'observer.ndjson');
const event = (kind, fields = {}) => appendFileSync(timeline, JSON.stringify({ kind, at: Date.now(), monoNs: String(process.hrtime.bigint()), ...fields }) + '\n');
function invoke(label, args, observe) {
  return new Promise((resolveRun, reject) => {
    const stdout = join(dir,`${label}.stdout`), stderr = join(dir,`${label}.stderr`);
    writeFileSync(stdout,''); writeFileSync(stderr,'');
    const cp = spawn(exe,args,{ cwd, windowsHide: true, stdio:['ignore','pipe','pipe'] });
    event('spawn',{label, executable: exe, args, cwd, pid: cp.pid });
    let tail = '';
    // Pipe chunks are Buffers. Save the original bytes and decode a separate
    // copy incrementally for observation.
    const decoder = new TextDecoder();
    cp.stdout.on('data',chunk=>{
      appendFileSync(stdout, chunk);
      if (!observe) return;
      tail += decoder.decode(chunk, { stream: true });
      let cut;
      while ((cut=tail.indexOf('\n'))>=0) {
        const line=tail.slice(0,cut); tail=tail.slice(cut+1);
        try { observe(JSON.parse(line)); } catch (e) { event('observer-exception',{message:e.message}); }
      }
    });
    cp.stderr.on('data',chunk=>appendFileSync(stderr,chunk));
    const timer = setTimeout(()=>{event('timeout',{label,pid:cp.pid}); cp.kill();},35000);
    cp.on('error',e=>{clearTimeout(timer); reject(e);});
    cp.on('close',(code,signal)=>{clearTimeout(timer); event('exit',{label,code,signal}); resolveRun(code);});
  });
}
await invoke('01-version',['--version']);
await invoke('02-register',['mcp','add','--scope','project','flowkitg03','--',node,resolve(here,'probe.mjs'),rpc,gate,nonce]);
await invoke('03-discover',['mcp','list','--json']);
const trust = mode === 'untrusted' ? [] : ['--trust'];
await invoke('04-doctor',[...trust,'mcp','doctor','flowkitg03']);
const expected = { nonce, payload: 'flowkit-g03-synthetic' };
const targetBytes = Number(targetBytesText);
let file;
if (targetBytes) {
  const payload = [];
  for (let left=targetBytes-JSON.stringify({nonce,payload:[]}).length;left>3;) {
    const length = Math.min(65536,left-(payload.length ? 3 : 2));
    left -= length+(payload.length ? 3 : 2);
    payload.push(String.fromCharCode(65+payload.length%26).repeat(length));
  }
  expected.payload=payload;
  file = join(cwd,`arguments-${nonce}.json`);
  writeFileSync(file,JSON.stringify(expected));
}
const digest = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
event('fixture',{mode, targetBytes, bytes:Buffer.byteLength(JSON.stringify(expected)), digest, file});
let startId = null;
const target = mode === 'untrusted' ? 'flowkitg03_probe' : 'flowkitg03__probe';
const allow = mode === 'untrusted' ? ['--allow','mcp__flowkitg03__probe'] : ['--allow',`MCPTool(${target})`];
const invocation = file ? `Set tool_input_file to this exact absolute path: ${JSON.stringify(file)}. Do not use tool_input, read or retype the file.` : `tool_input must be ${JSON.stringify(expected)}.`;
await invoke('05-native', [...trust,'--no-subagents','--no-plan','--disable-web-search','--tools','list_dir','--permission-mode','dontAsk',...allow,'--max-turns','4','--output-format','streaming-json','-p',`This is a synthetic local tool capability test. Do not inspect files or use shell or other servers. Call ${target} with the native use_tool exactly once. ${invocation} Report the tool result.`], e=>{
  if (e.type === 'tool_call') {
    const wrapped = e.toolName === 'use_tool' && e.rawInput?.tool_name === target;
    const raw = wrapped ? e.rawInput.tool_input : undefined;
    const input = raw?.nonce===nonce && Object.keys(raw).length===2 ? JSON.stringify({nonce,payload:raw.payload}) : null;
    const observedDigest = input ? createHash('sha256').update(input).digest('hex') : null;
    const match = !!e.toolCallId && observedDigest===digest;
    event('tool-start',{ toolCallId:e.toolCallId, toolName:e.toolName, status:e.status, match, bytes:input?Buffer.byteLength(input):null, fileReference:!!e.rawInput?.tool_input_file, digest:observedDigest });
    if (match && !startId && mode!=='withhold') {
      startId=e.toolCallId;
      writeFileSync(gate,digest+'\n',{flag:'wx'});
      event('released',{ toolCallId:startId, digest });
    }
  } else if (e.type === 'tool_call_update') event('tool-update',{ toolCallId:e.toolCallId, status:e.status });
});
console.log(dir);
