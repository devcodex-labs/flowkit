import {types as nodeTypes} from 'node:util';
import {canonicalBytes,safeJSONSnapshot,sha256Bytes} from '../interactive/canonical.mjs';

export const WORKFLOW_CONTRACT_MARKER = '// @flowkit-contract ';
const validator = 'flowkit-json-schema-object-v1';
const maxSchemaBytes = 64 * 1024;
const maxOutputBytes = 64 * 1024;
const own = Object.hasOwn;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = value => value === null || ['boolean','number','string'].includes(typeof value);
const shared = ['type','title','description','enum','const'];
const keywords = {
  object:['properties','required','additionalProperties','minProperties','maxProperties'],
  array:['items','minItems','maxItems'],
  string:['minLength','maxLength'],
  integer:['minimum','maximum','exclusiveMinimum','exclusiveMaximum'],
  number:['minimum','maximum','exclusiveMinimum','exclusiveMaximum'],
  boolean:[], null:[],
};
const unsafeKey = key => ['__proto__','constructor','prototype'].includes(key);
const child = (path,key) => path+'/'+String(key).replaceAll('~','~0').replaceAll('/','~1');
const schemaError = (path,message) => Object.assign(new TypeError(message),{path});

function assertSchema(schema,path,output,depth=0) {
  if (depth>16 || !object(schema) || typeof schema.type!=='string' || !own(keywords,schema.type)) {
    throw schemaError(path,'Expected a supported typed Schema object at a depth of at most 16');
  }
  if (depth===0 && schema.type!=='object') throw schemaError(path,'Root schema must have type object');
  for (const [key,value] of Object.entries(schema)) {
    const at=child(path,key);
    if (!shared.includes(key) && !keywords[schema.type].includes(key)) {
      throw schemaError(at,`Unsupported workflow schema keyword: ${key}`);
    }
    if (['title','description'].includes(key) && typeof value!=='string') throw schemaError(at,'Expected a string');
    if (key==='enum' && (!Array.isArray(value) || !value.length || !value.every(scalar)
      || new Set(value).size!==value.length)) throw schemaError(at,'Expected unique scalar enum values');
    if (key==='const' && !scalar(value)) throw schemaError(at,'Expected a scalar const');
    if (['minLength','maxLength','minItems','maxItems','minProperties','maxProperties'].includes(key)
      && (!Number.isSafeInteger(value) || value<0)) throw schemaError(at,'Expected a nonnegative safe integer');
    if (['minimum','maximum','exclusiveMinimum','exclusiveMaximum'].includes(key) && !Number.isFinite(value)) {
      throw schemaError(at,'Expected a finite number');
    }
  }
  if (schema.type==='array') assertSchema(schema.items,child(path,'items'),output,depth+1);
  if (schema.type!=='object') return;
  const {properties,required,additionalProperties}=schema;
  if ((properties!==undefined || output) && !object(properties)) {
    throw schemaError(child(path,'properties'),'Expected an explicit properties object');
  }
  if ((additionalProperties!==undefined && typeof additionalProperties!=='boolean')
    || (output && depth>0 && additionalProperties!==false)) {
    throw schemaError(child(path,'additionalProperties'),'Expected a boolean and require false for nested output objects');
  }
  if (required!==undefined && (!Array.isArray(required) || required.some(key=>typeof key!=='string'||unsafeKey(key)
    || (output && !own(properties,key))) || new Set(required).size!==required.length)) {
    throw schemaError(child(path,'required'),'Expected unique required keys declared in output properties');
  }
  for (const [key,field] of Object.entries(properties??{})) {
    const at=child(child(path,'properties'),key);
    if (unsafeKey(key)) throw schemaError(at,'Unsafe schema property name');
    assertSchema(field,at,output,depth+1);
  }
}

/** Admit only schemas the same deterministic validator can enforce in both runtimes. */
export function workflowContract(definition) {
  if (definition===undefined) return undefined;
  let data;
  try {data=safeJSONSnapshot(definition,maxSchemaBytes);}
  catch {throw schemaError('/contract','Workflow contract must be bounded, plain JSON');}
  if (!object(data) || !Object.keys(data).length || Object.keys(data).some(key=>!['input','output'].includes(key))) {
    throw schemaError('/contract','Contract must contain input, output, or both');
  }
  for (const key of Object.keys(data)) assertSchema(data[key],'/contract/'+key,key==='output');
  return {...data,validator,digest:sha256Bytes(canonicalBytes({validator,...data},maxSchemaBytes+256))};
}

export function verifyWorkflowContract(metadata) {
  if (metadata===undefined) return undefined;
  const {validator:_validator,digest:_digest,...schemas}=metadata;
  const expected=workflowContract(schemas);
  if (!canonicalBytes(metadata).equals(canonicalBytes(expected))) {
    throw schemaError('/contract','Program contract validator or digest differs');
  }
  return expected;
}

const within = (length,min,max) => (min===undefined || length>=min) && (max===undefined || length<=max);

function matches(schema,value) {
  if (own(schema,'const') && value!==schema.const || schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case 'null': return value===null;
    case 'boolean': return typeof value==='boolean';
    case 'string': return typeof value==='string' && within([...value].length,schema.minLength,schema.maxLength);
    case 'integer':
    case 'number': return typeof value==='number' && (schema.type!=='integer' || Number.isInteger(value))
      && within(value,schema.minimum,schema.maximum)
      && (schema.exclusiveMinimum===undefined || value>schema.exclusiveMinimum)
      && (schema.exclusiveMaximum===undefined || value<schema.exclusiveMaximum);
    case 'array': return Array.isArray(value) && within(value.length,schema.minItems,schema.maxItems)
      && value.every(item=>matches(schema.items,item));
    case 'object': {
      if (!object(value) || schema.required?.some(key=>!own(value,key))) return false;
      const properties=schema.properties??{};
      const entries=Object.entries(value);
      return within(entries.length,schema.minProperties,schema.maxProperties) && entries.every(([key,item])=>
        own(properties,key)?matches(properties[key],item):schema.additionalProperties!==false);
    }
    default: return false;
  }
}

function validate(schema,value,code,label,limit) {
  const error=()=>Object.assign(new TypeError(`Workflow ${label} violates its declared contract`),{code});
  let snapshot;
  try {snapshot=safeJSONSnapshot(value,limit);}
  catch {throw error();}
  if (!matches(schema,snapshot)) throw error();
  return snapshot;
}

export function validateWorkflowInput(contract,state) {
  return contract?.input ? validate(contract.input,state,'FK_R008','input') : state;
}

export function projectWorkflowOutput(contract,state) {
  if (!contract?.output) return undefined;
  const invalid=()=>Object.assign(new TypeError('Workflow output violates its declared contract'),{code:'FK_R009'});
  if (!object(state) || nodeTypes.isProxy(state)) throw invalid();
  const entries=[];
  for (const key of Object.keys(contract.output.properties)) {
    const field=Object.getOwnPropertyDescriptor(state,key);
    if (!field) continue;
    if (!own(field,'value') || !field.enumerable) throw invalid();
    entries.push([key,field.value]);
  }
  return validate(contract.output,Object.fromEntries(entries),'FK_R009','output',maxOutputBytes);
}
