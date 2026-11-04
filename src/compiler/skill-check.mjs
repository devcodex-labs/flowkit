import path from 'node:path';
import { stat } from 'node:fs/promises';
import { diagnostic } from './source.mjs';
import { localSkillPath as localPath, remoteSkillURL as remoteURL, validIntegrity, allowedSkillHost, validAgentPath } from '../shared/skill-ref.mjs';
export { validIntegrity } from '../shared/skill-ref.mjs';

/** Static reference checks never fetch or read Skill content. */
export async function checkSkills(literal, context) {
  const diagnostics = [];
  if (!Array.isArray(literal.definition.nodes)) return diagnostics;
  for (const [index, node] of literal.definition.nodes.entries()) {
    const pointer = `/nodes/${index}`;
    if (literal.constructors.get(pointer).kind !== 'node') continue;
    const explicit = Object.hasOwn(node, 'skill');
    const field = explicit ? 'skill' : 'agent';
    const report = (code, message, key = field) => diagnostics.push(diagnostic(context.source, code, message,
      literal.locations.get(`${pointer}/${key}`) ?? literal.locations.get(pointer), node.id));
    const hasIntegrity = Object.hasOwn(node, 'integrity');
    let reference;
    if (explicit) reference = node.skill;
    else if (typeof node.agent === 'string' && node.agent.length) {
      // Validate the agent's raw segments before joining; never normalize away traversal.
      if (!validAgentPath(node.agent)) { report('FK_C052', 'Invalid mapped agent path'); continue; }
      reference = `${context.skillsRoot.replace(/\/$/, '')}/${node.agent}.md`;
    } else {
      if (hasIntegrity) report('FK_C058', 'Integrity requires an explicit HTTPS skill', 'integrity');
      continue;
    }
    const candidate = explicit ? reference : context.skillsRoot;
    const remote = typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate) &&
      (explicit || !/^[A-Za-z]:[\\/]/.test(candidate));
    if (remote) {
      const url = remoteURL(reference);
      if (!url) report('FK_C052', 'Invalid HTTPS Skill URL');
      else if (!allowedSkillHost(url, context.remoteSkillHosts)) report('FK_C057', 'Remote Skill host is not allowed');
      if (hasIntegrity) {
        if (!explicit || !url || !validIntegrity(node.integrity)) report('FK_C058', 'Invalid integrity or use location', 'integrity');
      } else if (url) report('FK_C059', 'Remote Skill has no integrity');
    } else {
      if (hasIntegrity) report('FK_C058', 'Integrity requires an explicit HTTPS skill', 'integrity');
      // Absolute local skillsRoot is a host option, unlike a relative DSL skill reference.
      const valid = explicit ? localPath(reference) : localPath(`${node.agent}.md`);
      if (!valid) { report('FK_C052', 'Invalid relative Skill path'); continue; }
      if (context.skillCheck) {
        try {
          const target = explicit ? path.resolve(context.projectRoot, reference)
            : path.resolve(context.projectRoot, context.skillsRoot, `${node.agent}.md`);
          if (!(await stat(target)).isFile()) report('FK_C051', 'Local Skill is not a file');
        } catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes(error.code)) report('FK_C051', 'Local Skill is missing');
          else throw error;
        }
      }
    }
  }
  return diagnostics;
}
