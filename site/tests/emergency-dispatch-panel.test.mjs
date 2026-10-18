import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

test('searching, completion, search limits and errors have distinct states with a disabled unselected decision', async () => {
  const server = await createServer({configFile:false,plugins:[react()],server:{middlewareMode:true,hmr:false},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
  try {
    const { EmergencyDispatchPanel } = await server.ssrLoadModule('/src/EmergencyDispatch.jsx');
    for (const [status,search,label] of [
      ['SEARCHING',{complete:false},'Поиск продолжается'],
      ['WAITING',{complete:true},'Расчёт завершён'],
      ['WAITING',{complete:false,stoppedReason:'budget'},'Поиск остановлен по лимиту'],
      ['ERROR',{complete:false},'Расчёт прерван'],
    ]) {
      const item = {id:'incident',status,search,candidates:[],order:{address:'Адрес'},policy:{enabled:true},deadlineAt:Date.now()+135000};
      const html = renderToStaticMarkup(React.createElement(EmergencyDispatchPanel,{controller:{selected:item,serverOffset:0}}));
      assert.ok(html.includes(label));
      assert.match(html,/disabled="">Направить на аварию/);
      assert.match(html,/Автовыбор через 02:15/);
      if (status === 'SEARCHING') assert.doesNotMatch(html,/уже можно выбирать/);
      else assert.doesNotMatch(html,/Поиск продолжается/);
    }
  } finally {await server.close();}
});

test('route scope controls stay in the sticky panel before and after acceptance', async () => {
  const server = await createServer({configFile:false,plugins:[react()],server:{middlewareMode:true,hmr:false},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
  try {
    const { EmergencyDispatchPanel } = await server.ssrLoadModule('/src/EmergencyDispatch.jsx');
    const engineer = {id:'E',name:'Инженер',skills:['EMERGENCY'],equipment:[],transport:'CAR'};
    const candidate = {id:'candidate',engineer,kind:'Перехват в пути',scenarioTime:'11:17',visit:{orderId:'U',departureAt:'11:17',arrival:'11:38',travelMinutes:21},
      plan:{routes:[{engineerId:'E',assignments:[{orderId:'U'},{orderId:'J'}]}]},responseMinutes:21,changes:[{orderId:'J',address:'Прежний адрес',before:{engineerId:'E',plannedStart:'12:00'},after:{engineerId:'E2',plannedStart:'12:15',arrival:'12:15'}}],loads:[],reserve:[],team:[engineer,{id:'E2',name:'Получатель'}],orders:[{id:'J',coords:[55.7,37.6],start:'12:00',end:'17:00'}],
      coverage:{before:{unassigned:0},after:{assigned:2,total:2,unassigned:0}},experience:{count:0,ratingCount:0},contentSha256:'verified'};
    for (const status of ['WAITING','ACCEPTED']) for (const routeScope of ['day','next']) {
      const item = {id:'incident',status,order:{id:'U',address:'Адрес аварии',end:'18:00'},time:'11:17',candidates:[candidate],recommendedId:candidate.id,
        policy:{enabled:true},deadlineAt:Date.now()+135000,search:{complete:true},decision:status==='ACCEPTED'?{candidateId:candidate.id,actor:'Диспетчер',revision:2,at:Date.now()}:null};
      const controller = {selected:item,candidateId:candidate.id,routeScope,serverOffset:0,policy:null,preview(){},changeRouteScope(){},accept(){}};
      const html = renderToStaticMarkup(React.createElement(EmergencyDispatchPanel,{controller,onRoute(){}}));
      assert.ok(html.indexOf('dispatch-scope-controls') < html.indexOf('dispatch-options'));
      assert.match(html,/aria-label="Показывать маршрут"/);
      assert.match(html,new RegExp(`aria-pressed="${routeScope==='day'}">Весь оставшийся день`));
      assert.match(html,new RegExp(`aria-pressed="${routeScope==='next'}">Ближайшее действие`));
      const sticky = html.slice(html.indexOf('dispatch-decision-bar'),html.indexOf('dispatch-incident'));
      assert.match(sticky,/dispatch-scope-controls/);
      assert.equal(sticky.includes('Направить на аварию'),status==='WAITING');
      if (status === 'WAITING') {
        assert.match(sticky,/Автовыбор через 02:15/);
        assert.equal((html.match(/Автовыбор через/g) || []).length,1);
      } else {
        const result = html.slice(html.indexOf('dispatch-result'),html.indexOf('dispatch-options'));
        assert.match(result,/Инженер направлен на аварию/);
        assert.match(result,/Прибытие 11:38/);
        assert.match(result,/Прежний адрес/);
        assert.match(result,/Передана: Получатель · 12:15/);
      }
      assert.match(html,/Начнутся позже исходного плана/);
      assert.match(html,/В окне клиента/);
      assert.match(html,/Показать адреса на карте/);
      assert.doesNotMatch(html,/Как принять решение|Сравните варианты|Все изменения визитов|dispatch-comparison-legend|dispatch-map-key/);
    }
  } finally {await server.close();}
});

test('a manual acceptance applies the published shift immediately instead of waiting for polling', async () => {
  const server = await createServer({configFile:false,plugins:[react()],server:{middlewareMode:true,hmr:false},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
  const previousFetch = globalThis.fetch;
  try {
    const { useEmergencyDispatch } = await server.ssrLoadModule('/src/EmergencyDispatch.jsx');
    const applied = [], requests = [];
    const saved = {id:'shift',regionId:'test',revision:2,plan:{contentSha256:'published'}};
    let controller;
    function Harness() {controller = useEmergencyDispatch({shift:{id:'shift',regionId:'test',revision:1},onApply:value => applied.push(value)});return null;}
    renderToStaticMarkup(React.createElement(Harness));
    globalThis.fetch = async url => {
      requests.push(url);
      return Response.json(url.endsWith('/accept') ? {id:'incident',status:'ACCEPTED',decision:{revision:2}} : saved);
    };
    await controller.accept({id:'incident',shiftId:'shift'}, {id:'chosen'});
    assert.deepEqual(requests, ['/api/dispatch/incidents/incident/accept','/api/shifts/shift']);
    assert.deepEqual(applied, [saved]);
  } finally {globalThis.fetch = previousFetch;await server.close();}
});

test('preview controller emits the original revision after the shift plan was replaced', async () => {
  const server = await createServer({configFile:false,plugins:[react()],server:{middlewareMode:true,hmr:false},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
  const previousWindow = globalThis.window;
  try {
    const { useEmergencyDispatch } = await server.ssrLoadModule('/src/EmergencyDispatch.jsx');
    const before = {contentSha256:'before',routes:[]};
    const after = {contentSha256:'after',routes:[]};
    const shift = {id:'shift',revision:2,plan:after,versions:[{version:1,plan:before},{version:2,plan:after}]};
    let controller;
    function Harness() {
      controller = useEmergencyDispatch({shift});
      return null;
    }
    renderToStaticMarkup(React.createElement(Harness));
    const events = [];
    globalThis.window = {dispatchEvent:event => events.push(event)};
    const candidate = {id:'candidate',engineer:{id:'E1'},baseRevision:1,basePlanContentSha256:'before',plan:after,scenarioTime:'11:17',visit:{orderId:'U'}};
    controller.preview(candidate);
    controller.preview(candidate, 'next', 'E2');
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.type, 'beego:dispatch-preview');
      assert.equal(event.detail.before, before);
      assert.equal(event.detail.after, after);
    }
    assert.deepEqual(events[1].detail.ids, ['E2']);
    assert.equal(events[1].detail.scope, 'next');
    controller.showChanges(candidate, [{orderId:'A',address:'Адрес A',coords:[55.7,37.6]}]);
    assert.equal(events[2].detail.focusRoute, false);
    assert.equal(events[3].type, 'beego:dispatch-impact');
    assert.deepEqual(events[3].detail.features[0].geometry.coordinates, [37.6,55.7]);
    controller.showResult({...candidate,changedEngineerIds:['E1','E2']});
    assert.deepEqual(events[4].detail.highlightIds, ['E1','E2']);
    assert.equal(events[4].detail.before, before);
    controller.preview({...candidate,baseRevision:3});
    controller.showChanges({...candidate,baseRevision:3}, []);
    assert.equal(events.length, 5, 'An unavailable source must not silently compare the plan with itself or move the map');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  }
});
