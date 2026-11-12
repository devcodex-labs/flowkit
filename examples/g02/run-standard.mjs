/**
 * Maintainer helper: execute the G02 workflow through Standard run().
 * This is not a native secure Host and does not call a live model API.
 * Agent payloads are the recorded Grok / scripted fixtures.
 */
import {run, isControlSignal, evalWhen} from '../../src/index.mjs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const workflow = fileURLToPath(new URL('./feature-review.workflow.js', import.meta.url));
const success = JSON.parse(await readFile(new URL(
  '../../tests/fixtures/g02/turns-success-retry.json', import.meta.url), 'utf8'));
const rejected = JSON.parse(await readFile(new URL(
  '../../tests/fixtures/g02/turns-review-false.json', import.meta.url), 'utf8'));
const request = success.request;
const skillsRoot = path.join(repoRoot, 'examples/g02/skills');

function validate(schema, output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return ['Agent result must be object'];
  const props = schema.properties ?? {};
  const required = schema.required ?? Object.keys(props);
  for (const key of required) if (!Object.hasOwn(output, key)) return ['missing ' + key];
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(output)) if (!Object.hasOwn(props, key)) return ['unknown ' + key];
  }
  for (const [key, spec] of Object.entries(props)) {
    if (!Object.hasOwn(output, key)) continue;
    if (typeof output[key] !== spec.type) return [key + ' must be ' + spec.type];
    if (spec.type === 'string' && output[key].length < 80) return [key + ' must be at least 80 characters'];
  }
  return [];
}

function runtime(plan, label) {
  const calls = [];
  return {
    calls,
    isControlSignal,
    evalWhen,
    validateResult: validate,
    async runAgent(step) {
      const result = plan(step);
      calls.push({scenario: label, id: step.id, attempt: step.attempt, keys: Object.keys(result)});
      return result;
    },
  };
}

const results = [];
const successRuntime = runtime((step) => {
  if (step.id === 'analyze') return success.turns[0].result;
  if (step.id === 'design') return success.turns[1].result;
  if (step.id === 'review' && step.attempt === 1) return success.turns[2].result;
  if (step.id === 'review' && step.attempt === 2) return success.turns[3].result;
  throw new Error('unexpected ' + step.id);
}, 'success-with-retry');
results.push({
  layer: 'standard',
  scenario: 'success-with-retry',
  result: await run(workflow, successRuntime, {materialsReady: true, request, hostSecret: 'CANARY'},
    {skillsRoot, projectRoot: repoRoot}),
  calls: successRuntime.calls,
});

const gateRuntime = runtime(() => { throw new Error('gate-false must not call runAgent'); }, 'gate-false');
results.push({
  layer: 'standard',
  scenario: 'gate-false',
  result: await run(workflow, gateRuntime, {materialsReady: false, request, hostSecret: 'CANARY'},
    {skillsRoot, projectRoot: repoRoot}),
  calls: gateRuntime.calls,
});

const rejectRuntime = runtime((step) => {
  if (step.id === 'analyze') return rejected.turns[0].result;
  if (step.id === 'design') return rejected.turns[1].result;
  if (step.id === 'review') return rejected.turns[2].result;
  throw new Error('unexpected ' + step.id);
}, 'review-false');
results.push({
  layer: 'standard',
  scenario: 'review-false',
  result: await run(workflow, rejectRuntime, {materialsReady: true, request, hostSecret: 'CANARY'},
    {skillsRoot, projectRoot: repoRoot}),
  calls: rejectRuntime.calls,
});

const summary = results.map((item) => ({
  layer: item.layer,
  scenario: item.scenario,
  status: item.result.status,
  terminal: item.result.terminal,
  reviewApproved: item.result.state.reviewApproved ?? null,
  agentCalls: item.calls,
  evidenceNote: 'Standard run() via Node. Not native secure Host provenance. Not N-PASS.',
}));
console.log(JSON.stringify(summary, null, 2));
