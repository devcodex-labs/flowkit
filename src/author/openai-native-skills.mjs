import { setTimeout as delay } from 'node:timers/promises';
import { checkProfessionalSkill } from './professional-skills.mjs';
import { checkCandidate } from './standard-artifact.mjs';

const nativeId = value => typeof value === 'string' && value.length > 0 && !/[^a-zA-Z0-9_-]/.test(value);
const exactVersion = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && value === value.trim();

/** The Host owns credentials, permissions and the Responses invocation. */
export function createOpenAINativeSkillPort({ request, authorizeUpload, visibilityDelaysMs }) {
  if (typeof request !== 'function' || typeof authorizeUpload !== 'function' || !Array.isArray(visibilityDelaysMs) ||
    visibilityDelaysMs.some(ms => !Number.isSafeInteger(ms) || ms < 0 || ms > 2147483647)) {
    throw new TypeError('OpenAI native Skills require a Host transport, approval verifier and finite visibility retry policy');
  }
  const waits = [...visibilityDelaysMs];
  const visibilityPending = new WeakSet();

  return Object.freeze({
    async upload(candidate, approvalRef, signal) {
      const snapshot = structuredClone(candidate);
      if (snapshot.manifest.kind === 'professional') checkProfessionalSkill(snapshot);
      else checkCandidate(snapshot);
      const { name, collectionId, skillId } = snapshot.manifest;
      if (typeof approvalRef !== 'string' || !approvalRef.trim() ||
        await authorizeUpload(Object.freeze({ approvalRef, candidateHash: snapshot.hash, collectionId, skillId, name })) !== true) {
        throw new Error('Host denied OpenAI Skill upload');
      }
      signal?.throwIfAborted();
      const files = Object.entries(snapshot.files);
      if (files.length > 500 || files.some(([, body]) => Buffer.byteLength(body, 'utf8') > 25_000_000)) {
        throw new Error('Asset exceeds OpenAI Skill upload limits');
      }
      const body = new FormData();
      for (const [file, contents] of files) {
        body.append('files[]', new Blob([contents], { type: file.endsWith('.md') ? 'text/markdown' : 'text/plain' }), `${name}/${file}`);
      }
      const response = await request('/v1/skills', { method: 'POST', body, signal });
      if (!response.ok) throw new Error(`OpenAI Skill upload returned HTTP ${response.status}`);
      const record = await response.json();
      if (record.object !== 'skill' || record.name !== name || !nativeId(record.id) || !exactVersion(record.default_version)) {
        throw new Error('OpenAI Skill upload returned an unverified identity');
      }
      const binding = Object.freeze({ nativeSkillId: record.id, nativeVersion: record.default_version,
        candidateHash: snapshot.hash, name, collectionId, skillId });
      visibilityPending.add(binding);
      return binding;
    },
    async prepareMount(binding, signal) {
      if (!nativeId(binding.nativeSkillId) || !exactVersion(binding.nativeVersion)) {
        throw new TypeError('OpenAI Skill attachment requires a precise provider version');
      }
      const retry = visibilityPending.has(binding) ? waits : [];
      visibilityPending.delete(binding);
      const target = `/v1/skills/${binding.nativeSkillId}/versions/${binding.nativeVersion}`;
      for (let i = 0; i <= retry.length; i++) {
        signal?.throwIfAborted();
        const response = await request(target, { method: 'GET', signal });
        if (response.status === 404 && i < retry.length) {
          await delay(retry[i], undefined, { signal });
          continue;
        }
        if (!response.ok) throw new Error(`OpenAI Skill version lookup returned HTTP ${response.status}`);
        const record = await response.json();
        if (record.object !== 'skill.version' || record.skill_id !== binding.nativeSkillId || record.version !== binding.nativeVersion ||
          record.name !== binding.name || !nativeId(record.id)) throw new Error('OpenAI returned a different Skill version');
        return Object.freeze({ reference: Object.freeze({ type: 'skill_reference', skill_id: record.skill_id, version: record.version }),
          versionId: record.id, activation: 'unobserved' });
      }
    }
  });
}
