import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchConsequences, dispatchRecommendation, dispatchImpactPoints, dispatchCoverage } from '../src/dispatchConsequences.js';

const candidate = (id, name, arrival, reserve = 0) => ({id,engineer:{id,name},scenarioTime:'11:17',kind:'Свободный инженер',state:{status:'idle'},
  visit:{orderId:'U',arrival},plan:{routes:[]},orders:[],changes:[],reserve:Array.from({length:reserve},(_,i) => ({engineerId:`reserve-${i}`})),coverage:{after:{assigned:10}}});
const change = (orderId, before, after) => ({orderId,address:`Адрес ${orderId}`,before,after});
const visit = (engineerId, start, extra = {}) => ({engineerId,plannedStart:start,arrival:start,plannedFinish:'17:30',...extra});

test('consequences count transfers, delayed starts and lost assignments, excluding the new emergency and travel-only changes', () => {
  const option = candidate('E1','Инженер','11:38');
  option.orders = ['A','B','C','D'].map(id => ({id,coords:[55.7,37.6],start:'12:00',end:'17:00'}));
  option.changes = [
    change('A',visit('E1','12:00'),visit('E2','12:00')),
    change('B',visit('E1','12:30'),visit('E1','12:40',{plannedFinish:'18:30'})),
    change('C',visit('E2','13:00'),null),
    change('D',visit('E2','14:00',{departureAt:'13:00'}),visit('E2','14:00',{departureAt:'13:15'})),
    change('U',null,visit('E1','11:38')),
  ];
  const impact = dispatchConsequences(option);
  assert.deepEqual(impact.transferred.map(row => row.orderId), ['A']);
  assert.deepEqual(impact.delayed.map(row => row.orderId), ['B']);
  assert.deepEqual(impact.lost.map(row => row.orderId), ['C']);
  assert.equal(impact.delayed[0].delayMinutes,10);
  assert.equal(impact.withinWindow.length,1,'Finish after the client window is not a start-window violation');
  assert.equal(impact.outsideWindow.length,0);
  assert.equal(impact.restored.length,0,'The new emergency is not a restored old job');
  assert.match(impact.summary,/Теряют назначение: 1/);
  assert.deepEqual(dispatchImpactPoints(impact.lost)[0].geometry.coordinates,[37.6,55.7]);
});

test('delays within windows, real violations and unknown windows stay distinct', () => {
  const option = candidate('E1','Инженер','11:58');
  option.orders = [{id:'late',start:'12:00',end:'13:00'},{id:'unknown'},{id:'arrival',start:'12:00',end:'13:00'}];
  option.changes = [
    change('late',visit('E1','12:00'),visit('E1','13:01')),
    change('unknown',visit('E1','12:00'),visit('E1','12:20')),
    change('arrival',visit('E1','12:10'),visit('E1','12:20',{arrival:'11:59'})),
  ];
  const impact = dispatchConsequences(option);
  assert.equal(impact.delayed.length,3);
  assert.deepEqual(impact.outsideWindow.map(row => row.orderId),['late']);
  assert.equal(impact.withinWindow.length,1);
  assert.equal(impact.unknownWindow.length,1);
  assert.equal(impact.unknownWindow[0].windowStatus,'unknown');
  assert.equal(dispatchImpactPoints(impact.delayed).length,0,'Never invent missing map coordinates');
});

test('early arrival can wait for the client window while early work and late arrival remain violations', () => {
  const option = candidate('E','Инженер','11:38');
  option.orders = ['wait','early','late','boundary'].map(id => ({id,start:'16:00',end:'18:00'}));
  option.changes = [
    change('wait',visit('E','16:00'),visit('E','16:00',{arrival:'14:23'})),
    change('early',visit('E','16:00'),visit('E','15:59',{arrival:'14:23'})),
    change('late',visit('E','16:00'),visit('E','18:01',{arrival:'18:01'})),
    change('boundary',visit('E','16:00'),visit('E','18:00',{arrival:'14:23',plannedFinish:'19:00'})),
  ];
  const impact = dispatchConsequences(option);
  assert.deepEqual(impact.outsideWindow.map(row => row.orderId),['early','late']);
  assert.equal(impact.unknownWindow.length,0);
  assert.equal(impact.withinWindow[0].orderId,'boundary');
});

test('compact coverage counts unique emergency jobs and includes all jobs separately', () => {
  const option = candidate('E','Инженер','11:38');
  option.orders = [
    {id:'U',workType:'Аварийные работы'},
    {id:'E2',workType:'Аварийные работы'},
    {id:'normal',workType:'Подключение',priority:'URGENT'},
    {id:'ordinary',workType:'Подключение'},
  ];
  option.plan.routes = [{assignments:[{orderId:'U'},{orderId:'normal'},{orderId:'ordinary'}]},{assignments:[{orderId:'U'}]}];
  option.coverage.after = {assigned:3,total:4,urgentAssigned:2};
  assert.equal(dispatchCoverage(option),'Аварии 1/2 · всего 3/4');
  delete option.coverage;
  assert.equal(dispatchCoverage(option),'Аварии 1/2 · всего 3/4');
});

test('a real source route distinguishes a reserve departure from an idle engineer with future work', () => {
  const option = candidate('E1','Резерв','11:47');
  option.plan.routes = [{engineerId:'E1',assignments:[{orderId:'U',plannedStart:'11:47',plannedFinish:'12:30'}]}];
  option.changes = [change('U',null,visit('E1','11:47'))];
  assert.equal(dispatchConsequences(option).usesReserve,true);
  assert.match(dispatchConsequences(option).summary,/Привлекается резервный инженер/);
  option.plan.routes[0].assignments.push({orderId:'later',plannedStart:'15:00',plannedFinish:'16:00'});
  assert.equal(dispatchConsequences(option).usesReserve,false);
});

test('recommendation explains equal coverage, retained reserve and the actual arrival tradeoff', () => {
  const ionov = candidate('I','Ионов Геннадий','11:47',1);
  const kapitan = candidate('K','Капитанчук Александр','11:58',2);
  const fast = candidate('V','Выговский Сергей','11:38',1);
  fast.coverage.after.assigned = 9;
  fast.changes = [change('lost',visit('V','12:00'),null)];
  const phrase = dispatchRecommendation(kapitan,[fast,ionov,kapitan]);
  assert.match(phrase,/Покрытие такое же.*Ионов Геннадий/);
  assert.match(phrase,/на 1 инженера больше/);
  assert.match(phrase,/на 11 мин позже/);
  assert.doesNotMatch(phrase,/43|оптимальн|лучший/);
  const vsFast = dispatchRecommendation(kapitan,[fast,kapitan]);
  assert.match(vsFast,/на 1 заявку больше/);
  assert.match(vsFast,/на 20 мин позже/);
});
