import {canonicalBytes} from '../../src/interactive/canonical.mjs';

/** Track trusted start events for one OS-bound model turn. */
export function createOsToolObservations() {
  const entries=new Map();
  return {
    record({threadId,turnId,item}) {
      if (!entries.has(item.id)) {
        entries.set(item.id,{threadId,turnId,tool:item.tool,arguments:item.arguments});
      }
    },
    consume({threadId,turnId,tool,callId,arguments:args}) {
      const started=entries.get(callId);
      // A callback without a trusted start cannot become valid later.
      entries.set(callId,null);
      if (!started || started.threadId!==threadId || started.turnId!==turnId || started.tool!==tool) return null;
      try {
        return canonicalBytes(started.arguments).equals(canonicalBytes(args))?started:null;
      } catch {
        return null;
      }
    },
  };
}

export function dispatchObservedOsTool(observations, callback, accept, onDenied) {
  const started = observations?.consume(callback);
  if (started) return accept(started);
  onDenied?.();
  return {accepted:false,code:'REQUEST_DENIED'};
}
