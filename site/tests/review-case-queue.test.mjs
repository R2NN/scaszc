import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ShiftStore} from '../server/shiftStore.mjs';
import {RatingStore} from '../server/ratingStore.mjs';
import {createRatingApi} from '../server/ratingApi.mjs';

test('case triage persists independently of scores, decisions and message read state',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'beego-queue-'));const file=path.join(directory,'queue.sqlite3');
  let shifts=new ShiftStore(file),api=createRatingApi(shifts);
  const request=(target,body,method='PATCH')=>api(new Request(`http://localhost/api/ratings/${target}`,body?{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}));
  try {
    const original=await (await request('cases/RC-1')).json();
    const store=new RatingStore(shifts.db),version=store.version();
    assert.equal(original.triage.viewed,false);assert.equal(original.triage.unread,true);
    let response=await request('cases/RC-1/triage',{viewed:true,actor:'Диспетчер QA'});
    assert.equal(response.status,200);let current=await response.json();
    assert.equal(current.triage.viewed,true);assert.equal(current.triage.unread,false);assert.equal(current.triage.viewedBy,'Диспетчер QA');
    current=await (await request('cases/RC-1/triage',{flagged:true})).json();
    assert.equal(current.triage.flagged,true);assert.equal(current.triage.unread,false);
    assert.equal(current.revision,original.revision);assert.equal(current.status,original.status);assert.deepEqual(current.review,original.review);assert.equal(store.version(),version);
    await request('cases/RC-1/messages',{role:'dispatcher',author:'QA',text:'Уточнение диспетчера без нового входящего сообщения.'},'POST');
    current=await (await request('cases/RC-1')).json();assert.equal(current.triage.unread,false);
    await request('cases/RC-1/messages',{role:'engineer',text:'Новые обстоятельства визита для проверки диспетчером.'},'POST');
    current=await (await request('cases/RC-1')).json();assert.equal(current.triage.unread,true);
    await request('cases/RC-1/triage',{viewed:true,actor:'QA'});
    current=await (await request('cases/RC-1')).json();assert.equal(current.triage.unread,false);
    shifts.close();shifts=new ShiftStore(file);api=createRatingApi(shifts);
    current=await (await request('cases/RC-1')).json();assert.equal(current.triage.flagged,true);assert.equal(current.triage.unread,false);
    await request('cases/RC-1/triage',{viewed:false});
    current=await (await request('cases/RC-1')).json();assert.equal(current.triage.viewed,false);assert.equal(current.triage.unread,true);assert.equal(current.triage.flagged,true);
    assert.equal((await request('cases/RC-1/triage',{})).status,422);
    assert.equal((await request('cases/MISSING/triage',{flagged:true})).status,404);
  }finally{shifts.close();assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('beego-queue-'));await rm(directory,{recursive:true,force:true});}
});

test('client and engineer appeals retain their real source and original customer review',async()=>{
 const shifts=new ShiftStore(':memory:'),store=new RatingStore(shifts.db);
 try{await store.seed();const person=store.engineer('EAST-ENG-01');const visit=person.pendingVisits[0];
 const updated=store.addReview({visitId:visit.id,client:'Клиент QA',score:2,comment:'После визита подключение перестало работать.'});
 const review=updated.reviews.find(item=>item.visitId===visit.id);
 const item=store.createCase({reviewId:review.id,origin:'client',text:'Прошу проверить результат работы специалиста и повторное отключение.'});
 assert.equal(item.origin,'client');assert.equal(item.messages[0].role,'client');assert.equal(item.messages[0].author,'Клиент QA');assert.equal(item.review.score,2);
 assert.match(item.appealText,/результат работы/);assert.equal(item.triage.unread,true);
 assert.equal(store.case('RC-35').origin,'engineer');
 assert.equal(shifts.db.prepare('SELECT COUNT(*) n FROM shifts').get().n,0);
 }finally{shifts.close();}
});
