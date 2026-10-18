import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const root=process.cwd(), output=path.join(root,".tmp/local-connection-preview");
await mkdir(output,{recursive:true});
await build({entryPoints:[path.join(root,"tests/fixtures/local-connection-preview.tsx")],bundle:true,format:"iife",platform:"browser",
  outfile:path.join(output,"connection.js"),alias:{"@":path.join(root,"client/src"),"@shared":path.join(root,"shared"),
    "@/store/useWorkstationLayoutStore":path.join(root,"tests/fixtures/local-connection-preview-store.ts")},define:{"process.env.NODE_ENV":"\"production\""}});
await writeFile(path.join(output,"index.html"),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Local Connect Codex fixture preview</title><style>body{background:#020617;color:#e2e8f0;font:16px system-ui;max-width:1000px;margin:30px auto;padding:20px}section{border:1px solid #155e75;border-radius:16px;padding:24px}button{padding:10px;margin:4px;background:#0f172a;color:#e2e8f0;border:1px solid #64748b;border-radius:6px;cursor:pointer}dl{display:grid;grid-template-columns:1fr 1fr;gap:14px}dt{color:#94a3b8}dd{margin:4px 0;overflow-wrap:anywhere}p{line-height:1.5}</style><h1>Local setup engineering preview</h1><p>TEST IDENTITIES · fixture observations only · no installed, external-client, signed or human acceptance. Buttons demonstrate navigation; no credentials, resources or grants are created.</p><div id="root"></div><p id="navigation" role="status"></p><script src="connection.js"></script></html>`);
const files=[];for(const name of ["index.html","connection.js"]){const bytes=await readFile(path.join(output,name));files.push({name,sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length});}
await writeFile(path.join(output,"artifact.json"),JSON.stringify({schema:"casimirbot.local_connection_preview.v1",sourceBaseline:"7e443b08360dbd19d2cbb016baf897c8a3fd5124",scope:"fixture_only",releaseAcceptance:false,files},null,2));
console.log(JSON.stringify({output,files}));
