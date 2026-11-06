import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../../', import.meta.url);
export async function expectedReadme(text) {
  const blocks = [];
  for (const [name, language] of [['sample.workflow.js', 'js'], ['host.mjs', 'js']]) {
    const source = await readFile(new URL(`examples/docs/quick-start/${name}`, root), 'utf8');
    blocks.push(`**${name}**\n\n\`\`\`${language}\n${source.trimEnd()}\n\`\`\``);
  }
  const pattern = /<!-- flowkit:quick-start:start -->[\s\S]*?<!-- flowkit:quick-start:end -->/g;
  if ([...text.matchAll(pattern)].length !== 1) throw new Error('README must contain exactly one quick-start region');
  return text.replace(pattern, `<!-- flowkit:quick-start:start -->\n${blocks.join('\n\n')}\n<!-- flowkit:quick-start:end -->`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const filename = new URL('README.md', root);
  await writeFile(filename, await expectedReadme(await readFile(filename, 'utf8')));
  console.log('README quick-start synchronized from executable files');
}
