/* global Bun, process */
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = pathToFileURL(resolve(process.argv[2] ?? '.audit-video.local/playback-bench') + '/');
const chromeProfile = pathToFileURL(resolve(process.argv[3] ?? '.audit-video.local/chrome') + '/');
const manifest = JSON.parse(await readFile(new URL('server.json', root), 'utf8'));
const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('<!doctype html><video muted width="960" height="540"></video>', {headers:{'Content-Type':'text/html'}})});
const [port] = (await readFile(new URL('DevToolsActivePort', chromeProfile), 'utf8')).trim().split(/\r?\n/);
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(resolve => ws.onopen = resolve);
let id=0; const pending = new Map();
ws.onmessage = event => { const msg=JSON.parse(event.data); if(!msg.id)return; const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(msg.error):p.resolve(msg.result); };
const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params,sessionId}));});
const {targetId}=await send('Target.createTarget',{url:server.url.origin});
const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
const call=(method,params={})=>send(method,params,sessionId);
await call('Runtime.enable');
const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const report={browser:version.Browser,fixture:manifest.probe,sourceBytes:manifest.original.fileSize,proxyBytes:manifest.optimized.fileSize,proxyGenerationMs:manifest.generationMs};
const memory = async () => {
 const { processInfo } = await send('SystemInfo.getProcessInfo');
 const ids = [...processInfo.map(p=>p.id), manifest.serverPid].filter(Number.isInteger);
 const script = `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`;
 const process = Bun.spawn(['powershell.exe','-NoProfile','-Command',script],{stdout:'pipe',stderr:'ignore'});
 const output = await new Response(process.stdout).text();await process.exited;
 return JSON.parse(output);
};
try {
 await call('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:1,mobile:false});
 await Bun.sleep(200);
 report.memoryBefore=await memory();
 for (const [name,registration] of [['original',manifest.original],['optimized',manifest.optimized]]) {
  report[name]=await ev(`(async()=>{
   const video=document.querySelector('video');video.muted=true;video.preload='metadata';
   const waitFrame=(target,assign)=>new Promise((resolve,reject)=>{
    let callback;const started=performance.now();
    const timer=setTimeout(()=>{video.cancelVideoFrameCallback(callback);reject(Error('Frame timeout at '+target));},15000);
    const frame=(_now,meta)=>{if(target===null||Math.abs(meta.mediaTime-target)<.04){clearTimeout(timer);resolve({ms:performance.now()-started,mediaTime:meta.mediaTime});}else callback=video.requestVideoFrameCallback(frame);};
    callback=video.requestVideoFrameCallback(frame);assign();
   });
   const startup=await waitFrame(null,()=>{video.src=${JSON.stringify(registration.streamUrl)};video.load();});
   const seeks=[];
   for(let round=0;round<2;round++)for(const target of [.25,8.91,18.73,4.43,21.22,1.17,15.67,6.29,11.91,22.37,3.83,17.49])seeks.push({target,...await waitFrame(target,()=>{video.currentTime=target;})});
   await waitFrame(0,()=>{video.currentTime=0;});
   const before=video.getVideoPlaybackQuality();const started=performance.now();await video.play();await new Promise(resolve=>setTimeout(resolve,5000));video.pause();const after=video.getVideoPlaybackQuality();
   return {startup,seeks,playback:{wallMs:performance.now()-started,mediaTime:video.currentTime,total:after.totalVideoFrames-before.totalVideoFrames,dropped:after.droppedVideoFrames-before.droppedVideoFrames},dimensions:[video.videoWidth,video.videoHeight],hardwareConcurrency:navigator.hardwareConcurrency};
  })()`);
  const sorted=report[name].seeks.map(s=>s.ms).sort((a,b)=>a-b);
  report[name].seekMs={p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1)};
  report[name].memory=await memory();
  assert.equal(report[name].seeks.length,24);
  console.log(name,JSON.stringify({startupMs:report[name].startup.ms,seekMs:report[name].seekMs,playback:report[name].playback}));
 }
 report.p95Speedup=report.original.seekMs.p95/report.optimized.seekMs.p95;
 console.log('p95Speedup',report.p95Speedup);
} finally {
 await writeFile(new URL('results.json',root),JSON.stringify(report,null,2));
 await writeFile(new URL('stop',root),'stop');
 await send('Target.closeTarget',{targetId});ws.close();server.stop(true);
}
