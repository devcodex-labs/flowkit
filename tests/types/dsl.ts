import { defineWorkflow, node, action, verification, parallel, condition, loop, human, terminal } from '@devcodex/flowkit/dsl';
import type { DslNode } from '@devcodex/flowkit/dsl';

const flow = defineWorkflow({ id: 'all-nodes', version: '1.0.0', name: '全节点', nodes: [
  node('write', { name: '撰写', agent: 'writer', output: { type: 'object', properties: { text: { type: 'string' } }, $defs: { ok: true } }, next: 'gate' }),
  condition('gate', { name: '选择', branches: [{ when: 'true', next: 'fan' }] }),
  parallel('fan', { name: '并行', branches: ['inspect', 'touch'], join: { strategy: 'all_succeeded', next: 'repair' } }),
  verification('inspect', { name: '并行检查', verifier: 'lint' }),
  action('touch', { name: '并行动作', action: 'notify' }),
  loop('repair', { name: '循环', maxIterations: 100, body: 'check', onSuccess: 'approve', onMaxExceeded: 'failed' }),
  verification('check', { name: '验证', verifier: 'tests', onSuccess: 'repair', onFailure: 'fix' }),
  action('fix', { name: '修复', action: 'fix', next: 'check' }),
  human('approve', { name: '审批', onApprove: 'done', onReject: 'revise' }),
  node('revise', { name: '修订', skill: 'skills/revise.md', output: { type: 'object' }, next: 'approve' }),
  terminal('done', { name: '完成', status: 'succeeded' }), terminal('failed', { name: '失败', status: 'failed' }),
] });
const exactId: 'write' = flow.nodes[0].id;
const exactName: '撰写' = flow.nodes[0].name;
const exactSchema: 'string' = flow.nodes[0].output.properties.text.type;
void [exactId, exactName, exactSchema];
// @ts-expect-error 定义递归只读
flow.nodes[0].output.properties.text.type = 'number';
// @ts-expect-error 数组不可变
flow.nodes.push(terminal('x', { name: 'x', status: 'failed' }));

// @ts-expect-error next拼错
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', nodes: [action('a', { name: 'a', action: 'save', next: 'typo' }), terminal('end', { name: '结束', status: 'succeeded' })] });
// @ts-expect-error condition分支拼错
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', nodes: [condition('c', { name: 'c', branches: [{ when: 'true', next: 'typo' }] }), terminal('end', { name: '结束', status: 'succeeded' })] });
// @ts-expect-error join.next拼错
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', nodes: [parallel('p', { name: 'p', branches: ['a', 'b'], join: { strategy: 'any', next: 'typo' } }), action('a', { name: 'a', action: 'a' }), action('b', { name: 'b', action: 'b' })] });
// @ts-expect-error parallel成员引用拼错
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', nodes: [parallel('p', { name: 'p', branches: ['a', 'typo'], join: { strategy: 'any', next: 'end' } }), action('a', { name: 'a', action: 'a' }), terminal('end', { name: '结束', status: 'succeeded' })] });
// @ts-expect-error parallel成员不能next
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', nodes: [parallel('p', { name: 'p', branches: ['a', 'b'], join: { strategy: 'any', next: 'end' } }), action('a', { name: 'a', action: 'a', next: 'end' }), node('b', { name: 'b', agent: 'b', output: { type: 'object' } }), terminal('end', { name: '结束', status: 'succeeded' })] });
// @ts-expect-error parallel verification成员不能带后继
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', nodes: [parallel('p', { name: 'p', branches: ['a', 'b'], join: { strategy: 'any', next: 'end' } }), verification('a', { name: 'a', verifier: 'v', onSuccess: 'end' }), action('b', { name: 'b', action: 'b' }), terminal('end', { name: '结束', status: 'succeeded' })] });
// @ts-expect-error terminal不是合法parallel成员类型
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', nodes: [parallel('p', { name: 'p', branches: ['a', 'end'], join: { strategy: 'any', next: 'end' } }), action('a', { name: 'a', action: 'a' }), terminal('end', { name: '结束', status: 'succeeded' })] });
// @ts-expect-error 普通action缺next
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', nodes: [action('a', { name: 'a', action: 'a' })] });
// @ts-expect-error 普通verification缺失败去向
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', nodes: [verification('v', { name: 'v', verifier: 'v', onSuccess: 'v' })] });
// @ts-expect-error loop.body必须verification
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', nodes: [loop('l', { name: 'l', maxIterations: 1, body: 'end', onSuccess: 'end', onMaxExceeded: 'end' }), terminal('end', { name: '结束', status: 'succeeded' })] });
// @ts-expect-error loop去向拼错
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', nodes: [loop('l', { name: 'l', maxIterations: 1, body: 'v', onSuccess: 'typo', onMaxExceeded: 'end' }), verification('v', { name: 'v', verifier: 'v', onSuccess: 'l', onFailure: 'v' }), terminal('end', { name: '结束', status: 'succeeded' })] });
// @ts-expect-error human驳回拼错
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', nodes: [human('h', { name: 'h', onApprove: 'end', onReject: 'typo' }), terminal('end', { name: '结束', status: 'succeeded' })] });
// @ts-expect-error 空工作流
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', nodes: [] });
// @ts-expect-error workflow未知字段
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', start: 'end', nodes: [terminal('end', { name: '结束', status: 'succeeded' })] });
// @ts-expect-error 节点未知字段
action('a', { name: 'a', action: 'save', budget: 1 });
// @ts-expect-error 必须有agent或skill
node('a', { name: 'a', output: { type: 'object' } });
// @ts-expect-error output必须object schema
node('a', { name: 'a', agent: 'a', output: { type: 'string' } });
// @ts-expect-error retries超范围
node('a', { name: 'a', agent: 'a', output: { type: 'object' }, retries: 11 });
// @ts-expect-error inputs不能null
node('a', { name: 'a', agent: 'a', output: { type: 'object' }, inputs: null });
// @ts-expect-error iterations零非法
loop('l', { name: 'l', maxIterations: 0, body: 'v', onSuccess: 'e', onMaxExceeded: 'e' });
// @ts-expect-error iterations超过100
loop('l', { name: 'l', maxIterations: 101, body: 'v', onSuccess: 'e', onMaxExceeded: 'e' });
// @ts-expect-error 错误终态
terminal('t', { name: 't', status: 'ok' });
// @ts-expect-error 并行至少两个成员
parallel('p', { name: 'p', branches: ['one'], join: { strategy: 'any', next: 'end' } });

// @ts-expect-error 不能靠显式第二个诊断对象绕过错误引用
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', nodes: [action('a', { name: 'a', action: 'save', next: 'missing' })] }, { __unknownNodeReferences: 'missing' });
// @ts-expect-error 不能靠第二个诊断对象绕过普通节点缺next
defineWorkflow({ id: 'x', version: '1.0.0', name: 'x', nodes: [action('a', { name: 'a', action: 'save' })] }, { __invalidNodeContext: 'a' });
// @ts-expect-error 固定join对象不接受拼错的额外字段
parallel('p', { name: 'p', branches: ['a', 'b'], join: { strategy: 'any', next: 'end', stratgey: 'any' } });
// @ts-expect-error 固定condition branch对象不接受额外字段
condition('c', { name: 'c', branches: [{ when: 'true', next: 'end', nex: 'end' }] });

// 动态id只能保留结构类型；不存在的动态引用由M1编译期C015检测。
const dynamicNodes: readonly DslNode[] = flow.nodes;
defineWorkflow({ id: 'dynamic', version: '1.0.0', name: '动态', nodes: dynamicNodes });
