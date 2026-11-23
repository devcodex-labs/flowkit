import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, lstat, readdir, unlink, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactDigest } from '../src/shared/artifact-identity.mjs';
import { checkCandidate } from '../src/author/standard-artifact.mjs';

export const deliveryNames = Object.freeze(['workflow.js', 'workflow.mmd', 'workflow.html']);
const portableMarker = '<script type="application/json" id="flowkit-export-provenance">';
const htmlEnd = '</html>\n';
const portableType = 'flowkit-portable-export-v1';
const candidateFiles = ['SKILL.md', 'workflow.js', 'workflow.mmd'];
const encodeEnvelope = ({ publicKey, payload, signature }) =>
  JSON.stringify({ publicKey, payload, signature }).replace(/</g, '\\u003c');

export const escapeHtml = text => String(text).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const scriptHash = script => "'sha256-" + createHash('sha256').update(script).digest('base64') + "'";

export function graphPage({ title, source, renderer, controls = '' }) {
  const library = renderer.replace(/\r\n?/g, '\n').replace(/<\/script/gi, '<\\/script');
  const graph = JSON.stringify(source).replace(/</g, '\\u003c');
  const run = [
    "const out = document.getElementById('diagram');",
    "mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', flowchart: { useMaxWidth: false } });",
    "mermaid.render('flowkit-diagram', JSON.parse(document.getElementById('flowkit-source').textContent))",
    ".then(({ svg }) => { out.innerHTML = svg; document.querySelectorAll('button:disabled').forEach(button => { button.disabled = false; }); })",
    ".catch(() => { out.textContent = '流程图未能渲染，请刷新预览重试。'; out.dataset.status = 'failed'; });"
  ].join('\n');
  return '<!doctype html>\n<html lang="zh-CN"><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src ' + scriptHash(library) + ' ' +
    scriptHash(run) + '; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'self\'">' +
    '<title>' + escapeHtml(title) + '</title><style>body{max-width:1100px;margin:32px auto;padding:0 22px;font:16px system-ui}' +
    'h1{font-size:1.5rem}#diagram{border:1px solid #bec9d4;padding:16px;overflow:auto}button{margin:12px 0;padding:8px 16px}' +
    'a{color:#164e9b}</style><main><h1>' + escapeHtml(title) + '</h1><section id="diagram" aria-live="polite">正在渲染流程图</section>' +
    controls + '</main><script type="application/json" id="flowkit-source">' + graph + '</script><script>' +
    library + '</script><script>' + run + '</script></html>\n';
}

export function newExportKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
  };
}

function decodeExportPublicKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{59}$/.test(value)) throw new TypeError('Invalid FlowKit export public key');
  const key = createPublicKey({ key: Buffer.from(value, 'base64url'), type: 'spki', format: 'der' });
  if (key.asymmetricKeyType !== 'ed25519' || key.export({ type: 'spki', format: 'der' }).toString('base64url') !== value) {
    throw new TypeError('Invalid FlowKit export public key');
  }
  return key;
}

export function exportTrust(keys = []) {
  if (!Array.isArray(keys) || keys.length > 128) throw new TypeError('trustedExportKeys must be an array of at most 128 public keys');
  return new Map(keys.map(value => [value, decodeExportPublicKey(value)]));
}

export function canExportPortable({ files, manifest }) {
  return Object.keys(files).length === candidateFiles.length && candidateFiles.every(name => Object.hasOwn(files, name)) &&
    !manifest.professionalSkills?.length && !manifest.documents?.length && !manifest.safetyPolicies?.length;
}

export function publicDelivery(candidate, renderer, key) {
  const source = candidate.files['workflow.mmd'];
  const script = candidate.files['workflow.js'];
  if (typeof source !== 'string' || typeof script !== 'string') throw new Error('Candidate does not contain a compiled workflow and diagram');
  let html = graphPage({ title: candidate.manifest.name + ' ' + candidate.manifest.version, source, renderer });
  if (key && canExportPortable(candidate)) {
    const payload = JSON.stringify({ type: portableType, htmlHash: artifactDigest(html), manifest: candidate.manifest,
      candidateHash: candidate.hash, skill: candidate.files['SKILL.md'] });
    const signer = createPrivateKey({ key: Buffer.from(key.privateKey, 'base64url'), type: 'pkcs8', format: 'der' });
    const envelope = encodeEnvelope({ publicKey: key.publicKey, payload,
      signature: sign(null, Buffer.from(payload), signer).toString('base64url') });
    html = html.slice(0, -htmlEnd.length) + portableMarker + envelope + '</script>' + htmlEnd;
  }
  return {
    'workflow.js': script,
    'workflow.mmd': source,
    'workflow.html': html
  };
}

export function readPortableExport(files, trust) {
  const html = files['workflow.html'];
  if (typeof html !== 'string') return {};
  const start = html.indexOf(portableMarker);
  if (start === -1) return {};
  try {
    const end = '</script>' + htmlEnd;
    if (!html.endsWith(end) || start !== html.lastIndexOf(portableMarker)) return { invalid: true };
    const encoded = html.slice(start + portableMarker.length, -end.length);
    const envelope = JSON.parse(encoded);
    const { publicKey, payload, signature } = envelope;
    if (encoded !== encodeEnvelope(envelope) || typeof payload !== 'string' ||
        typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return { invalid: true };
    const signatureBytes = Buffer.from(signature, 'base64url');
    if (signatureBytes.toString('base64url') !== signature ||
        !verify(null, Buffer.from(payload), trust.get(publicKey) ?? decodeExportPublicKey(publicKey), signatureBytes)) {
      return { invalid: true };
    }
    const data = JSON.parse(payload);
    if (data.type !== portableType || data.htmlHash !== artifactDigest(html.slice(0, start) + htmlEnd)) return { invalid: true };
    const candidate = { manifest: data.manifest, hash: data.candidateHash,
      files: { 'SKILL.md': data.skill, 'workflow.js': files['workflow.js'], 'workflow.mmd': files['workflow.mmd'] } };
    checkCandidate(candidate);
    if (!canExportPortable(candidate)) return { invalid: true };
    return trust.has(publicKey) ? { candidate } : { untrusted: true };
  } catch { return { invalid: true }; }
}

export async function deliveryMatches(directory, hashes) {
  try {
    if (!(await lstat(directory)).isDirectory()) return false;
    const members = (await readdir(directory)).sort();
    if (JSON.stringify(members) !== JSON.stringify([...deliveryNames].sort())) return false;
    const matches = await Promise.all(deliveryNames.map(async name =>
      (await lstat(path.join(directory, name))).isFile() && artifactDigest(await readFile(path.join(directory, name))) === hashes[name]));
    return matches.every(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function commitDelivery(root, directory, files, hashes) {
  await mkdir(root, { recursive: true });
  if (await deliveryMatches(directory, hashes)) return;
  try { await lstat(directory); throw new Error('Export directory conflicts with existing files'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stage = await mkdtemp(path.join(root, '.flowkit-export-'));
  try {
    for (const name of deliveryNames) await writeFile(path.join(stage, name), files[name], { flag: 'wx' });
    try { await rename(stage, directory); }
    catch (error) { if (!(await deliveryMatches(directory, hashes))) throw error; }
  } finally {
    for (const name of deliveryNames) await unlink(path.join(stage, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(stage).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
