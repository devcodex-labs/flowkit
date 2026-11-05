import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from '@devcodex/flowkit';
import { createRuntime, validateExample } from './host.mjs';
import { exampleAgent } from './agent.mjs';

/** Run deterministic adapters. These functions do not call a model or publish an article. */
export async function demo({ remote = false, reviewOk = true, rejectOnce = false, qualityPassAfter = 1 } = {}) {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const events = []; let approvals = 0, checks = 0;
  const runtime = createRuntime({
    agent: async step => {
      events.push(`agent:${step.id}`);
      return exampleAgent(step, { reviewOk });
    },
    validate: validateExample,
    approve: async (_name, ctx) => {
      events.push('human');
      if (rejectOnce && approvals++ === 0) return { approved: false, comment: '请补充例子' };
      return { approved: true, comment: null };
    },
    verify: async () => { events.push('verify'); return ++checks >= qualityPassAfter; },
    act: async (action, _name, ctx) => {
      events.push(action);
      if (action === 'prepare') ctx.state.evidence = '固定演示证据';
      if (action === 'repair' || action === 'revise') ctx.state.draft += '；已修订';
      if (!['prepare', 'repair', 'revise', 'publish'].includes(action)) throw new Error(`Unexpected action: ${action}`);
    },
  });
  // Reserved example host: transport returns the exact checked-in bytes, without opening a server.
  const fetch = async url => {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://skills.example.test' || !['/style.md', '/fact.md'].includes(parsed.pathname)) throw new Error('Unexpected remote Skill');
    return new Response(await readFile(new URL(`skills${parsed.pathname}`, import.meta.url)));
  };
  const result = await run(fileURLToPath(new URL(remote ? 'remote.workflow.js' : 'editorial.workflow.js', import.meta.url)),
    runtime, { topic: '工作流', draft: '输入草稿', evidence: '固定演示证据' },
    { projectRoot: root, ...(remote ? { remoteSkillHosts: ['skills.example.test'], fetch } : {}) });
  return { result, events };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await demo({ remote: process.argv.includes('--remote') }), null, 2));
}
