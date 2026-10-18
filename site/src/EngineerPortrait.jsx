import { portraitForEngineer, portraitFrameForEngineer } from './engineerPortraits.js';

/** Render one engineer's face using the same framing in every workspace. */
export function EngineerPortrait({ id }) {
  const source = portraitForEngineer(id);
  const frame = portraitFrameForEngineer(id);
  if (!source) return null;
  if (!frame) return <img src={source} alt='' loading='lazy' onError={event => { event.currentTarget.style.display = 'none'; }}/>;
  return <svg aria-hidden='true' viewBox={frame.box.join(' ')} preserveAspectRatio='xMidYMid slice'
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', overflow: 'hidden', borderRadius: 'inherit' }}>
    {frame.tiles.map(tile => <image key={tile.url} href={tile.url} x={tile.x} y='0' width='420' height='420'/>) }
  </svg>;
}
