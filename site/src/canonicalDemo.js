const clock = value => String(value || '').match(/T(\d{2}:\d{2})/)?.[1] || '';
const parts = value => String(value || '').split('|').map(item => item.trim()).filter(Boolean);

/** Convert the verified 17 August fixture into the same UI model as an import. */
export function canonicalDemoInput(fixture, artifact) {
  const jobs = fixture?.jobs || [];
  const team = fixture?.engineers || [];
  const planningDate = String(jobs[0]?.window_start || '').slice(0, 10);
  if (!jobs.length || !team.length || !artifact?.canonical?.engineerModels || !planningDate) {
    throw new Error('Основной набор заявок и инженеров не найден');
  }
  return {
    planningDate,
    orders: jobs.map(job => ({
      id: job.job_id,
      sourceId: job.job_id,
      name: `Заявка ${job.source_job_id || job.job_id}`,
      address: job.address,
      start: clock(job.window_start),
      end: clock(job.window_end),
      duration: Number(job.service_duration_min),
      priority: job.priority,
      workType: job.bk_type,
      serviceType: job.hd_type,
      skill: job.required_skill,
      transport: job.required_transport,
      equipment: job.required_equipment,
      zone: job.zone_name,
      zoneId: job.zone_id,
      district: job.district,
      regionId: 'moscow',
      status: job.status,
      coords: [Number(job.latitude), Number(job.longitude)],
      geocodeStatus: 'ready',
      sourceData: job,
    })),
    engineers: team.map(engineer => {
      const model = artifact.canonical.engineerModels[engineer.engineer_id];
      if (!model) throw new Error(`В основном плане нет бригады ${engineer.engineer_id}`);
      return {
        id: engineer.engineer_id,
        sourceId: engineer.engineer_id,
        name: engineer.engineer_name,
        skills: parts(engineer.skills),
        shiftStart: clock(engineer.shift_start) || engineer.shift_start,
        shiftEnd: clock(engineer.shift_end) || engineer.shift_end,
        transport: engineer.transport,
        equipment: parts(engineer.equipment),
        startAddress: engineer.start_address,
        startCoords: [Number(engineer.start_latitude), Number(engineer.start_longitude)],
        zone: engineer.zone,
        zoneId: model.zone_id,
        regionId: 'moscow',
        status: engineer.status,
        sourceData: engineer,
      };
    }),
  };
}
