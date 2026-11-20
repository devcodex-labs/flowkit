import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const repo = fileURLToPath(new URL('../', import.meta.url));
const runtimeSource = path.join(repo, 'src');
const pluginSource = path.join(repo, 'plugins', 'flowkit-codex');
const acornPackage = path.join(repo, 'node_modules', 'acorn');
const skillFolder = path.join('skills', 'flowkit-author');
const json = value => JSON.stringify(value, null, 2) + '\n';

async function copy(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function bundleCompiler(plugin, version) {
  const bundled = path.join(plugin, 'runtime');
  const acornFile = path.join(bundled, 'vendor', 'acorn.mjs');
  const installed = JSON.parse(await readFile(path.join(acornPackage, 'package.json'), 'utf8'));
  if (installed.version !== version) throw new Error('Install the locked Acorn version with npm ci');
  await copy(path.join(acornPackage, 'dist', 'acorn.mjs'), acornFile);
  await copy(path.join(acornPackage, 'LICENSE'), path.join(bundled, 'vendor', 'acorn.LICENSE'));

  const queue = new Set(['author/standard-artifact.mjs']);
  for (const module of queue) {
    const original = path.join(runtimeSource, module);
    const destination = path.join(bundled, module);
    const source = await readFile(original, 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const imports = ast.body.filter(statement => statement.source).map(statement => statement.source);
    let bundledSource = source;
    for (const specifier of imports.reverse()) {
      const dependency = specifier.value;
      if (isBuiltin(dependency)) continue;
      if (dependency === 'acorn') {
        const relative = path.relative(path.dirname(destination), acornFile).split(path.sep).join('/');
        const local = relative.startsWith('.') ? relative : './' + relative;
        bundledSource = bundledSource.slice(0, specifier.start) + JSON.stringify(local) + bundledSource.slice(specifier.end);
        continue;
      }
      const relative = path.relative(runtimeSource, path.resolve(path.dirname(original), dependency));
      if (!dependency.startsWith('.') || relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith('.mjs')) {
        throw new Error(`Unsupported dependency in the Codex compiler bundle: ${dependency} (${module})`);
      }
      queue.add(relative.split(path.sep).join('/'));
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bundledSource, 'utf8');
  }
}

export async function buildCodexMarketplace(outputParent = path.join(repo, '.tmp')) {
  const pkg = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(pluginSource, 'plugin.json'), 'utf8'));
  await mkdir(outputParent, { recursive: true });
  const marketplace = await mkdtemp(path.join(path.resolve(outputParent), 'flowkit-codex-'));
  const relativePlugin = `./plugins/${manifest.name}`;
  const plugin = path.join(marketplace, relativePlugin);
  const skill = path.join(plugin, skillFolder);

  await copy(path.join(pluginSource, 'plugin.json'), path.join(plugin, 'plugin.json'));
  await copy(path.join(repo, 'LICENSE'), path.join(plugin, 'LICENSE'));
  await copy(path.join(pluginSource, skillFolder, 'SKILL.md'), path.join(skill, 'SKILL.md'));
  await copy(path.join(pluginSource, skillFolder, 'scripts', 'workflow.mjs'), path.join(skill, 'scripts', 'workflow.mjs'));
  const canonicalSkill = await readFile(path.join(runtimeSource, 'author', 'flowkit-workflow-author', 'SKILL.md'), 'utf8');
  const dslSection = canonicalSkill.replaceAll('\r\n', '\n').split('\n## DSL 生成参考\n')[1];
  if (!dslSection) throw new Error('Missing DSL reference in the FlowKit Author Skill');
  await mkdir(path.join(skill, 'references'));
  await writeFile(path.join(skill, 'references', 'dsl.md'), '# DSL 生成参考\n' + dslSection, 'utf8');
  await writeFile(path.join(plugin, 'package.json'), json({ private: true, type: 'module', version: pkg.version }), 'utf8');
  await bundleCompiler(plugin, pkg.dependencies.acorn);

  const legacy = path.join(plugin, '.codex-plugin');
  await mkdir(legacy);
  const { name, version, description, author, extensions } = manifest;
  await writeFile(path.join(legacy, 'plugin.json'), json({
    name, version, description, author, skills: './skills', interface: extensions['com.openai'].interface
  }), 'utf8');

  const entry = path.join(marketplace, '.agents', 'plugins');
  await mkdir(entry, { recursive: true });
  await writeFile(path.join(entry, 'marketplace.json'), json({
    name: 'flowkit-local',
    plugins: [{ name, source: { source: 'local', path: relativePlugin },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }]
  }), 'utf8');
  return { marketplace, plugin, selector: `${name}@flowkit-local`, version, compilerVersion: pkg.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildCodexMarketplace()));
}
