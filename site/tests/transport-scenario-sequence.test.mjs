import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createTransportScenario } from '../server/transportScenario.mjs';
import { TransportStore,transportNetwork } from '../server/transportApi.mjs';
import { projectRoot } from '../scripts/project-root.mjs';
import { runExactReplan } from '../scripts/exact-replan-runner.mjs';
import { runExactPlan } from '../scripts/exact-plan-runner.mjs';

test('scheduled events keep their times without requiring previous route publication',async()=>{
  const raw=JSON.parse(await readFile(path.join(projectRoot(),'algorithm/artifacts/current/initial-exact-205-of-205-retimed.json'),'utf8'));
  const db=new Database(':memory:');
  db.exec('CREATE TABLE dispatch_sessions(id TEXT,base_shift_id TEXT,shift_id TEXT,payload TEXT)');
  const base={id:'base',regionId:'moscow',date:'2026-08-17',orders:[],team:[],plan:{contentSha256:raw.content_sha256}};
  const shifts=new Map([[base.id,base]]);
  const store={db,get:id=>shifts.get(id),byDate:()=>base,ensure:input=>{const s={...input,id:'scenario'};shifts.set(s.id,s);return s;}};
  const transport=new TransportStore(store);
  let sequence=0;
  const scenario=createTransportScenario(store,transport,async({kind,time})=>{
    sequence++;
    const candidate={engineerId:'engineer',orderId:'order',usedAt:`2026-08-17T${time}:00+03:00`,segment:{
      id:`edge-${sequence}`,kind,fromId:'m:a',toId:'m:b',edgeId:String(sequence),opposingEdgeId:'9',
      name:'Проверенный участок',lengthM:200,geometry:[[55.75,37.62],[55.751,37.62]],
    }};
    return kind==='road'?[
      {...candidate,segment:{...candidate.segment,id:'short',lengthM:40}},
      {...candidate,segment:{...candidate.segment,id:'one-way',opposingEdgeId:null,lengthM:350}},
      candidate,
    ]:[candidate];
  });
  try{
    const url=new URL('http://localhost');
    const start=await scenario.handle('scenario/start',{baseShiftId:base.id},url);
    assert.deepEqual(start.state.waves.map(w=>[w.time,w.kind]),[['09:30','road'],['14:25','metro']]);
    const early=await scenario.handle('scenario/tick',{shiftId:'scenario',minute:569},url);
    assert.equal(early.event,undefined);
    const first=await scenario.handle('scenario/tick',{shiftId:'scenario',minute:570},url);
    assert.equal(first.event.startsAt.slice(11,16),'09:30');
    assert.equal(first.event.direction,'both');
    assert.equal(first.event.segments[0].id,'edge-1','Prefer a longer real two-way segment over a short or one-way road');
    const second=await scenario.handle('scenario/tick',{shiftId:'scenario',minute:865},url);
    assert.equal(second.event.startsAt.slice(11,16),'14:25');
    assert.equal(transport.list(shifts.get('scenario')).length,2);
    const legacy={...second.state,index:4,presentationVersion:undefined,waves:[...second.state.waves,
      {time:'15:15',kind:'road',status:'PENDING'},
      {time:'15:45',kind:'entry',status:'PENDING'},
      {time:'17:00',kind:'road',status:'PENDING'},
    ]};
    db.prepare('UPDATE transport_scenarios SET payload=? WHERE shift_id=?').run(JSON.stringify(legacy),'scenario');
    const restored=await scenario.handle('scenario',{shiftId:'scenario'},url);
    assert.equal(restored.waves.length,2);
    assert.equal(restored.index,1);
    assert.equal(restored.waves[0].eventId,first.event.id);
    assert.equal(restored.waves[0].status,'OPEN');
    const evening=await scenario.handle('scenario/tick',{shiftId:'scenario',minute:1020},url);
    assert.equal(evening.complete,true);
    assert.equal(evening.event,undefined);
    assert.equal(transport.list(shifts.get('scenario')).length,2,'Retire extra waves without deleting saved events');
    assert.equal(second.state.waves[0].status,'OPEN','No automatic publication of the first plan');
    assert.equal(db.prepare('SELECT count(*) n FROM transport_previews').get().n,0);
    const duplicate=await scenario.handle('scenario/tick',{shiftId:'scenario',minute:865},url);
    assert.equal(duplicate.event,undefined);
    assert.equal(transport.list(shifts.get('scenario')).length,2);
  }finally{db.close();}
});

test('a cancelled exact calculation cannot start preparation or a new worker',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(runExactReplan({},undefined,{signal:controller.signal}),{name:'AbortError'});
  await assert.rejects(transportNetwork({action:'catalog'},{signal:controller.signal}),{name:'AbortError'});
});

test('an early worker exit while a large payload is writing rejects without crashing the server',async()=>{
  const previous=process.env.BEEGO_PYTHON;
  process.env.BEEGO_PYTHON=process.execPath;
  try{
    // Node rejects the Python file immediately, before its input pipe drains.
    await assert.rejects(transportNetwork({action:'catalog',padding:'x'.repeat(8*1024*1024)},{timeout:5000}),
      /Не удалось передать|SyntaxError|Unknown file extension/);
  }finally{
    if(previous===undefined)delete process.env.BEEGO_PYTHON;else process.env.BEEGO_PYTHON=previous;
  }
});

test('a full-shift preparation worker exiting during input also rejects cleanly',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'beego-pipe-'));
  const previous=process.env.BEEGO_PYTHON;
  try{
    await mkdir(path.join(directory,'algorithm','tools'),{recursive:true});
    await writeFile(path.join(directory,'algorithm','tools','prepare_ui_dataset.py'),'process.exit(2);');
    process.env.BEEGO_PYTHON=process.execPath;
    await assert.rejects(runExactPlan({padding:'x'.repeat(8*1024*1024)},directory,()=>{},{deadlineAt:Date.now()+5000}),
      /Не удалось передать|кодом|code|extension/);
  }finally{
    if(previous===undefined)delete process.env.BEEGO_PYTHON;else process.env.BEEGO_PYTHON=previous;
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));
    await rm(directory,{recursive:true,force:true});
  }
});
