import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { prepareStandardSkill, reviewStandardCandidate } from '../../../runtime/author/standard-artifact.mjs';
import { artifactDigest } from '../../../runtime/shared/artifact-identity.mjs';

const authoringProfile = Object.freeze({ id: 'codex-local-authoring', digest: artifactDigest('codex-local-authoring-v1') });
const exportPaths = ['SKILL.md', 'workflow.js', 'workflow.mmd', 'source/workflow.dsl.js'];
const readJson = async filename => JSON.parse(await readFile(filename, 'utf8'));

async function writeNewFile(filename, value) {
  const handle = await open(filename, 'wx');
  try {
    try { await handle.writeFile(value, 'utf8'); }
    finally { await handle.close(); }
  } catch (error) {
    await unlink(filename);
    throw error;
  }
}

async function prepare(file, metadataFile, candidateFile) {
  const metadata = await readJson(metadataFile);
  if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object' ||
    Object.keys(metadata).some(key => !['name', 'description', 'version', 'includeSource', 'professionalSkills'].includes(key))) {
    throw new TypeError('Expected FlowKit candidate metadata');
  }
  const { name, description, version, includeSource, professionalSkills } = metadata;
  const result = await prepareStandardSkill({
    file, collectionId: 'codex-local', skillId: name, name, description, version,
    includeSource, professionalSkills, buildId: randomUUID(), hostProfile: authoringProfile,
    compilerOptions: { projectRoot: process.cwd() }
  });
  if (!result.candidate) {
    process.exitCode = 1;
    return { diagnostics: result.diagnostics };
  }
  await writeNewFile(candidateFile, JSON.stringify(result.candidate, null, 2) + '\n');
  return { candidateFile: path.resolve(candidateFile), candidateHash: result.candidate.hash, diagnostics: result.diagnostics };
}

async function exportCandidate(candidateFile, reviewedHash, destination) {
  const candidate = await readJson(candidateFile);
  const review = reviewStandardCandidate(candidate);
  if (review.candidateHash !== reviewedHash) throw new Error('Candidate changed. Review the exact candidate before exporting.');
  const names = Object.keys(candidate.files);
  if (names.some(name => !exportPaths.includes(name))) throw new Error('Unexpected file in Codex export');

  const root = path.resolve(destination);
  await mkdir(root);
  const written = [];
  let sourceDirectory;
  try {
    for (const name of names) {
      const filename = path.join(root, name);
      if (name === 'source/workflow.dsl.js') {
        await mkdir(path.dirname(filename));
        sourceDirectory = path.dirname(filename);
      }
      await writeNewFile(filename, candidate.files[name]);
      written.push(filename);
    }
  } catch (error) {
    for (const filename of written) await unlink(filename);
    if (sourceDirectory) await rmdir(sourceDirectory);
    await rmdir(root);
    throw error;
  }
  return { directory: root, files: names, candidateHash: review.candidateHash, artifactHash: candidate.manifest.artifactHash };
}

async function main([command, ...args]) {
  if (command === 'prepare' && args.length === 3) return prepare(...args);
  if (command === 'review' && (args.length === 1 || args.length === 2)) {
    return reviewStandardCandidate(await readJson(args[0]), args[1] ? await readJson(args[1]) : null);
  }
  if (command === 'export' && args.length === 3) return exportCandidate(...args);
  throw new Error('Use prepare <dsl> <metadata> <candidate>, review <candidate> [previous], or export <candidate> <reviewed-hash> <new-directory>');
}

try {
  console.log(JSON.stringify(await main(process.argv.slice(2))));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
