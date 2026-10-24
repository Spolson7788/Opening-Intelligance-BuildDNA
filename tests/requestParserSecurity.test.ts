import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';

it('survives compressed JSON with trailing bytes and accepts the next request',()=>{
 // Isolate a potential parser process crash from the test runner. All traffic
 // stays on a temporary loopback server and contains only synthetic JSON.
 const result=execFileSync(process.execPath,['-e',`
 const express=require('express'),http=require('node:http'),zlib=require('node:zlib');
 const app=express();app.use(express.json({limit:'10mb'}));app.post('/',(req,res)=>res.json({ok:true}));
 app.use((err,req,res,next)=>res.status(400).json({error:'invalid_body'}));
 const server=app.listen(0,'127.0.0.1',async()=>{
  const send=(bytes,encoding,split)=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/',method:'POST',headers:{'content-type':'application/json','content-length':bytes.length,...(encoding?{'content-encoding':encoding}:{})}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);if(split){req.write(bytes.subarray(0,split));setTimeout(()=>req.end(bytes.subarray(split)),25);}else req.end(bytes)});
  try{const valid=zlib.gzipSync(Buffer.from('{"synthetic":true}')),malformed=Buffer.concat([valid,Buffer.from('trailing-invalid-bytes')]);
   for(const split of [0,valid.length]){const first=await send(malformed,'gzip',split);if(![200,400].includes(first))throw Error('unexpected parser response '+first);await new Promise(r=>setTimeout(r,100));}
   await new Promise(r=>setTimeout(r,100));if(await send(Buffer.from('{"synthetic":true}'))!==200)throw Error('server did not recover');
   console.log('parser-survived');server.close();
  }catch(e){console.error(e);server.close(()=>process.exit(1));}
 });
 `],{cwd:process.cwd(),encoding:'utf8',timeout:10000});
 expect(result).toContain('parser-survived');
});
