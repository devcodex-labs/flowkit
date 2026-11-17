import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flowkitProvider } from '../../src/integrations/capability-graph.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const contentPath = 'website/content/';
const documentId = /^[a-z][a-z0-9._-]{0,127}$/;
const pinnedUrl = /^https:\/\/raw\.githubusercontent\.com\/devcodex-labs\/flowkit\/([0-9a-f]{40})\/(website\/content\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.mdx)$/;
const states = new Set(['implemented', 'host-conditional', 'experimental', 'planned', 'reference']);
const referenceGroups = ['implementation', 'types', 'tests', 'examples'];
const repositoryUrl = 'https://github.com/devcodex-labs/flowkit/';
const maxDocumentBytes = 256 * 1024;

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const isText = value => typeof value === 'string' && value.trim().length > 0;

export function validateDocumentReferences(entry, body, references) {
  for (const group of referenceGroups) {
    const linked = references[group].some(target => ['blob', 'tree'].some(kind =>
      body.includes(`(${repositoryUrl}${kind}/main/${target})`)));
    assert(linked, `Missing ${group} link on core page: ${entry.id}`);
  }
}

export function validateDocumentCatalog(catalog, pages, files, version) {
  assert.equal(catalog.version, 1);
  assert.equal(catalog.flowkitVersion, version, 'Catalog target does not match FlowKit');
  assert.equal(catalog.minimumDocumentedVersion, version, 'Check the verified version range');
  assert.ok(isText(catalog.maintainer), 'Catalog maintainer is missing');
  const byId = new Map();
  const byPath = new Map();
  const navigation = new Map(pages.map(page => [contentPath + page.file, page]));
  for (const entry of catalog.documents) {
    const { id, path: filename, route, title, scope, topic, status, anchor } = entry;
    assert.match(id, documentId);
    assert(!byId.has(id), `Duplicate document ID: ${id}`);
    assert(!byPath.has(filename), `Duplicate document path: ${filename}`);
    assert.ok(isText(title) && isText(scope) && states.has(status), `Incomplete metadata: ${id}`);
    assert(Object.hasOwn(catalog.topics, topic), `Unknown document topic: ${topic}`);
    assert(anchor === undefined || anchor === id, `Anchor must match the stable ID: ${id}`);
    const page = navigation.get(filename);
    if (page) {
      assert.equal(route, page.route, `Route drift: ${id}`);
      assert.equal(title, page.title, `Title drift: ${id}`);
      assert.equal(scope, page.scope, `Scope drift: ${id}`);
    } else {
      assert(filename === 'README.md' && route === undefined ||
        filename === contentPath + '404.mdx' && route === '/404', `Unlisted navigation page: ${id}`);
    }
    byId.set(id, entry);
    byPath.set(filename, entry);
  }
  assert.deepEqual([...byPath.keys()].sort(), [...files].sort(), 'Document inventory does not match repository pages');
  for (const filename of navigation.keys()) assert(byPath.has(filename), `Missing navigation page: ${filename}`);
  for (const [topic, references] of Object.entries(catalog.topics)) {
    for (const group of referenceGroups) {
      assert(Array.isArray(references[group]) && references[group].length > 0 && references[group].every(isText),
        `Missing ${group} references: ${topic}`);
    }
  }
  return byId;
}

export function validateCapabilityDocuments(provider, byId) {
  assert.equal(provider.providerId, 'flowkit');
  assert.equal(provider.schemaVersion, 1);
  assert.match(provider.version, /^\d+\.\d+\.\d+$/);
  const capabilities = new Set();
  const documents = new Map();
  for (const capability of provider.capabilities) {
    assert.match(capability.id, documentId);
    assert(!capabilities.has(capability.id), `Duplicate capability ID: ${capability.id}`);
    capabilities.add(capability.id);
    assert(capability.documents?.length, `Capability lacks documents: ${capability.id}`);
    const seen = new Set();
    for (const ref of capability.documents) {
      const entry = byId.get(ref.id);
      assert(entry?.anchor, `Unknown or unanchored document: ${ref.id}`);
      assert(!seen.has(ref.id), `Duplicate document reference: ${capability.id}/${ref.id}`);
      seen.add(ref.id);
      assert(Object.keys(ref).every(key => ['id', 'title', 'source'].includes(key)));
      assert(ref.title === undefined || isText(ref.title), `Invalid document title: ${ref.id}`);
      assert.deepEqual(Object.keys(ref.source).sort(), ['type', 'url']);
      assert.equal(ref.source.type, 'url');
      const match = pinnedUrl.exec(ref.source.url);
      assert.equal(match?.[2], entry.path, `Unpinned or mismatched URL: ${ref.id}`);
      const known = documents.get(ref.id);
      if (known) assert.equal(ref.source.url, known.url, `Shared document identity drift: ${ref.id}`);
      else documents.set(ref.id, { id: ref.id, url: ref.source.url, commit: match[1], path: entry.path });
    }
  }
  assert.equal(new Set([...documents.values()].map(doc => doc.commit)).size, 1, 'Mixed documentation commits');
  return documents;
}

