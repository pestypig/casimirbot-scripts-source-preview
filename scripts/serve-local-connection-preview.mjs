import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
const root=path.resolve(".tmp/local-connection-preview");
const files={"/":"index.html","/index.html":"index.html","/connection.js":"connection.js","/artifact.json":"artifact.json"};
const server=createServer(async(request,response)=>{
  const file=files[request.url];
  if(request.method!=="GET" || !file){response.writeHead(404);response.end();return;}
  try{const bytes=await readFile(path.join(root,file));response.writeHead(200,{"Content-Type":file.endsWith(".js")?"text/javascript":file.endsWith(".json")?"application/json":"text/html","Cache-Control":"no-store"});response.end(bytes);}
  catch{response.writeHead(503);response.end("Build the isolated fixture preview first.");}
});
server.listen(0,"127.0.0.1",()=>console.log(`Fixture preview http://127.0.0.1:${server.address().port}/`));
