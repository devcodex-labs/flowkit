import assert from 'node:assert/strict';
import { runAuthorExample } from './host.mjs';
assert.deepEqual(await runAuthorExample(), { fixture: true, status: 'candidate-ready', files: ['SKILL.md', 'workflow.js', 'workflow.mmd'], standalone: 'done', published: false });
