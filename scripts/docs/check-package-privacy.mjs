import assert from 'node:assert/strict';

/** Verify actual GitHub Packages metadata, not merely the repository visibility. */
export async function checkPrivatePackage({ token = process.env.GITHUB_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  if (!token || typeof token !== 'string') throw new Error('GITHUB_TOKEN required to verify package privacy');
  const base = 'https://api.github.com/orgs/devcodex-labs/packages/npm/';
  // The Packages API may expose the npm package under its scoped or unscoped name.
  const candidates = ['%40devcodex-labs%2Fflowkit', 'flowkit'];
  for (const name of candidates) {
    const response = await fetchImpl(base + name, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`GitHub Package metadata request failed: HTTP ${response.status}`);
    const pkg = await response.json();
    assert.equal(pkg.owner?.login?.toLowerCase(), 'devcodex-labs', 'Wrong package owner');
    assert.equal(pkg.package_type, 'npm', 'Wrong package type');
    assert.ok(['@devcodex-labs/flowkit', 'flowkit'].includes(pkg.name), 'Wrong npm package identity');
    assert.equal(pkg.visibility, 'private', 'GitHub Package must be private before documenting a release');
    return { package: pkg.name, visibility: pkg.visibility, verified: true };
  }
  throw new Error('Private GitHub Package metadata is unavailable for the expected package');
}
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1].replaceAll('\\', '/')).href) {
  const result = await checkPrivatePackage();
  console.log(JSON.stringify(result));
}
