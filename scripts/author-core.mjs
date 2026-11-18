import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { compileArtifactDraft } from '../src/compiler/api.mjs';
import { artifactDigest, standardIdentity } from '../src/shared/artifact-identity.mjs';

export const generatedAuthorFiles = ['dist/author/core/workflow.js', 'dist/author/core/workflow.mmd', 'dist/author/core/identity.json'];

/** Compile the approved internal DSL with the production compiler, never by importing DSL code. */
export async function authorCoreFiles(root) {
  const file = path.join(root, 'src/author/core.workflow.js');
  const { artifact } = await compileArtifactDraft(file, { projectRoot: root, skillCheck: false });
  if (!artifact.artifactHash || artifact.diagnostics.some(item => item.severity === 'error')) {
    throw new Error('Author core compilation failed: ' + JSON.stringify(artifact.diagnostics));
  }
  const identity = { schemaVersion: 1, workflowId: 'flowkit-author-core', version: '1.2.0',
    sourceHash: artifactDigest(await readFile(file)), ...standardIdentity(artifact.code),
    mermaidHash: artifactDigest(artifact.mermaid) };
  return new Map([[generatedAuthorFiles[0], artifact.code], [generatedAuthorFiles[1], artifact.mermaid],
    [generatedAuthorFiles[2], JSON.stringify(identity, null, 2) + '\n']]);
}
