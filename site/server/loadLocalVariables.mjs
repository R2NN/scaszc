import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Production and development use the same local, server-only credentials file.
// Explicit environment variables always win over values from .dev.vars.
export function loadLocalVariables(file = resolve('.dev.vars')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const name = trimmed.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || process.env[name]) continue;
    process.env[name] = trimmed.slice(separator + 1).trim();
  }
}
