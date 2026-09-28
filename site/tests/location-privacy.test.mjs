import test from 'node:test';
import assert from 'node:assert/strict';
import {captureMapCamera,locationActionForPermission,restoredCameraOptions} from '../src/locationPrivacy.js';

test('permission state chooses the correct geolocation flow',()=>{
  assert.equal(locationActionForPermission('granted'),'locate');
  assert.equal(locationActionForPermission('denied'),'blocked');
  assert.equal(locationActionForPermission('prompt'),'request');
  assert.equal(locationActionForPermission(undefined),'request');
});

test('camera snapshot preserves every visible map parameter',()=>{
  const map={
    getCenter:()=>({lng:37.6173,lat:55.7558}),
    getZoom:()=>10.25,
    getBearing:()=>-17,
    getPitch:()=>52,
  };
  assert.deepEqual(captureMapCamera(map),{
    center:[37.6173,55.7558],
    zoom:10.25,
    bearing:-17,
    pitch:52,
  });
});

test('camera restoration returns to the exact snapshot',()=>{
  const snapshot={center:[37.6173,55.7558],zoom:10.25,bearing:-17,pitch:52};
  const options=restoredCameraOptions(snapshot);
  assert.deepEqual({...options,easing:undefined},{...snapshot,duration:650,easing:undefined,essential:true});
  assert.equal(options.easing(0),0);
  assert.equal(options.easing(1),1);
});

