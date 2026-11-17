/** Host calls only after the Run has ended and durable receipts have been retained elsewhere. */
export function releaseToolReceipts(ledger,{scope,runId}) {
  if(!(ledger instanceof Map) || typeof scope!=='string' || !scope || typeof runId!=='string' || !runId) {
    throw new TypeError('A Host ledger and exact scope/Run identity are required');
  }
  const selected=[];
  for(const [key,entry] of ledger) {
    let identity;try {identity=JSON.parse(key);}catch {continue;}
    if(!Array.isArray(identity) || identity[0]!==scope || identity[1]!==runId)continue;
    if(entry?.status!=='completed')throw new Error('Pending or unknown tool outcomes require reconciliation before cleanup');
    selected.push(key);
  }
  for(const key of selected)ledger.delete(key);
  return {removed:selected.length,remaining:ledger.size};
}
