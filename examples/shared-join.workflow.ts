import { defineWorkflow, action, condition, terminal } from '@devcodex/flowkit/dsl';

export default defineWorkflow({
  id: 'shared-join', version: '1.0.0', name: 'Shared join',
  nodes: [
    condition('choose', { name: 'Choose path', branches: [
      { when: 'urgent', next: 'fast' }, { when: 'true', next: 'normal' },
    ] }),
    action('fast', { name: 'Fast path', action: 'fast', next: 'save' }),
    action('normal', { name: 'Normal path', action: 'normal', next: 'save' }),
    action('save', { name: 'Save once', action: 'save', next: 'done' }),
    terminal('done', { name: 'Saved', status: 'succeeded' }),
  ],
} as const);
