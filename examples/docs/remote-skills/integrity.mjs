import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
console.log('sha256-' + createHash('sha256').update(await readFile(new URL('./skill.md', import.meta.url))).digest('base64'));
