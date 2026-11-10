import {
  compileInteractive,createInteractiveCoordinator,createSqliteCheckpointStore,loadInteractiveProgram,
} from '../../types/interactive.js';
import type {
  InteractiveRuntime, InteractiveProgramIdentity, InteractiveRunFrame, CheckpointStore,
  InteractiveCompileOptions,
} from '../../types/interactive.js';

const options: InteractiveCompileOptions={output:'memory',featureStage:'P0-A'};
const compiled=compileInteractive('flow.workflow.ts',options);
declare const artifact: InteractiveProgramIdentity;
declare const bytes: Uint8Array;
const loader=loadInteractiveProgram(bytes,artifact.artifactHash);
const store: CheckpointStore=createSqliteCheckpointStore('test.db',{namespace:'tenant'});
const runtime: InteractiveRuntime={
  skillResolver:async d=>d.name,
  validateResult:(_schema,_result)=>[],
};
const coordinator=createInteractiveCoordinator({store,runtime,maxStagesPerCall:8,policy:{bindingVersion:1}});
const start: Promise<InteractiveRunFrame>=coordinator.start({
  programBytes:bytes,programIdentity:artifact,startKey:'job-1',state:{},
});
const finish=coordinator.complete({runId:'r',requestId:'request',nodeId:'n',attempt:1,result:{answer:'ok'}});
const resume: Promise<InteractiveRunFrame>=coordinator.resume({runId:'r'});
void [compiled,loader,start,finish,resume];
// @ts-expect-error featureStage must be only P0-A
compileInteractive('x',{output:'memory',featureStage:'P0-B'});
// @ts-expect-error validators remain synchronous
const asyncValidator: NonNullable<InteractiveRuntime['validateResult']>=async()=>[];
// @ts-expect-error no checkStep until P0-B
const unsupported: InteractiveRuntime={checkStep:()=>null};
// @ts-expect-error required durable idempotency key
coordinator.start({programBytes:bytes,programIdentity:artifact});
// @ts-expect-error correct attempt required on complete
coordinator.complete({runId:'r',requestId:'q',nodeId:'n',result:{}});
