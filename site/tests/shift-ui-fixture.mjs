// Separate visual-QA database only. Never run against the normal BeeGo database.
import { resolve } from 'node:path';
import { ShiftStore } from '../server/shiftStore.mjs';

const target = resolve(process.env.BEEGO_DB_PATH || '');
if (!target.includes(`${process.platform === 'win32' ? '\\' : '/'}tmp${process.platform === 'win32' ? '\\' : '/'}qa-shift${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Fixture requires BEEGO_DB_PATH inside tmp/qa-shift.');
const date = new Date().toLocaleDateString('sv-SE');
const orders = [
  { id: 'qa-1', name: 'Подключение на Тверской', address: 'Москва, Тверская улица, 10', regionId: 'moscow', regionName: 'Москва', serviceDate: date, zone: 'Центр', skill: 'Подключение', equipment: '', coords: [55.7618,37.6088], start: '09:00', end: '12:00', duration: 60 },
  { id: 'qa-2', name: 'Диагностика на Арбате', address: 'Москва, улица Арбат, 15', regionId: 'moscow', regionName: 'Москва', serviceDate: date, zone: 'Центр', skill: 'Подключение', equipment: '', coords: [55.7503,37.5969], start: '12:00', end: '16:00', duration: 45 },
  { id: 'qa-3', name: 'Заявка в очереди', address: 'Москва, Покровка, 6', regionId: 'moscow', regionName: 'Москва', serviceDate: date, zone: 'Центр', skill: 'Подключение', equipment: '', coords: [55.7602,37.6385], start: '12:00', end: '14:00', duration: 60 },
];
const team = [{ id: 'qa-crew', name: 'Бригада QA', regionId: 'moscow', regionName: 'Москва', serviceDate: date, zone: 'Центр', skills: ['Подключение'], equipment: [], transport: 'CAR', shiftStart: '08:00', shiftEnd: '18:00', startCoords: [55.7558,37.6173], startAddress: 'Москва, Красная площадь' }];
const assignments = [
  { orderId: 'qa-1', engineerId: 'qa-crew', departureAt: '08:30', arrivalAt: '08:50', plannedStart: '09:00', plannedFinish: '10:00', travelMinutes: 20, distanceM: 3100, geometry: [[55.7558,37.6173],[55.758,37.614],[55.7618,37.6088]] },
  { orderId: 'qa-2', engineerId: 'qa-crew', departureAt: '11:30', arrivalAt: '11:45', plannedStart: '12:00', plannedFinish: '12:45', travelMinutes: 15, distanceM: 2300, geometry: [[55.7618,37.6088],[55.756,37.602],[55.7503,37.5969]] },
];
const plan = { id: 'qa-plan', provider: 'QA_FIXTURE', publicationAllowed: true, validation: { status: 'VALID' }, routes: [{ engineerId: 'qa-crew', engineerName: 'Бригада QA', shiftStart: '08:00', shiftEnd: '18:00', assignments, geometry: [...assignments[0].geometry,...assignments[1].geometry], distanceKm: 5.4, travelMinutes: 35 }], unassigned: [{ orderId: 'qa-3', reasonCode: 'NO_FEASIBLE_TIME_WINDOW', reason: 'Нет свободного интервала в этом проверочном плане.' }], metrics: { total: 3, assigned: 2, unassigned: 1, distanceKm: 5.4 } };
const store = new ShiftStore(target);
try { store.ensure({ regionId: 'moscow', date, orders, team, plan }); process.stdout.write(`QA shift seeded for ${date}\n`); }
finally { store.close(); }
