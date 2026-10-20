/** Start an isolated day when an explicit rewind comes from the ordinary shift. */
export function createShiftSessionRestart({clock,getShift,start,onValue,onError}) {
  let active=true,running=false,requestToken=null;
  const check=async()=>{
    const snapshot=clock.getSnapshot(),shift=getShift();
    if(!active||running||snapshot.startingSession||!snapshot.restartDay||snapshot.mode!=='plan'||snapshot.minute!==360
      ||!shift?.plan||shift.regionId.includes(':scenario:'))return;
    const token=snapshot.restartDay,scope=shift.id;
    const owns=()=>active&&getShift()?.id===scope&&clock.getSnapshot().restartDay===token;
    running=true;requestToken=token;
    try {
      const value=await start({baseShiftId:scope,speed:snapshot.reviewSpeed??snapshot.speed});
      if(owns())onValue(value);
    } catch(error) {
      if(owns()){
        clock.set({minute:snapshot.restartFromMinute,restartDay:null,restartFromMinute:null,playing:false});
        onError(error);
      }
    } finally {running=false;}
  };
  const unsubscribe=clock.subscribe(check);
  check();
  return {close(){
    active=false;unsubscribe();
    if(requestToken&&clock.getSnapshot().restartDay===requestToken)clock.set({restartDay:null,restartFromMinute:null});
  }};
}
