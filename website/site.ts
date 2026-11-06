import { readFileSync } from 'node:fs';
import { publicUrl } from './scripts/routes.mjs';
export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
export const base = '/flowkit/';
export const repository = 'https://github.com/devcodex-labs/flowkit';
export const siteUrl = 'https://devcodex-labs.github.io/flowkit/';
export { publicUrl };
