import { existsSync } from 'node:fs';
import path from 'node:path';

/** Resolve both the source checkout (site/ beside algorithm/) and flattened transfer ZIP. */
export function projectRoot(start = process.cwd()) {
  const current = path.resolve(start);
  if (existsSync(path.join(current, 'algorithm', 'tools'))) return current;
  const parent = path.dirname(current);
  if (existsSync(path.join(parent, 'algorithm', 'tools'))) return parent;
  throw new Error(`Не найдена папка algorithm рядом с ${current}`);
}
