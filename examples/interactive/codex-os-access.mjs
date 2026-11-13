const denied=()=>Object.assign(new Error('Host request denied'),{code:'FK_I_HOST_DENIED'});
const validIdentity=process.platform==='win32'?/^S-1-5-(?:\d+-)+\d+$/:/^[1-9]\d*$/;
const validNamespace=/^[a-zA-Z0-9_-]{1,64}$/;

/** The provisioner must obtain each identity from the OS and keep the map Host-private. */
export function createCodexOsAccess(bindings) {
  function policyFrom(entries) {
    const result=new Map();
    for (const {identity,namespace,role} of entries) {
      if (typeof identity!=='string' || !validIdentity.test(identity) || typeof namespace!=='string'
        || !validNamespace.test(namespace) || !['operator','auditor'].includes(role) || result.has(identity)) {
        throw new TypeError('Invalid or duplicate OS identity mapping');
      }
      const prior=policy.get(identity);
      result.set(identity,prior?.namespace===namespace && prior.role===role
        ?prior:Object.freeze({identity,namespace,role}));
    }
    return result;
  }
  let policy=new Map();
  const issued=new WeakMap();
  policy=policyFrom(bindings);
  return Object.freeze({
    bind(identity) {
      const grant=policy.get(identity);
      if (!grant) throw denied();
      const session=Object.freeze({...grant});
      issued.set(session,grant);
      return session;
    },
    close(session) {issued.delete(session);},
    replaceBindings(entries) {policy=policyFrom(entries);},
    authorize(session,action,namespace) {
      const grant=issued.get(session);
      if (!grant || policy.get(grant.identity)!==grant || grant.namespace!==namespace) throw denied();
      if ((session.role==='operator' && ['run:create','task:dispatch','run:complete'].includes(action))
        || (session.role==='auditor' && action==='result:read')) return true;
      throw denied();
    },
  });
}
