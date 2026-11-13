import assert from 'node:assert/strict';
import test from 'node:test';
import {createOsToolObservations} from '../security/codex-os-tool-observations.mjs';

const turn={threadId:'thread',turnId:'turn'};
const args={requestId:'request',answer:'ready'};
const tool='flowkit_submit';
const start=(id,input=args)=>({...turn,item:{id,tool,arguments:input}});
const callback=(callId,input=args)=>({...turn,callId,tool,arguments:input});

test('OS-bound tool calls require a matching start recorded before the callback',()=>{
  const observations=createOsToolObservations();
  assert.equal(observations.consume(callback('missing')),null);
  observations.record(start('missing'));
  assert.equal(observations.consume(callback('missing')),null);

  observations.record(start('different',{...args,answer:'other'}));
  assert.equal(observations.consume(callback('different')),null);

  observations.record(start('valid'));
  assert.deepEqual(observations.consume(callback('valid',{answer:'ready',requestId:'request'})),
    {...turn,tool,arguments:args});
  assert.equal(observations.consume(callback('valid')),null);
});

test('observation state belongs to one turn and preserves the first start',()=>{
  const observations=createOsToolObservations();
  observations.record(start('call'));
  observations.record(start('call',{...args,answer:'other'}));
  assert.deepEqual(observations.consume(callback('call')),{...turn,tool,arguments:args});

  observations.record(start('other-turn'));
  assert.equal(observations.consume({...callback('other-turn'),turnId:'different'}),null);
  const next=createOsToolObservations();
  next.record(start('call'));
  assert.ok(next.consume(callback('call')));
});
