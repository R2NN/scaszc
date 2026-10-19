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
    return [{engineerId:'engineer',orderId:'order',usedAt:`2026-08-17T${time}:00+03:00`,segment:{
      id:`edge-${sequence}`,kind,fromId:'m:a',toId:'m:b',edgeId:String(sequence),opposingEdgeId:'9',
      name:'Проверенный участок',geometry:[[55.75,37.62],[55.751,37.62]],
    }}];
  });
  try{
    const url=new URL('http://localhost');
    await scenario.handle('scenario/start',{baseShiftId:base.id},url);
    const first=await scenario.handle('scenario/tick',{shiftId:'scenario',minute:570},url);
    assert.equal(first.event.startsAt.slice(11,16),'09:30');
    const second=await scenario.handle('scenario/tick',{shiftId:'scenario',minute:865},url);
    assert.equal(second.event.startsAt.slice(11,16),'14:25');
    assert.equal(transport.list(shifts.get('scenario')).length,2);
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
