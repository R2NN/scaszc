import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutShiftCrewMarkers } from '../src/shiftMarkerLayout.js';
const project = ([x,y]) => ({x,y});
test('co-located crews remain individually visible beside all depot symbols without moving their coordinates', () => {
  const crews = Array.from({length: 11}, (_,i) => ({id:`crew-${i}`,coords:[i<3?400:i<6?324:348,i<3?200:i<6?232:285]}));
  const starts = [[400,200],[324,232],[348,285]];
  const original = JSON.stringify(crews);
  const offsets=layoutShiftCrewMarkers(crews,starts,project);
  const points=crews.map(c=>({id:c.id,x:c.coords[0]+offsets.get(c.id)[0],y:c.coords[1]+offsets.get(c.id)[1]}));
  for(let i=0;i<points.length;i++){
    for(const [x,y] of starts) assert.ok(Math.abs(points[i].x-x)>=48 || Math.abs(points[i].y-y)>=48);
    for(let j=0;j<i;j++) assert.ok(Math.abs(points[i].x-points[j].x)>=35 || Math.abs(points[i].y-points[j].y)>=35);
  }
  assert.equal(JSON.stringify(crews),original);
  assert.deepEqual(layoutShiftCrewMarkers([...crews].reverse(),starts,project),offsets);
});
test('travelling crews keep zero offset once they leave a busy start; selecting one does not conceal its location',()=>{
  const crews=[{id:'one',coords:[300,300]},{id:'two',coords:[500,500]}];
  const offsets=layoutShiftCrewMarkers(crews,[[100,100]],project);
  assert.deepEqual([...offsets.values()],[[0,0],[0,0]]);
});
