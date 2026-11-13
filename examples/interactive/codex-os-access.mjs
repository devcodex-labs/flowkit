const denied=()=>Object.assign(new Error('Host request denied'),{code:'FK_I_HOST_DENIED'});
const validIdentity=process.platform==='win32'?/^S-1-5-(?:\d+-)+\d+$/:/^[1-9]\d*$/;
const validNamespace=/^[a-zA-Z0-9_-]{1,64}$/;

/** The provisioner must obtain each identity from the OS and keep the map Host-private. */
export function createCodexOsAccess(bindings) {
  const policy=new Map();
  const issued=new WeakSet();
  for (const {identity,namespace,role} of bindings) {
    if (typeof identity!=='string' || !validIdentity.test(identity) || typeof namespace!=='string'
      || !validNamespace.test(namespace) || !['operator','auditor'].includes(role) || policy.has(identity)) {
      throw new TypeError('Invalid or duplicate OS identity mapping');
    }
    policy.set(identity,Object.freeze({identity,namespace,role}));
  }
  return Object.freeze({
    bind(identity) {
      const grant=policy.get(identity);
      if (!grant) throw denied();
      const session=Object.freeze({...grant});
      issued.add(session);
      return session;
    },
    authorize(session,action,namespace) {
      if (!issued.has(session) || session.namespace!==namespace) throw denied();
      if ((session.role==='operator' && ['run:create','task:dispatch','run:complete'].includes(action))
        || (session.role==='auditor' && action==='result:read')) return true;
      throw denied();
    },
  });
}
