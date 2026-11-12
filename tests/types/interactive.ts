import {
  compileInteractive,createInteractiveCoordinator,createSqliteCheckpointStore,loadInteractiveProgram,
} from '../../types/interactive.js';
import type {
  InteractiveRuntime, InteractiveProgramIdentity, InteractiveRunFrame, CheckpointStore,
  InteractiveCompileOptions,
} from '../../types/interactive.js';

const options: InteractiveCompileOptions={
  output:'memory',featureStage:'P0-A',
  projectRoot:'project',skillsRoot:'skills',skillCheck:true,
  remoteSkillHosts:['skills.example.test'],
};
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
// A shared Standard Host's checkStep is a valid declaration; the Interactive
// Coordinator rejects it only when a P0-A Agent Program would silently skip it.
const sharedRuntime:InteractiveRuntime={checkStep:()=>null};
void sharedRuntime;
// @ts-expect-error required durable idempotency key
coordinator.start({programBytes:bytes,programIdentity:artifact});
// @ts-expect-error correct attempt required on complete
coordinator.complete({runId:'r',requestId:'q',nodeId:'n',result:{}});


import {
  createTrustedInteractiveHost,createAgentReceiptStatement,encodeAgentReceiptStatement,
  normalizeHostAgentReceipt,
} from '../../types/interactive.js';
import type {
  HostAgentReceipt,HostAgentAttestation,PublicInteractiveAgentTask,PublicInteractiveTerminalFrame,
  TrustedInteractiveHostOptions,
} from '../../types/interactive.js';

declare const signingPublicKey:unknown;
const trustedOptions:TrustedInteractiveHostOptions={
  store,runtime,
  trustedPublicKeys:{'transport-v1':signingPublicKey},
  trustedArtifacts:[artifact.artifactHash],
  disclosurePolicyId:'tenant-approved-fields-v1',
  allowedInputKeys:['message'],
  authorizeDisclosure:async evidence=>evidence.task.kind==='agent',
  authorizeTerminalAccess:context=>context.action==='run:read',
};
const trusted=createTrustedInteractiveHost(trustedOptions);
const publicTask:Promise<PublicInteractiveAgentTask|null>=
  trusted.getPublicAgentTask({runId:'r'});
const publicTerminal:Promise<PublicInteractiveTerminalFrame>=trusted.getPublicTerminalFrame({runId:'r'});
void publicTerminal.then(frame=>{
  // @ts-expect-error public projections omit private State
  void frame.state;
  return trusted.readTrustedTerminalResult({resultRef:frame.resultRef});
});
const receipt:HostAgentReceipt={
  kind:'agent-result',runId:'r',requestId:'q',nodeId:'n',attempt:1,result:{answer:'ok'},
};
const statement=createAgentReceiptStatement({
  run:{namespace:'n',artifactHash:artifact.artifactHash,policyHash:'sha256:'+'a'.repeat(64)},
  receipt,keyId:'transport-v1',proofId:'receipt-1',issuedAt:1,expiresAt:2,
});
const bytesToSign:Uint8Array=encodeAgentReceiptStatement(statement);
declare const attestation:HostAgentAttestation;
const verified=trusted.accept({receipt:normalizeHostAgentReceipt(receipt),attestation});
void [trustedOptions,publicTask,bytesToSign,verified];
// @ts-expect-error a model string cannot replace the signed Host attestation
trusted.accept({receipt,attestation:'approval-123'});
// @ts-expect-error no low-level complete() method on the trusted Host facade
trusted.complete(receipt);
// @ts-expect-error Human is not in the M5 P0-A receipt union
const fakeHuman:HostAgentReceipt={kind:'human',runId:'r',requestId:'q',nodeId:'h',attempt:1,result:{approved:true}};
// @ts-expect-error proof bytes require canonical attestation field set
encodeAgentReceiptStatement({domain:'flowkit.host-agent-receipt.v1'});
void fakeHuman;
