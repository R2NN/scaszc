import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImportedDate, resolveImportedDate } from '../src/importDate.js';

test('parses common imported calendar formats',()=>{
  const first=parseImportedDate('05.08.2025 09:30'),second=parseImportedDate('2024-11-17T12:00:00+03:00');
  assert.deepEqual([first.getFullYear(),first.getMonth()+1,first.getDate()],[2025,8,5]);
  assert.deepEqual([second.getFullYear(),second.getMonth()+1,second.getDate()],[2024,11,17]);
});

test('selects the most common past work date from imported rows',()=>{
  const orders=[
    {serviceDate:'14.03.2025'},
    {sourceData:{'Дата работ':'14.03.2025'}},
    {createdAt:'12.03.2025'},
  ];
  const date=resolveImportedDate(orders,new Date(2026,8,17));
  assert.deepEqual([date.getFullYear(),date.getMonth()+1,date.getDate()],[2025,3,14]);
});

test('uses an explicit future work date for a new planning day',()=>{
  const date=resolveImportedDate([{serviceDate:'18.09.2026'}],new Date(2026,8,17));
  assert.deepEqual([date.getFullYear(),date.getMonth()+1,date.getDate()],[2026,9,18]);
});

test('does not interpret durations and time-only fields as dates',()=>{
  assert.equal(parseImportedDate('45'),null);
  assert.equal(parseImportedDate('09:00'),null);
  assert.equal(resolveImportedDate([{sourceData:{service_duration_min:'50',window_start:'09:30'}}],new Date(2026,8,17)),null);
});
