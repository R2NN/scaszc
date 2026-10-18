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
  return '/engineer-portraits/portrait-' + primaryPortraitNumbers[index] + '.jpg?v=3';
}
