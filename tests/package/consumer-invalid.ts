import { defineWorkflow, action } from '@devcodex-labs/flowkit/dsl';
import { main } from '@devcodex-labs/flowkit/cli';
defineWorkflow({ id: 'invalid', version: '1.0.0', name: 'Invalid', nodes: [action('a', { name: 'A', action: 'save', next: 'missing' })] });
void main;
