import { engineerIdentity } from './engineerPresentation.js';
const primary = ['EAST-ENG-01','EAST-ENG-02','EAST-ENG-03','EAST-ENG-04','EAST-ENG-05','EAST-ENG-06','EAST-ENG-07','EAST-ENG-08','EAST-ENG-09','EAST-ENG-10','EAST-ENG-11','EAST-ENG-12','SOUTHEAST-ENG-01','SOUTHEAST-ENG-02','SOUTHEAST-ENG-03','SOUTHEAST-ENG-04','SOUTHEAST-ENG-05','SOUTHEAST-ENG-06','SOUTHEAST-ENG-07','SOUTHEAST-ENG-08','SOUTHEAST-ENG-09','SOUTHEAST-ENG-10','SOUTHEAST-ENG-11','SOUTHEAST-ENG-12','SOUTHCENTER-ENG-01','SOUTHCENTER-ENG-02','SOUTHCENTER-ENG-03','SOUTHCENTER-ENG-04','SOUTHCENTER-ENG-05','SOUTHCENTER-ENG-06','SOUTHCENTER-ENG-07','SOUTHCENTER-ENG-08','SOUTHCENTER-ENG-09','SOUTHCENTER-ENG-10','SOUTHCENTER-ENG-11'];
// There are 33 generated assets. Portrait 9 remains reserved for the
// case-specific engineer; the other 32 are assigned once across the primary
// roster. The remaining primary engineers and the 1,000-person reserve use
// initials instead of reusing someone else's face.
const primaryPortraitNumbers = [1, 2, 3, 4, 5, 6, 7, 8, ...Array.from({ length: 24 }, (_, index) => index + 10)];
const casePortraits = { 'RATING-0001': 9 };
/** Return a unique roster portrait, or initials for people without an assigned photo. */
export function portraitForEngineer(id) {
  const key = engineerIdentity(id);
  if (casePortraits[key]) return '/engineer-portraits/portrait-' + casePortraits[key] + '.jpg?v=2';
  const index = primary.indexOf(key);
  if (index < 0 || index >= primaryPortraitNumbers.length) return null;
  const number = primaryPortraitNumbers[index];
  if (number === 29 || number === 33) return `/engineer-portraits/portrait-${number}-restored.png?v=1`;
  return '/engineer-portraits/portrait-' + number + '.jpg?v=3';
}

// Retained tiles overlap adjacent portraits. Reassemble their available edges;
// the two incomplete faces use separately restored assets above.
const repairedFrames = {
  26: { box: [6, 38, 350, 350], tiles: [[26, 0]] },
  27: { box: [0, 78, 300, 300], tiles: [[27, 0]] },
  28: { box: [0, 72, 338, 338], tiles: [[27, -326], [28, 94]] },
  30: { box: [8, 70, 350, 350], tiles: [[30, 0]] },
  31: { box: [0, 72, 341, 341], tiles: [[30, -383], [31, 37]] },
  32: { box: [0, 72, 338, 338], tiles: [[31, -326], [32, 94]] },
};

/** Return the retained source regions for a consistently framed avatar. */
export function portraitFrameForEngineer(id) {
  const url = portraitForEngineer(id);
  if (!url) return null;
  const number = Number(url.match(/portrait-(\d+)/)[1]);
  const repaired = repairedFrames[number];
  return repaired ? { box: repaired.box, tiles: repaired.tiles.map(([tile, x]) => ({ url: `/engineer-portraits/portrait-${tile}.jpg?v=3`, x })) } : null;
}
