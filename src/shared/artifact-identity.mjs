import { createHash } from 'node:crypto';

export const STANDARD_ABI = 2;
export const STANDARD_SEMANTICS = '2.0.0';
export const ARTIFACT_HEADER = '// @flowkit-artifact ';
export const STANDARD_ARTIFACT_HEADER = ARTIFACT_HEADER + JSON.stringify({ mode: 'standard',
  programAbiVersion: STANDARD_ABI, semanticsVersion: STANDARD_SEMANTICS });
export const artifactDigest = data => `sha256:${createHash('sha256').update(data).digest('hex')}`;

export function standardIdentity(code) {
  const compiler = /^\/\/ compiler: flowkit@(\S+) · /.exec(code.split('\n', 5)[4]);
  if (!compiler) throw Object.assign(new Error('FK_R001 Missing compiler version'), { code: 'FK_R001' });
  return { artifactHash: artifactDigest(code), compilerVersion: compiler[1], programAbiVersion: STANDARD_ABI,
    semanticsVersion: STANDARD_SEMANTICS };
}
/** Professional Skill identity covers the actual content of every packaged file. */
export function professionalSkillFileHashes(files) {
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, contents]) => [name, artifactDigest(contents)]));
}
