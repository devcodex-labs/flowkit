import {defineWorkflow,condition,node,terminal} from '@devcodex-labs/flowkit/dsl';

export default defineWorkflow({
  id:'s13-chatgpt-tool-bridge',
  version:'0.1.0',
  name:'ChatGPT 实际工具链 S13 验证',
  nodes:[
    condition('gate',{
      name:'确定进入审核节点',
      branches:[
        {when:'ready',next:'review'},
        {when:'true',next:'rejected'},
      ],
    }),
    node('review',{
      name:'分析 FlowKit 运行边界',
      agent:'reviewer',
      inputs:['request','constraints'],
      output:{
        type:'object',
        properties:{
          summary:{type:'string'},
          nextAction:{type:'string'},
          flowkitBoundary:{type:'string'},
        },
      },
      retries:0,
      next:'done',
    }),
    terminal('done',{name:'工作流成功',status:'succeeded'}),
    terminal('rejected',{name:'未满足进入条件',status:'failed'}),
  ],
});
