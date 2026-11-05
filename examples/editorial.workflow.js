import { defineWorkflow, node, action, parallel, condition, loop, verification, human, terminal } from '@devcodex/flowkit/dsl';

export default defineWorkflow({
  id: 'editorial', version: '1.0.0', name: 'Editorial approval',
  nodes: [
    action('prepare', { name: 'Prepare evidence', action: 'prepare', writes: ['evidence'], next: 'draft' }),
    node('draft', { name: 'Write article', skill: 'skills/writer.md', inputs: ['topic', 'evidence'],
      output: { type: 'object', properties: { draft: { type: 'string' } }, required: ['draft'], additionalProperties: false },
      retries: 1, overview: true, next: 'reviews' }),
    parallel('reviews', { name: 'Review article', branches: ['style', 'fact'], join: { strategy: 'all_succeeded', next: 'route' } }),
    node('style', { name: 'Style review', skill: 'skills/style.md', inputs: ['draft'],
      output: { type: 'object', properties: { styleOk: { type: 'boolean' }, styleNotes: { type: 'string' } },
        required: ['styleOk', 'styleNotes'], additionalProperties: false } }),
    node('fact', { name: 'Fact review', skill: 'skills/fact.md', inputs: ['draft', 'evidence'],
      output: { type: 'object', properties: { factOk: { type: 'boolean' }, factNotes: { type: 'string' } },
        required: ['factOk', 'factNotes'], additionalProperties: false } }),
    condition('route', { name: 'Choose review path', branches: [
      { when: 'styleOk && factOk', next: 'approval' }, { when: 'true', next: 'quality' },
    ] }),
    loop('quality', { name: 'Improve article', maxIterations: 3, body: 'quality-check', onSuccess: 'approval', onMaxExceeded: 'failed' }),
    verification('quality-check', { name: 'Check article', verifier: 'quality', onSuccess: 'quality', onFailure: 'repair' }),
    action('repair', { name: 'Repair review findings', action: 'repair', writes: ['draft'], next: 'quality-check' }),
    human('approval', { name: 'Approve article', onApprove: 'publish', onReject: 'revise' }),
    action('revise', { name: 'Apply human feedback', action: 'revise', writes: ['draft'], next: 'approval' }),
    action('publish', { name: 'Publish approved article', action: 'publish', next: 'done' }),
    terminal('done', { name: 'Published', status: 'succeeded' }),
    terminal('failed', { name: 'Quality limit reached', status: 'failed' }),
  ],
});
