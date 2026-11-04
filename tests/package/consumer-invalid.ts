import { defineWorkflow, action } from '@devcodex/flowkit/dsl';
import { main } from '@devcodex/flowkit/cli';
defineWorkflow({ id: 'invalid', version: '1.0.0', name: 'Invalid', nodes: [action('a', { name: 'A', action: 'save', next: 'missing' })] });
void main;
