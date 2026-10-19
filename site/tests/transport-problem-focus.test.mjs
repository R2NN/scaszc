import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransportProblemFocus } from '../src/transportProblemFocus.js';

const event={id:'metro',revision:1,status:'OPEN',startsAt:'2026-08-17T14:25:00+03:00',endsAt:'2026-08-17T15:10:00+03:00'};
const input={shiftId:'shift',date:'2026-08-17',minute:865,events:[event],visible:true};

test('a future problem focuses at its actual start, once after the map accepts focus',()=>{
  const focus=createTransportProblemFocus();
  assert.deepEqual(focus.update({...input,minute:864}),[]);
  assert.deepEqual(focus.update(input),[event]);
  assert.deepEqual(focus.update(input),[event],'An unavailable map must not lose the pending focus');
  focus.acknowledge([event]);
  assert.deepEqual(focus.update({...input,minute:866}),[],'Playback and event polling must not reset the camera');
});

test('problems wait while another workspace or an edited draft owns the map',()=>{
  const focus=createTransportProblemFocus();
  assert.deepEqual(focus.update({...input,visible:false}),[]);
  assert.deepEqual(focus.update(input),[event]);
  focus.acknowledge([event]);
  assert.deepEqual(focus.update({...input,visible:false}),[]);
  assert.deepEqual(focus.update(input),[],'Returning to Shift does not refocus an already seen problem');
});

test('ended pending problems are discarded; a new revision or another day can focus',()=>{
  const focus=createTransportProblemFocus();
  focus.update({...input,visible:false});
  assert.deepEqual(focus.update({...input,minute:910}),[]);
  assert.deepEqual(focus.update(input),[],'Rewinding must not replay an already seen event');
  const revised={...event,revision:2};
  assert.deepEqual(focus.update({...input,events:[revised]}),[revised]);
  focus.acknowledge([revised]);
  assert.deepEqual(focus.update({...input,shiftId:'another-shift'}),[event]);
});

test('simultaneous incidents fit together without losing a later arrival during focus',()=>{
  const focus=createTransportProblemFocus(),road={...event,id:'road'};
  assert.deepEqual(focus.update(input),[event]);
  assert.deepEqual(focus.update({...input,events:[event,road]}),[event,road]);
  focus.acknowledge([event]);
  assert.deepEqual(focus.update({...input,events:[event,road]}),[road]);
  assert.deepEqual(focus.update({...input,events:[event,{...road,status:'CANCELLED'}]}),[]);
});
