import { defineWorkflow, parallel, node, terminal } from '@devcodex/flowkit/dsl';

export default defineWorkflow({
  id: 'remote-review', version: '1.0.0', name: 'Remote object reviewers',
  nodes: [
    parallel('reviews', { name: 'Remote review', branches: ['style', 'fact'], join: { strategy: 'all_succeeded', next: 'done' } }),
    node('style', { name: 'Remote style', skill: 'https://skills.example.test/style.md', integrity: 'sha256-GVdESIiHGUAdgUwF8wkh3HmX5deMlNBOUtZXJWVTaW4=', inputs: ['draft'],
      output: { type: 'object', properties: { styleOk: { type: 'boolean' }, styleNotes: { type: 'string' } },
        required: ['styleOk', 'styleNotes'], additionalProperties: false } }),
    node('fact', { name: 'Remote facts', skill: 'https://skills.example.test/fact.md', integrity: 'sha256-fV11WZrr2/bGq4tr8OR83tj29m/FKwzao9ga6FHx7wg=', inputs: ['draft', 'evidence'],
      output: { type: 'object', properties: { factOk: { type: 'boolean' }, factNotes: { type: 'string' } },
        required: ['factOk', 'factNotes'], additionalProperties: false } }),
    terminal('done', { name: 'Reviewed', status: 'succeeded' }),
  ],
});
