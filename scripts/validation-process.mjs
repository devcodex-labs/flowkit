import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

/** Run trusted validation commands, terminating their process tree before resolving a timeout. */
export function runProcess(executable, args, { cwd, env = process.env, timeout = 60000, maxBuffer = 2 * 1024 * 1024 } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }); }
    catch (error) { resolve({ status: null, stdout: '', stderr: '', error }); return; }
    const stdout = [], stderr = []; let size = 0, failure;
    function terminate(error) {
      if (failure) return; failure = error;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        // Kill the waiting command shell together with its Node child, while that shell is still alive.
        const taskkill = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe');
        const killed = spawnSync(taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
        if (killed.status !== 0) child.kill('SIGKILL');
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
      }
    }
    const timer = setTimeout(() => terminate(Object.assign(new Error('Validation command timed out'), { code: 'ETIMEDOUT' })), timeout);
    const collect = target => chunk => {
      size += chunk.length;
      if (size > maxBuffer) terminate(Object.assign(new Error('Validation output exceeded its limit'), { code: 'ENOBUFS' }));
      else target.push(chunk);
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.on('error', error => { failure ??= error; });
    // close follows exit and waits for inherited stdio handles to close before temporary-file cleanup.
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ pid: child.pid, status, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), error: failure }); });
  });
}