async function trustedPath(root, relative) {
  assert(!path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'), `Outside document root: ${relative}`);
  const absolute = await realpath(path.join(root, relative));
  const resolved = path.relative(root, absolute);
  assert(resolved && !path.isAbsolute(resolved) && !resolved.startsWith('..' + path.sep) && resolved !== '..',
    `Outside document root: ${relative}`);
  return absolute;
}

export async function checkCapabilityDocuments(root = projectRoot) {
  root = await realpath(root);
  const readJson = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
  const [catalog, pages, pkg, entries] = await Promise.all([
    readJson('website/docs-catalog.json'), readJson('website/coverage.json'), readJson('package.json'),
    readdir(path.join(root, contentPath), { recursive: true, withFileTypes: true }),
  ]);
  const files = entries.filter(entry => entry.name.endsWith('.mdx')).map(entry =>
    path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
  const byId = validateDocumentCatalog(catalog, pages, [...files, 'README.md'], pkg.version);
  const documents = validateCapabilityDocuments(flowkitProvider, byId);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const entry of byId.values()) {
    const filename = await trustedPath(root, entry.path);
    assert((await stat(filename)).isFile(), `Not a documentation file: ${entry.path}`);
    const body = decoder.decode(await readFile(filename));
    if (entry.anchor) {
      assert.equal(body.split(`<a id="${entry.anchor}"></a>`).length, 2, `Missing or duplicate anchor: ${entry.id}`);
      validateDocumentReferences(entry, body, catalog.topics[entry.topic]);
    }
  }
  for (const reference of new Set(Object.values(catalog.topics).flatMap(ref => referenceGroups.flatMap(group => ref[group])))) {
    await trustedPath(root, reference);
  }
  return { documents: [...documents.values()], catalogEntries: byId.size, providerVersion: flowkitProvider.version, flowkitVersion: pkg.version };
}

export async function readPinnedDocument(url, expectedBytes) {
  assert(pinnedUrl.test(url), 'Only fixed FlowKit documentation URLs may be read');
  assert(expectedBytes.length <= maxDocumentBytes, 'Expected document exceeds the byte limit');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error(`HTTPS document returned HTTP ${response.status}: ${url}`);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    assert(length <= maxDocumentBytes, `HTTPS document exceeds the byte limit: ${url}`);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, length);
  const sha256 = hash(bytes);
  assert.equal(sha256, hash(expectedBytes), `HTTPS bytes differ from the fixed Git object: ${url}`);
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { url, status: response.status, byteLength: length, sha256, readAt: new Date().toISOString() };
}

async function verifyPublishedDocuments(root, catalog) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: maxDocumentBytes * 2 });
  const objects = catalog.documents.map(document => {
    const object = `${document.commit}:${document.path}`;
    const pinnedBlob = git('rev-parse', object).toString().trim();
    // Compare Git's normalized object identity, not the checkout's platform-specific line endings.
    const currentBlob = git('hash-object', `--path=${document.path}`, document.path).toString().trim();
    assert.equal(pinnedBlob, currentBlob, `Bind the approved document commit before delivery: ${document.id}`);
    return { document, bytes: git('show', object) };
  });
  const evidence = [];
  for (const { document, bytes } of objects) {
    evidence.push({ id: document.id, commit: document.commit, ...await readPinnedDocument(document.url, bytes) });
  }
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert(args.length === 0 || args.length === 1 && args[0] === '--verify-https', 'Expected no option or --verify-https');
  const catalog = await checkCapabilityDocuments();
  const evidence = args.length ? await verifyPublishedDocuments(projectRoot, catalog) : [];
  console.log(JSON.stringify({ ...catalog, evidence }));
}
