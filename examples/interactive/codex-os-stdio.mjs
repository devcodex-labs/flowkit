const maxCommandBytes=4096;

async function* commands(input) {
  const line=Buffer.alloc(maxCommandBytes);
  let length=0,oversize=false;
  for await (const data of input) {
    const chunk=Buffer.isBuffer(data)?data:Buffer.from(data);
    for (const byte of chunk) {
      if (byte===10) {
        yield oversize?null:line.subarray(0,length).toString('utf8');
        length=0;
        oversize=false;
      } else if (length<line.length) line[length++]=byte;
      else oversize=true;
    }
  }
}

/** Attach one already authenticated, private OS session to the Host. */
export async function serveCodexOsSession({access,identity,input,output,dispatch}) {
  const session=access.bind(identity);
  try {
    for await (const line of commands(input)) {
      let response;
      try {
        if (line===null) throw new Error('Invalid command');
        const command=JSON.parse(line);
        const {action,namespace}=command;
        access.authorize(session,action,namespace);
        const result=await dispatch(session,command);
        if (action==='result:read') access.authorize(session,action,namespace);
        response={ok:true,result};
      } catch {
        response={ok:false,code:'FK_I_HOST_DENIED'};
      }
      await new Promise((resolve,reject)=>output.write(JSON.stringify(response)+'\n',error=>error?reject(error):resolve()));
    }
  } finally {
    access.close(session);
  }
}
