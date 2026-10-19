/** Keep stroke endpoints while bounding network inspection work and removing jitter. */
export function sampleRoadStroke(points,limit=150) {
  const sampled=[];
  for(const point of points){const last=sampled.at(-1);if(!last||Math.hypot((point[0]-last[0])*111195,(point[1]-last[1])*62500)>=4)sampled.push(point);}
  const end=points.at(-1);if(end&&sampled.at(-1)!==end)sampled.push(end);
  if(sampled.length<=limit)return sampled;
  return Array.from({length:limit},(_,index)=>sampled[Math.round(index*(sampled.length-1)/(limit-1))]);
}
