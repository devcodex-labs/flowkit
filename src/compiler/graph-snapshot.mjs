import {readFileSync} from 'node:fs';
import {canonicalBytes,sha256Bytes} from '../interactive/canonical.mjs';
import {interactiveModeForStage} from '../interactive/protocol.mjs';
import {artifactDigest} from '../shared/artifact-identity.mjs';
import {workflowContract} from '../shared/workflow-contract.mjs';

// An omitted annotation or literal value may contain internal instructions or credentials.
function publicSchema(schema) {
  const {title:_title,description:_description,const:constant,enum:choices,items,properties,...constraints}=schema;
  return {...constraints,
    ...(constant===undefined?{}:{constRedacted:true}),
    ...(choices===undefined?{}:{enumCount:choices.length}),
    ...(items===undefined?{}:{items:publicSchema(items)}),
    ...(properties===undefined?{}:{properties:Object.fromEntries(Object.entries(properties)
      .map(([name,field])=>[name,publicSchema(field)]))}),
  };
}

export const definitionDigest = definition => artifactDigest(JSON.stringify(definition));
export const compilerVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
export const graphContentHash = content => sha256Bytes(canonicalBytes(content,8*1024*1024));

function freezeData(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

/** Project the same immutable analysis used by Program and Mermaid emission. */
export function projectGraph(analysis,mode) {
  const {literal,graph,dataflow,snapshot}=analysis;
  const {definition,locations}=literal;
  const indices=new Map(definition.nodes.map(({id},index)=>[id,index]));
  const contract=workflowContract(definition.contract);
  const initialKeys=new Set(Object.keys(contract?.input?.properties??{}));
  function inputSource(nodeId,key) {
    if (!dataflow.inputs.get(nodeId).has(key)) return initialKeys.has(key)?'declared':'unknown';
    // The compiler reserves a Human's decision key and the engine writes it before taking a successor.
    if (nodeId!==key && graph.byId.get(key)?.type==='human' && graph.dominators.get(nodeId).has(key)) return 'inferred';
    return 'conditional';
  }
  const memberships=new Map(definition.nodes.map(({id})=>[id,[]]));
  const regions=[...graph.regions.values()].map(region=>{
    const owner=graph.byId.get(region.id);
    const scopes=graph.subflowBranches.get(owner.id);
    const lanes=owner.type==='parallel' ? owner.branches.map(entry=>({entry,memberIds:[...(scopes?.get(entry)??[entry])].sort()})) : [];
    const memberIds=lanes.length ? [...new Set(lanes.flatMap(lane=>lane.memberIds))].sort() : [...region.members].sort();
    for (const id of memberIds) memberships.get(id).push(owner.id);
    const normalExits=owner.type==='parallel'?[owner.join.next]
      :owner.type==='loop'?[owner.onSuccess,owner.onMaxExceeded]:[owner.onApprove,...(owner.onDecline?[owner.onDecline]:[])];
    return {ownerId:owner.id,kind:region.kind,entry:owner.type==='loop'?owner.body:owner.id,memberIds,normalExits,
      ...(lanes.length?{lanes,branchMode:owner.branchMode??'leaf',joinStrategy:owner.join.strategy}:{}),
    };
  });
  const nodes=definition.nodes.map((node,index)=>{
    const sourcePath='/nodes/'+index;
    const location=locations.get(sourcePath);
    const inputs=(node.inputs??node.reads??[]).map(key=>({key,source:inputSource(node.id,key)}));
    return {id:node.id,type:node.type,name:node.name,sourcePath,line:location.line,column:location.column,
      ownerIds:memberships.get(node.id),inputs,outputs:[...graph.writeSets.get(node.id)].sort(),
      ...((node.action??node.verifier)!==undefined?{capabilityId:node.action??node.verifier}:{}),
      ...Object.fromEntries(['status','maxIterations','maxRevisions','retries','effect'].filter(key=>Object.hasOwn(node,key))
        .map(key=>[key,node[key]])),
    };
  });
  const key=edge=>JSON.stringify([edge.from,edge.to,edge.role,edge.path]);
  const declared=new Set(graph.referenceEdges.map(key));
  function edges(list,layer) {
    return list.map(edge=>{
      const sourcePath='/nodes/'+indices.get(edge.from)+edge.path;
      const {from,to,role}=edge;
      const branch=edge.role==='condition-branch'?Number(edge.path.split('/')[2]):null;
      const condition=branch===null ? undefined : graph.byId.get(from).branches[branch].when;
      return {edgeId:artifactDigest(layer+':'+key(edge)),from,to,role,sourcePath,
        origin:declared.has(key(edge))?'declared':'derived',
        ...(condition===undefined?{}:{priority:branch,condition:condition.replace(/'[^']*'/g,"'…'")}),
      };
    });
  }
  return {schemaVersion:1,compilerVersion,mode,workflowId:definition.id,workflowVersion:definition.version,
    name:definition.name,entryNodeId:definition.nodes[0].id,
    sourceHash:'sha256:'+snapshot.sourceHash,definitionDigest:definitionDigest(definition),
    nodes,regions,referenceEdges:edges(graph.referenceEdges,'reference'),executionEdges:edges(graph.executionEdges,'execution'),
    helpers:regions.filter(region=>region.kind==='parallel').flatMap(({ownerId})=>
      [{kind:'parallel-start',ownerId},{kind:'parallel-join',ownerId}]),
    ...(contract?{contract:{validator:contract.validator,digest:contract.digest,
      ...(contract.input?{input:publicSchema(contract.input)}:{}),
      ...(contract.output?{output:publicSchema(contract.output),outputKeys:Object.keys(contract.output.properties).sort()}:{}),
    }}:{}),
  };
}

export function sealGraphSnapshot(structure,artifactHash) {
  const content = {...structure,artifactHash};
  return freezeData({...content,graphDigest:graphContentHash(content)});
}

export function verifyGraphSnapshot(snapshot,program) {
  const {graphDigest,...content}=snapshot;
  const {artifactHash,...structure}=content;
  if (structure.schemaVersion!==1 || graphDigest!==graphContentHash(content)
    || artifactHash!==program.artifactHash || structure.mode!==interactiveModeForStage(program.implementedStage)
    || graphContentHash(structure)!==program.graphStructureHash
    || ['sourceHash','workflowId','workflowVersion','compilerVersion'].some(key=>structure[key]!==program[key])) {
    throw new TypeError('Graph snapshot differs from the compiled workflow identity');
  }
  return freezeData(snapshot);
}
