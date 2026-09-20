const ROAD_DISTANCE_FACTOR = 1.25;

const TRANSPORT_SPEED_KMH = {
  CAR: 30,
  PUBLIC_TRANSIT: 18,
  BICYCLE: 14,
  WALK: 4.5,
};

const minutesFromTime = value => {
  const [hours, minutes] = String(value || '00:00').slice(-5).split(':').map(Number);
  return (Number(hours) || 0) * 60 + (Number(minutes) || 0);
};

const timeFromMinutes = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.round(value) % 60).padStart(2, '0')}`;

const normalizedText = value => String(value || '').trim().toLocaleLowerCase('ru-RU');

const zoneOf = item => normalizedText(item?.cluster || item?.clusterName || item?.zone || item?.zoneName || item?.zoneId || item?.regionName);

const skillCode = value => {
  const normalized = normalizedText(value);
  if (/emergency|авар/.test(normalized)) return 'EMERGENCY';
  if (/install|connect|подключ|монтаж/.test(normalized)) return 'INSTALL';
  if (/local|локал|ремонт|диагност/.test(normalized)) return 'LOCAL';
  if (/upsell|дозаказ/.test(normalized)) return 'UPSELL';
  return normalized.toUpperCase();
};

const transportCode = value => {
  const normalized = normalizedText(value);
  if (!normalized || /any|любой|неважно/.test(normalized)) return 'ANY';
  if (/car|auto|авто|машин/.test(normalized)) return 'CAR';
  if (/public|transit|bus|обществен/.test(normalized)) return 'PUBLIC_TRANSIT';
  if (/bike|bicycle|вело/.test(normalized)) return 'BICYCLE';
  if (/walk|foot|пеш/.test(normalized)) return 'WALK';
  return normalized.toUpperCase();
};

const coordinatesOf = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) ? value : null;

const radians = degrees => degrees * Math.PI / 180;

const roadDistanceKm = (from, to) => {
  if (!from || !to) return null;
  const latitudeDelta = radians(to[0] - from[0]);
  const longitudeDelta = radians(to[1] - from[1]);
  const firstLatitude = radians(from[0]);
  const secondLatitude = radians(to[0]);
  const chord = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  const straightDistance = 6371 * 2 * Math.atan2(Math.sqrt(chord), Math.sqrt(1 - chord));
  return straightDistance * ROAD_DISTANCE_FACTOR;
};

const requiredTransportOf = order => order?.requiredTransport
  || order?.transportRequirement
  || order?.transport
  || order?.sourceData?.required_transport
  || order?.sourceData?.transport_requirement
  || '';

const sameTerritory = (engineer, order) => {
  const engineerZone = zoneOf(engineer);
  const orderZone = zoneOf(order);
  if (engineerZone || orderZone) return Boolean(engineerZone && orderZone && engineerZone === orderZone);
  return Boolean(engineer?.regionId && order?.regionId && String(engineer.regionId) === String(order.regionId));
};

/**
 * Дополняет координатами заявки и стартовые точки инженеров во всех днях истории.
 * Это позволяет автоматически рассчитывать FCFS-бейзлайн для любой выбранной даты.
 */
export function hydrateBaselineInputs(payload, source) {
  if (!payload?.days || !Array.isArray(source?.jobs) || !Array.isArray(source?.engineers)) return payload;
  const jobs = new Map(source.jobs.map(job => [String(job.job_id || job.source_job_id), job]));
  const engineers = new Map(source.engineers.map(engineer => [String(engineer.engineer_id), engineer]));

  return {
    ...payload,
    days: payload.days.map(day => ({
      ...day,
      orders: (day.orders || []).map(order => {
        const job = jobs.get(String(order.sourceId)) || jobs.get(String(order.id).replace(/^.*:/, ''));
        const latitude = Number(job?.latitude);
        const longitude = Number(job?.longitude);
        return Number.isFinite(latitude) && Number.isFinite(longitude)
          ? { ...order, coords: [latitude, longitude], geocodeStatus: 'provided' }
          : order;
      }),
      team: (day.team || []).map(engineer => {
        const sourceEngineer = engineers.get(String(engineer.id));
        const latitude = Number(sourceEngineer?.start_latitude);
        const longitude = Number(sourceEngineer?.start_longitude);
        return Number.isFinite(latitude) && Number.isFinite(longitude)
          ? { ...engineer, startCoords: [latitude, longitude], startAddress: sourceEngineer.start_address || '' }
          : engineer;
      }),
    })),
  };
}

/**
 * Рассчитывает базовый FCFS-план без перестановки заявок и оптимизации маршрутов.
 * Заявки и инженеры рассматриваются строго в исходном порядке массивов.
 */
export function calculateBaseline(orders = [], engineers = []) {
  const states = engineers.map(engineer => ({
    engineer,
    availableAt: minutesFromTime(engineer.shiftStart || '08:00'),
    shiftEnd: minutesFromTime(engineer.shiftEnd || '18:00'),
    location: coordinatesOf(engineer.startCoords),
    assignments: [],
    distanceKm: 0,
  }));
  const unassigned = [];

  for (const order of orders) {
    let assigned = false;
    for (const state of states) {
      const { engineer } = state;
      if (!sameTerritory(engineer, order)) continue;
      const requiredSkill = skillCode(order.skill || order.requiredSkill || order.workType || order.sourceData?.required_skill);
      if (!(engineer.skills || []).map(skillCode).includes(requiredSkill)) continue;
      const requiredTransport = transportCode(requiredTransportOf(order));
      const engineerTransport = transportCode(engineer.transport);
      if (requiredTransport !== 'ANY' && requiredTransport !== engineerTransport) continue;
      const destination = coordinatesOf(order.coords);
      const distanceKm = roadDistanceKm(state.location, destination);
      if (distanceKm == null) continue;
      const speed = TRANSPORT_SPEED_KMH[engineerTransport] || TRANSPORT_SPEED_KMH.PUBLIC_TRANSIT;
      const travelMinutes = distanceKm < 0.05 ? 0 : Math.max(1, Math.ceil(distanceKm / speed * 60));
      const arrivalAt = state.availableAt + travelMinutes;
      const plannedStart = Math.max(arrivalAt, minutesFromTime(order.start));
      const plannedFinish = plannedStart + Math.max(1, Number(order.duration) || 60);
      if (plannedStart > minutesFromTime(order.end) || plannedFinish > state.shiftEnd) continue;

      state.assignments.push({
        orderId: order.id,
        plannedStart: timeFromMinutes(plannedStart),
        plannedFinish: timeFromMinutes(plannedFinish),
        travelMinutes,
        distanceKm,
      });
      state.availableAt = plannedFinish;
      state.location = destination;
      state.distanceKm += distanceKm;
      assigned = true;
      break;
    }
    if (!assigned) unassigned.push({ orderId: order.id });
  }

  const used = states.filter(state => state.assignments.length);
  const baselineAssignedCount = used.reduce((sum, state) => sum + state.assignments.length, 0);
  const baselineTotalDistanceKm = used.reduce((sum, state) => sum + state.distanceKm, 0);
  return {
    baselineAssignedCount,
    baselineEngineersUsed: used.length,
    baselineTotalDistanceKm,
    baselineAvgKmPerOrder: baselineAssignedCount ? baselineTotalDistanceKm / baselineAssignedCount : 0,
    baselineUnassignedCount: unassigned.length,
    routes: used.map(state => ({ engineerId: state.engineer.id, assignments: state.assignments, distanceKm: state.distanceKm })),
    unassigned,
  };
}
