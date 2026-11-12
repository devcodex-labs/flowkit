import {defineWorkflow,condition,node,terminal} from '@devcodex-labs/flowkit/dsl';

// P0-A only. Actual ChatGPT turn outputs come from successive published
// Pending tasks, not prerecorded answers from a simulated LLM.
export default defineWorkflow({
  id:'c01-live-chatgpt-complex',
  version:'1.0.0',
  name:'C01/C03 live complex model acceptance',
  nodes:[
    condition('gate',{
      name:'Verify start permission',
      branches:[
        {when:'ready',next:'requirements'},
        {when:'true',next:'declined'},
      ],
    }),
    node('requirements',{
      name:'Requirements analysis',
      agent:'requirements',
      inputs:['request'],
      output:{type:'object',properties:{requirementSummary:{type:'string'}}},
      retries:0,next:'architecture',
    }),
    node('architecture',{
      name:'Architecture design',
      agent:'architecture',
      inputs:['requirementSummary'],
      output:{type:'object',properties:{designSummary:{type:'string'}}},
      retries:0,next:'implementation',
    }),
    node('implementation',{
      name:'Implementation plan',
      agent:'implementation',
      inputs:['designSummary'],
      output:{type:'object',properties:{executionPlan:{type:'string'}}},
      retries:0,next:'review',
    }),
    node('review',{
      name:'Independent review',
      agent:'review',
      inputs:['executionPlan'],
      output:{
        type:'object',
        properties:{
          reviewApproved:{type:'boolean'},
          reviewNotes:{type:'string'},
        },
      },
      retries:1,
      next:'decision',
    }),
    condition('decision',{
      name:'Review decision',
      branches:[
        {when:'reviewApproved',next:'done'},
        {when:'true',next:'declined'},
      ],
    }),
    terminal('done',{name:'Accepted',status:'succeeded'}),
    terminal('declined',{name:'Declined',status:'failed'}),
  ],
});
