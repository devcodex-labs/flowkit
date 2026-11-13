import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execve} from 'node:process';

const [uid,gid,exe,...args]=process.argv.slice(2);
assert.equal(process.platform,'linux');
assert.equal(typeof execve,'function','Node with process.execve is required for the Linux handoff');
assert.equal(process.getuid(),Number(uid));
assert.equal(process.getgid(),Number(gid));
const groups=process.getgroups();
assert.ok(groups.every(group=>group===Number(gid)));
const status=readFileSync('/proc/self/status','utf8');
const capabilities=status.match(/^CapEff:\s*(\S+)/m)?.[1];
const noNewPrivs=status.match(/^NoNewPrivs:\s*(\S+)/m)?.[1];
assert.match(capabilities,/^0+$/);
assert.equal(noNewPrivs,'1');
process.stdout.write(JSON.stringify({method:'flowkit/profile/identity',
  params:{uid:Number(uid),gid:Number(gid),groups,capabilities,noNewPrivs,pid:process.pid}})+'\n',()=>{
  execve(exe,[exe,...args],process.env);
});
