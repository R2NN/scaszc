import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

test('route scope controls stay in the sticky panel before and after acceptance', async () => {
  const server = await createServer({configFile:false,plugins:[react()],server:{middlewareMode:true,hmr:false},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
  try {
    const { EmergencyDispatchPanel } = await server.ssrLoadModule('/src/EmergencyDispatch.jsx');
    const engineer = {id:'E',name:'Инженер',skills:['EMERGENCY'],equipment:[],transport:'CAR'};
    const candidate = {id:'candidate',engineer,kind:'Перехват в пути',scenarioTime:'11:17',visit:{orderId:'U',departureAt:'11:17',arrival:'11:38',travelMinutes:21},
      plan:{routes:[{engineerId:'E',assignments:[{orderId:'U'},{orderId:'J'}]}]},responseMinutes:21,changes:[],loads:[],reserve:[],team:[engineer],orders:[],
      coverage:{before:{unassigned:0},after:{assigned:2,total:2,unassigned:0}},experience:{count:0,ratingCount:0},contentSha256:'verified'};
    for (const status of ['WAITING','ACCEPTED']) for (const routeScope of ['day','next']) {
      const item = {id:'incident',status,order:{id:'U',address:'Адрес аварии',end:'18:00'},time:'11:17',candidates:[candidate],recommendedId:candidate.id,
        policy:{enabled:false},deadlineAt:Date.now()+300000,search:{complete:true},decision:status==='ACCEPTED'?{candidateId:candidate.id,actor:'Диспетчер',revision:2,at:Date.now()}:null};
      const controller = {selected:item,candidateId:candidate.id,routeScope,serverOffset:0,policy:null,preview(){},changeRouteScope(){},accept(){}};
      const html = renderToStaticMarkup(React.createElement(EmergencyDispatchPanel,{controller,onRoute(){}}));
      assert.ok(html.indexOf('dispatch-scope-controls') < html.indexOf('dispatch-options'));
      assert.match(html,/aria-label="Показывать маршрут"/);
      assert.match(html,new RegExp(`aria-pressed="${routeScope==='day'}">Весь оставшийся день`));
      assert.match(html,new RegExp(`aria-pressed="${routeScope==='next'}">Ближайшее действие`));
      const sticky = html.slice(html.indexOf('dispatch-decision-bar'),html.indexOf('dispatch-flow'));
      assert.match(sticky,/dispatch-scope-controls/);
      assert.equal(sticky.includes('Подтвердить этот вариант'),status==='WAITING');
    }
  } finally {await server.close();}
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
    controller.preview({...candidate,baseRevision:3});
    assert.equal(events.length, 2, 'An unavailable source must not silently compare the plan with itself');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  }
});
