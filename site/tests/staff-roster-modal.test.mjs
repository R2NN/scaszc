import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('opening the existing engineer dialog with everyone in the shift shows its empty state', async () => {
  const server = await createServer({
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  try {
    const { StaffRosterModal } = await server.ssrLoadModule('/src/StaffRosterModal.jsx');
    const member = {
      id: 'engineer-1',
      sourceId: 'E-1',
      name: 'Бригада Комарь',
      rosterPeriods: [{ from: '2026-08-01' }],
    };
    const html = renderToStaticMarkup(createElement(StaffRosterModal, {
      mode: 'include',
      roster: [member],
      shift: { team: [member], plan: { routes: [{ engineerId: member.id, assignments: [{ orderId: 'order-1' }] }] } },
      date: '2026-08-18',
      onClose() {},
      onAddNew() {},
    }));
    assert.match(html, /Все бригады действующего состава уже имеют назначения или недоступны/);
    const idleHtml = renderToStaticMarkup(createElement(StaffRosterModal, {
      mode: 'include',
      roster: [member],
      shift: { team: [member], plan: { routes: [{ engineerId: member.id, assignments: [] }] } },
      date: '2026-08-18',
      onClose() {},
      onAddNew() {},
      onAssignIdle() {},
    }));
    assert.match(idleHtml, /Бригада Комарь/);
    assert.match(idleHtml, /В смене · без назначенных заявок/);
  } finally {
    await server.close();
  }
});
