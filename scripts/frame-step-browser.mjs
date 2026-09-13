import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// Real browser decoding and UI with controlled IPC replies. The Rust integration
// test independently checks FrameIndex against every decoded fixture timestamp.
const root = pathToFileURL(resolve(process.argv[2] ?? '.audit-video.local/frame-fixtures') + '/');
const chromeProfile = pathToFileURL(resolve(process.argv[3] ?? '.audit-video.local/chrome') + '/');
const appUrl = process.argv[4] ?? 'http://127.0.0.1:5179';
const fixtures = JSON.parse(await readFile(new URL('frames.json', root), 'utf8'));
const data = new Map(await Promise.all(fixtures.map(async fixture => [fixture.path, await readFile(fixture.path)])));
const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
 const path=new URL(req.url).searchParams.get('path');const bytes=data.get(path);if(!bytes)return new Response('missing',{status:404});
 const headers={'Access-Control-Allow-Origin':'*','Content-Type':'video/mp4','Accept-Ranges':'bytes'};
 const range=req.headers.get('range')?.match(/bytes=(\d+)-(\d*)/);
 if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;return new Response(bytes.subarray(start,end+1),{status:206,headers:{...headers,'Content-Range':`bytes ${start}-${end}/${bytes.length}`}});}
 return new Response(bytes,{headers});
}});
const [port]=(await readFile(new URL('DevToolsActivePort',chromeProfile),'utf8')).trim().split(/\r?\n/);
const version=await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise(resolve=>ws.onopen=resolve);
let id=0;const pending=new Map(),errors=[];
ws.onmessage=event=>{const msg=JSON.parse(event.data);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(msg.error):p.resolve(msg.result);}else if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails);};
const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params,sessionId}));});
const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
const call=(method,params={})=>send(method,params,sessionId);
const ev=async expression=>{const result=await call('Runtime.evaluate',{expression:`(async()=>(${expression}))()`,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
const until=async(expression,timeout=10000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await ev(expression))return;await Bun.sleep(25);}throw Error('Timeout '+expression+' '+JSON.stringify(await ev('({text:document.body.innerText,time:document.querySelector("video")?.currentTime,shown:__audit.shown,source:document.querySelector("video")?.src,calls:__audit.calls.slice(-5)})')));};
const click=label=>ev(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
const key=async(key,code,modifiers=0)=>{await call('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers});await call('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers});};
const report={browser:version.Browser,fixtureFrameCounts:Object.fromEntries(fixtures.map(f=>[f.name,f.times.length]))};
const shim=`(()=>{
 const fixtures=${JSON.stringify(fixtures)};const base=${JSON.stringify(server.url.origin)};
 const budget={allowed:true,cpuThreads:1,filterThreads:1,maxParallelJobs:1,batchSize:3,maxChunkSeconds:12,prefetchAllowed:false,delayMs:20,ramCacheBytes:134217728,decodeConcurrency:1,cancelLowPriority:false,reason:'test'};
 const config={hardware:{logicalCpus:4,powerClass:'medium',operatingSystem:'windows',storageClass:'unknown',hardwareDecodeAvailable:true},preset:'balanced',pressure:'normal',playbackActive:false,exportActive:false,droppedFrameRatio:0,activeBackgroundTasks:0,thumbnailBudget:budget,waveformBudget:budget};
 window.isTauri=true;window.__audit={fixtures,opens:[],calls:[],callbacks:{},shown:null,frameDelay:0,readPending:0,failRead:false};
 window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
 window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback(fn){const id=Object.keys(__audit.callbacks).length+1;__audit.callbacks[id]=fn;return id;},convertFileSrc(path){return path;},async invoke(cmd,args){
  __audit.calls.push({cmd,args});
  if(cmd==='plugin:dialog|open')return __audit.opens.shift()??null;
  if(cmd==='plugin:dialog|save')return __audit.cancelSave?null:'timeline-test.json';
  if(cmd==='plugin:event|listen' && args.event==='export-progress'){__audit.exportCallback=args.handler;return 1;}
  if(cmd==='export_trim'){__audit.export=args.request;return {operationId:args.request.operationId,outputPath:args.request.outputPath};}
  if(cmd==='cancel_export'){setTimeout(()=>__audit.emitExport({progress:0,status:'cancelled'}),200);return null;}
  if(cmd==='write_text_file'){__audit.saved=JSON.parse(args.contents);return null;}
  if(cmd==='read_text_file')return JSON.stringify(__audit.saved);
  if(cmd==='get_runtime_performance_config'||cmd==='update_runtime_metrics')return config;
  if(cmd==='get_media_task_budget')return budget;
  if(cmd==='probe_media')return fixtures.find(f=>f.path===args.inputPath).probe;
  if(cmd==='create_video_cache_id')return args.inputPath;
  if(cmd==='register_playback_media')return {streamUrl:base+'/video?path='+encodeURIComponent(args.inputPath)+'&id='+Math.random(),mediaId:'test',fileSize:1000,mimeType:'video/mp4'};
  if(cmd==='generate_timeline_thumbnail_range')return {videoId:args.request.videoId,generation:args.request.generation,intervalSeconds:args.request.intervalSeconds,cacheDir:'test',thumbnails:[]};
  if(cmd==='generate_audio_waveform')return {...args.request,peaks:Array(args.request.peakCount).fill(.2)};
  if(cmd==='generate_playback_proxy')return fixtures.find(f=>f.name==='proxy').path;
  if(cmd==='get_frame_step'){
   __audit.readPending++;try{if(__audit.frameDelay)await new Promise(resolve=>setTimeout(resolve,__audit.frameDelay));if(__audit.failRead)throw Error('No frame timestamps');
    const times=fixtures.find(f=>f.path===args.inputPath).times;let current=times.findLastIndex(t=>t<=args.time+.000002);
    const next=Math.max(0,Math.min(times.length-1,current<0?0:current+args.direction));
    return {time:times[next],seekTime:times[next]+(next+1<times.length?Math.min(.001,(times[next+1]-times[next])/4):.000001),atBoundary:next===current};
   }finally{__audit.readPending--;}
  }
  return null;
 }};
 __audit.emitExport=payload=>__audit.callbacks[__audit.exportCallback]({event:'export-progress',id:1,payload:{operationId:__audit.export.operationId,...payload}});
 const observed=new WeakSet();new MutationObserver(()=>{const video=document.querySelector('video');if(!video||observed.has(video))return;observed.add(video);const observe=(_now,meta)=>{__audit.shown={time:meta.mediaTime,src:video.src};video.requestVideoFrameCallback(observe);};video.requestVideoFrameCallback(observe);}).observe(document,{childList:true,subtree:true});
})();`;
const open=async name=>{await ev(`(__audit.shown=null,__audit.opens.push(__audit.fixtures.find(f=>f.name===${JSON.stringify(name)}).path))`);await key('o','KeyO',2);await until('document.querySelector("video")?.readyState>=2 && __audit.shown!==null');};
const expectFrame=async time=>{await until(`__audit.shown && Math.abs(__audit.shown.time-${time})<.000002 && !document.querySelector('video').seeking && Math.abs(__audit.store.getState().currentTime-${time})<.000002 && !document.body.innerText.includes('Reading frame timestamps') && !document.body.innerText.includes('Seeking…')`);};
try{
 await call('Runtime.enable');await call('Page.enable');await call('Page.addScriptToEvaluateOnNewDocument',{source:shim});await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:appUrl});await until('document.body.innerText.includes("Choose a video or audio file")');
 await ev('window.__audit.store=(await import("/src/stores/media-store.ts")).useMediaStore');
 if(process.argv.includes('--export-progress')) {
  await open('vfr');await key('e','KeyE',2);
  await until('document.querySelector(\'[aria-label="Прогресс экспорта"]\') && __audit.export');
  const panel='document.querySelector(\'[aria-label="Прогресс экспорта"]\')';
  await ev('(__audit.clock=Date.now.bind(Date),__audit.offset=0,Date.now=()=>__audit.clock()+__audit.offset)');
  await ev('__audit.emitExport({progress:.1,status:"exporting",message:"Exporting Монтаж"})');
  await until(`${panel}.innerText.includes('10%')`);
  await ev('(__audit.offset=5000,__audit.emitExport({progress:.4,status:"exporting",message:"Exporting Монтаж"}))');
  await until(`${panel}.innerText.includes('Осталось около') && ${panel}.innerText.includes('40%')`);report.realProgressAndEstimate=true;
  await ev('__audit.offset=25000');await until(`${panel}.innerText.includes('Прогресс не менялся')`);
  assert.equal(await ev('document.querySelector("progress").value'),.4);report.stallDoesNotFakeProgress=true;
  await ev('__audit.emitExport({progress:.05,status:"exporting",message:"Exporting Монтаж"})');await until(`${panel}.innerText.includes('5%') && ${panel}.innerText.includes('Оцениваем время')`);report.retryResetsEstimate=true;
  await ev('__audit.emitExport({progress:.99,status:"exporting"})');await until(`${panel}.innerText.includes('Сохранение результата')`);assert.ok(!(await ev(`${panel}.innerText`)).includes('100%'));report.waitsForFilePublication=true;
  const screenshot=await call('Page.captureScreenshot',{format:'png'});await writeFile(new URL('export-progress-browser.png',root),Buffer.from(screenshot.data,'base64'));
  await ev('__audit.emitExport({progress:1,status:"completed"})');await until(`${panel}.innerText.includes('Экспорт завершён') && ${panel}.innerText.includes('100%')`);await click('Закрыть прогресс экспорта');await until(`!${panel}`);report.completion=true;
  await key('e','KeyE',2);await until(`${panel} && __audit.store.getState().exportStatus==='exporting'`);
  await ev(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Отменить экспорт').click()`);await until(`${panel}.innerText.includes('Ожидаем остановки')`);await until(`${panel}.innerText.includes('Экспорт отменён')`);report.cancellation=true;
  await key('e','KeyE',2);await until('__audit.store.getState().exportStatus==="exporting"');await ev('__audit.emitExport({progress:0,status:"failed",message:"Disk full"})');await until(`${panel}.innerText.includes('Не удалось экспортировать') && ${panel}.innerText.includes('Disk full')`);report.failure=true;
  await ev('__audit.cancelSave=true');await key('e','KeyE',2);await until(`!${panel} && __audit.store.getState().exportStatus==='idle'`);report.dialogCancellation=true;
  assert.equal(errors.length,0);report.errors=errors;console.log(JSON.stringify(report,null,2));
 } else if(process.argv.includes('--timeline')) {
  await open('vfr');
  const clipSelector='button[aria-label^="Клип "]';
  const save=async()=>{await ev('__audit.saved=null');await key('s','KeyS',2);await until('__audit.saved!==null');return ev('__audit.saved');};
  const mouse=async(type,x,y,modifiers=0)=>call('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:1,modifiers});
  const geometry=()=>ev(`(()=>{const b=document.querySelector('${clipSelector}'),r=b.getBoundingClientRect(),w=parseFloat(b.style.width);return {x:r.x-parseFloat(b.style.left),y:r.y+20,ruler:r.y-20,pps:w/Number(b.title.split(' · ')[1].split(' ')[0])}})()`);
  const seek=async time=>{const g=await geometry();await mouse('mousePressed',g.x+time*g.pps,g.ruler,1);await mouse('mouseReleased',g.x+time*g.pps,g.ruler,1);await until('!document.querySelector("video").seeking');await Bun.sleep(80);};
  const drag=async(start,end,modifiers=0)=>{const g=await geometry();await mouse('mousePressed',g.x+start*g.pps,g.y,modifiers);await mouse('mouseMoved',g.x+end*g.pps,g.y,modifiers);await Bun.sleep(60);await mouse('mouseReleased',g.x+end*g.pps,g.y,modifiers);await Bun.sleep(150);};
  await seek(2);await key('b','KeyB',2);await until(`document.querySelectorAll('${clipSelector}').length===2`);
  await seek(4);await key('s','KeyS');await until(`document.querySelectorAll('${clipSelector}').length===3`);
  await drag(3,3);await key('Delete','Delete');await until(`document.querySelectorAll('${clipSelector}').length===2`);
  let saved=await save();assert.ok(Math.abs(saved.clips[1].sourceStart-4)<.03,JSON.stringify(saved.clips));assert.ok(Math.abs(saved.clips[1].startTime-2)<.03);report.rippleDelete=true;
  await seek(2.5);assert.ok(await ev('Math.abs(document.querySelector("video").currentTime-4.5)<.08'));report.seekUsesSource=true;
  await seek(2.02);await click('Previous frame');await until('__audit.shown.time<2 && !__audit.readPending && !document.querySelector("video").seeking');
  await click('Next frame');await until('__audit.shown.time>=4 && !__audit.readPending && !document.querySelector("video").seeking');report.frameStepsAcrossCut=true;
  await seek(1.8);await key(' ','Space');await until('document.querySelector("video").currentTime>4.15 && __audit.store.getState().currentTime>2.15');await key(' ','Space');report.playAcrossCut=true;
  await key('z','KeyZ',2);await until(`document.querySelectorAll('${clipSelector}').length===3`);
  await drag(3,3);await key('Delete','Delete',8);await until(`document.querySelectorAll('${clipSelector}').length===2`);
  await seek(3);assert.ok(await ev('document.querySelector("video").classList.contains("invisible")'));report.gapIsBlack=true;
  await key(' ','Space');await until('!document.querySelector("video").classList.contains("invisible") && document.querySelector("video").currentTime>4.1');await key(' ','Space');report.playAcrossGap=true;
  await drag(3,3);await key('Delete','Delete');saved=await save();assert.ok(Math.abs(saved.clips[1].startTime-2)<.03);report.closeSelectedGap=true;
  await drag(.5,1.5,9);await key('Delete','Delete');saved=await save();assert.equal(saved.clips.length,3);assert.ok(Math.abs(saved.clips[1].sourceStart-1.5)<.04);report.deleteArbitraryRange=true;
  await key('z','KeyZ',2);await until(`document.querySelectorAll('${clipSelector}').length===2`);
  await drag(.5,1.5,9);await drag(1,.5);saved=await save();assert.ok(Math.abs(saved.clips[0].sourceStart-.5)<.04);report.moveArbitraryRange=true;
  await key('z','KeyZ',2);await key('Escape','Escape');await Bun.sleep(120);
  await drag(3,1);saved=await save();assert.ok(Math.abs(saved.clips[0].sourceStart-4)<.03);assert.ok(Math.abs(saved.clips[0].startTime)<.03);report.moveClip=true;
  await seek(.5);assert.ok(await ev('Math.abs(document.querySelector("video").currentTime-4.5)<.08'));
  await key('z','KeyZ',2);await Bun.sleep(100);await key('y','KeyY',2);await Bun.sleep(100);assert.ok(Math.abs((await save()).clips[0].sourceStart-4)<.03);report.undoRedoMove=true;
  await click('Fit timeline');await Bun.sleep(120);const g=await geometry();const edge=(await save()).clips[0].endTime;
  await mouse('mousePressed',g.x+edge*g.pps-5,g.ruler);await mouse('mouseReleased',g.x+edge*g.pps-5,g.ruler);await Bun.sleep(100);assert.ok(Math.abs(await ev('__audit.store.getState().currentTime')-edge)<.003);report.snapPlayhead=true;
  await mouse('mousePressed',g.x+edge*g.pps-5,g.ruler,1);await mouse('mouseReleased',g.x+edge*g.pps-5,g.ruler,1);await Bun.sleep(100);assert.ok(Math.abs(await ev('__audit.store.getState().currentTime')-edge)>.015);report.altDisablesSnap=true;
  await drag(.5,.5);await ev('document.querySelector(\'[aria-label="Trim start"]\').focus()');await key('ArrowRight','ArrowRight');saved=await save();assert.ok(saved.clips[0].startTime>0);assert.ok(saved.clips[0].sourceStart>4);await key('z','KeyZ',2);await ev('document.activeElement.blur()');report.trimMovedSource=true;
  await key('a','KeyA',2);await key('Delete','Delete');await until(`document.querySelectorAll('${clipSelector}').length===0`);assert.equal((await save()).clips.length,0);await key(' ','Space');await until('!__audit.store.getState().isPlaying');report.emptyTimeline=true;
  await key('z','KeyZ',2);await until(`document.querySelectorAll('${clipSelector}').length===2`);
  const restored=await save();await ev('__audit.opens.push("timeline-test.json")');await key('o','KeyO',10);await until('__audit.calls.some(c=>c.cmd==="read_text_file") && !__audit.store.getState().isLoading');await Bun.sleep(200);assert.deepEqual((await save()).clips,restored.clips);report.projectRoundTrip=true;
  await key('a','KeyA',2);await key('Delete','Delete');await save();const reads=await ev('__audit.calls.filter(c=>c.cmd==="read_text_file").length');await ev('__audit.opens.push("timeline-test.json")');await key('o','KeyO',10);await until(`__audit.calls.filter(c=>c.cmd==="read_text_file").length>${reads} && !__audit.store.getState().isLoading`);await Bun.sleep(150);assert.equal((await save()).clips.length,0);report.emptyProjectRoundTrip=true;
  await ev(`(__audit.saved=${JSON.stringify(restored)},__audit.opens.push("timeline-test.json"))`);await key('o','KeyO',10);await until(`document.querySelectorAll('${clipSelector}').length===2`);
  const screenshot=await call('Page.captureScreenshot',{format:'png'});await writeFile(new URL('timeline-browser.png',root),Buffer.from(screenshot.data,'base64'));
  assert.equal(errors.length,0);report.errors=errors;console.log(JSON.stringify(report,null,2));
 } else {
 for(const name of ['vfr','offset','hold']){
  await open(name);const times=fixtures.find(f=>f.name===name).times;
  await click('Previous frame');await expectFrame(times[0]);
  await click('Next frame');await expectFrame(times[1]);
  if(name==='vfr')assert.ok(await ev(`document.querySelector('footer').innerText.includes('Time ${times[1].toFixed(6)} s')`));
  await click('Previous frame');await expectFrame(times[0]);
  const steps=Math.min(12,times.length-1);
  await ev(`(()=>{for(let i=0;i<${steps};i++)document.querySelector('[aria-label="Next frame"]').click()})()`);await expectFrame(times[steps]);
  await ev(`(()=>{for(let i=0;i<${steps};i++)document.querySelector('[aria-label="Previous frame"]').click()})()`);await expectFrame(times[0]);
  if(name==='hold'){await ev(`(()=>{for(let i=0;i<5;i++)document.querySelector('[aria-label="Next frame"]').click()})()`);await expectFrame(times.at(-1));await click('Previous frame');await expectFrame(times.at(-2));}
  report[name]={first:times[0],next:times[1],rapidSteps:steps,passed:true};
 }
 await open('vfr');const times=fixtures.find(f=>f.name==='vfr').times;
 await key('.','Period');await expectFrame(times[1]);await key(',','Comma');await expectFrame(times[0]);
 await key(' ','Space');await until('__audit.store.getState().isPlaying && document.querySelector("video").currentTime>.5');await click('Next frame');
 await until('!__audit.store.getState().isPlaying && !document.querySelector("video").seeking && !__audit.readPending && !document.body.innerText.includes("Seeking…")');await Bun.sleep(150);assert.equal(await ev('document.querySelector("video").paused'),true);
 report.pauseAndKeyboard=true;
 await key(' ','Space');await until('document.querySelector("video").currentTime>2');await key(' ','Space');await Bun.sleep(150);
 assert.ok(await ev('Math.abs(__audit.store.getState().currentTime-document.querySelector("video").currentTime)<.12'));report.pauseAfterResumingKeepsCurrentTime=true;
 await ev('__audit.frameDelay=300');await click('Next frame');await until('__audit.readPending>0');await click('Skip back 30s');await Bun.sleep(500);assert.ok(await ev('document.querySelector("video").currentTime<.01'));report.scrubCancelsLateStep=true;
 await click('Next frame');await until('__audit.readPending>0');await key(' ','Space');await Bun.sleep(500);assert.equal(await ev('__audit.store.getState().isPlaying'),true);await key(' ','Space');report.playCancelsLateStep=true;
 await click('Next frame');await until('__audit.readPending>0');await open('offset');await Bun.sleep(500);assert.ok(await ev('document.querySelector("video").currentTime>=5'));report.sourceCancelsLateStep=true;
 await ev('(__audit.frameDelay=0,__audit.failRead=true)');const before=await ev('document.querySelector("video").currentTime');await click('Next frame');await until('document.body.innerText.includes("No frame timestamps")');assert.equal(await ev('document.querySelector("video").currentTime'),before);await ev('__audit.failRead=false');report.failureDoesNotGuess=true;
 await open('vfr');await ev(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Optimize playback').click()`);await until('document.body.innerText.includes("Optimized preview") && document.querySelector("video").readyState>=2');
 await click('Next frame');await expectFrame(times[1]);assert.equal(await ev('__audit.calls.filter(c=>c.cmd==="get_frame_step").at(-1).args.inputPath'),fixtures.find(f=>f.name==='proxy').path);report.proxyUsesActualFrames=true;
 assert.equal(errors.length,0);report.errors=errors;console.log(JSON.stringify(report,null,2));
 }
}finally{await writeFile(new URL(process.argv.includes('--export-progress')?'export-progress-results.json':process.argv.includes('--timeline')?'timeline-browser-results.json':'frame-browser-results.json',root),JSON.stringify(report,null,2));await send('Target.closeTarget',{targetId});ws.close();server.stop(true);}
