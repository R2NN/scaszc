export function locationActionForPermission(state){
  if(state==='granted')return'locate';
  if(state==='denied')return'blocked';
  return'request';
}

export function captureMapCamera(map){
  if(!map)return null;
  const center=map.getCenter();
  return{
    center:[center.lng,center.lat],
    zoom:map.getZoom(),
    bearing:map.getBearing(),
    pitch:map.getPitch(),
  };
}

export function restoredCameraOptions(camera){
  if(!camera)return null;
  return{
    center:[...camera.center],
    zoom:camera.zoom,
    bearing:camera.bearing,
    pitch:camera.pitch,
    duration:650,
    easing:t=>1-(1-t)**3,
    essential:true,
  };
}

