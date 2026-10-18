import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const base=process.env.BEEGO_QA_URL || 'http://127.0.0.1:4190';
if(!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)||process.env.BEEGO_QA_ISOLATED!=='1')throw new Error('Use an isolated local database and BEEGO_QA_ISOLATED=1.');
const request=async(url,input)=>{const response=await fetch(base+url,{method:input?'POST':'GET',headers:{'content-type':'application/json'},body:input?JSON.stringify(input):undefined,signal:AbortSignal.timeout(960000)});const value=await response.json();if(!response.ok)throw new Error(JSON.stringify(value));return value;};
const readiness=await request('/api/runtime/readiness');assert.equal(readiness.ready,true,JSON.stringify(readiness));
const original=await request('/api/shifts?regionId=moscow&date=2026-08-17');
const session=await request('/api/dispatch/sessions',{baseShiftId:original.id});await request(`/api/dispatch/shifts/${session.shiftId}/policy`,{enabled:false,waitSeconds:300});
const start=Date.now();await request(`/api/dispatch/shifts/${session.shiftId}/clock`,{minute:677,playing:false,speed:1});
let incident, previous='';
while(Date.now()-start<900000){
 const value=await request(`/api/dispatch/shifts/${session.shiftId}/incidents`);incident=value.incidents[0];
 const state=JSON.stringify({status:incident?.status,candidates:incident?.candidates.length,progress:incident?.progress,error:incident?.error});if(state!==previous){process.stdout.write(state+'\n');previous=state;}
 if(incident?.status==='ERROR')throw new Error(incident.error);if(incident?.candidates.length)break;await new Promise(resolve=>setTimeout(resolve,2000));
}
assert.ok(incident?.candidates.length,'No independently verified candidates within 15 minutes');
const firstOfferMs=Date.now()-start;const candidate=incident.candidates[0];assert.equal(candidate.plan.validation.status,'VALID');
const accepted=await request(`/api/dispatch/incidents/${incident.id}/accept`,{candidateId:candidate.id,actor:'Isolated runtime acceptance'});assert.equal(accepted.status,'ACCEPTED',accepted.error);
const after=await request('/api/shifts?regionId=moscow&date=2026-08-17');assert.equal(after.plan.contentSha256,original.plan.contentSha256);
const report={at:new Date().toISOString(),base,readiness,firstOfferMs,candidates:incident.candidates.length,engineer:candidate.engineer.name,arrival:candidate.visit.arrival,status:accepted.status,decision:accepted.decision,originalPlanPreserved:true,syntheticRouting:false};
if(process.env.BEEGO_QA_REPORT)await writeFile(process.env.BEEGO_QA_REPORT,JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify(report)+'\n');
