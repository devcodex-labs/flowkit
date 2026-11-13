import {appendFileSync} from 'node:fs';
import {createServer} from 'node:http';

const [receiptFile]=process.argv.slice(2);
const server=createServer(async(req,res)=>{
  if (req.method!=='POST' || req.url!=='/capacity') {res.writeHead(404).end();return;}
  try {
    let body='';
    for await (const part of req) {
      body+=part;
      if (body.length>4096) {res.writeHead(413).end();return;}
    }
    const event=JSON.parse(body);
    const receipt={receiverPid:process.pid,sequence:event.sequence,namespace:event.namespace,
      records:event.records,maxRecords:event.maxRecords};
    appendFileSync(receiptFile,JSON.stringify(receipt)+'\n',{encoding:'utf8',flush:true});
    res.writeHead(202,{'content-type':'application/json'}).end(JSON.stringify(receipt));
  } catch {
    res.writeHead(400).end();
  }
});

server.listen(0,'127.0.0.1',()=>process.send({pid:process.pid,port:server.address().port}));
process.once('disconnect',()=>{
  server.close();
  server.closeAllConnections();
});
