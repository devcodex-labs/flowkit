import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = path.join(repo, 'plugins', 'flowkit-mcp', '.codex-plugin', 'plugin.json');
const json = value => JSON.stringify(value, null, 2) + '\n';

export async function buildCodexMarketplace(outputParent = path.join(repo, '.tmp'), {
  url = 'http://127.0.0.1:8765/mcp', tokenEnv = 'FLOWKIT_MCP_TOKEN'
} = {}) {
  const endpoint = new URL(url);
  if (!(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1') ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw new TypeError('FlowKit MCP needs a loopback HTTP or HTTPS endpoint and a credential environment variable name');
  }
  const { name, version } = JSON.parse(await readFile(manifestPath, 'utf8'));
  await mkdir(outputParent, { recursive: true });
  const marketplace = await mkdtemp(path.join(path.resolve(outputParent), 'flowkit-mcp-'));
  const relativePlugin = `./plugins/${name}`;
  const plugin = path.join(marketplace, relativePlugin);
  const compatibility = path.join(plugin, '.codex-plugin');
  await mkdir(compatibility, { recursive: true });
  await copyFile(manifestPath, path.join(compatibility, 'plugin.json'));
  await writeFile(path.join(plugin, '.mcp.json'), json({
    mcpServers: { flowkit: { type: 'http', url: endpoint.href, bearer_token_env_var: tokenEnv } }
  }), 'utf8');

  const entry = path.join(marketplace, '.agents', 'plugins');
  await mkdir(entry, { recursive: true });
  await writeFile(path.join(entry, 'marketplace.json'), json({
    name: 'flowkit-local',
    plugins: [{ name, source: { source: 'local', path: relativePlugin },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }]
  }), 'utf8');
  return { marketplace, plugin, selector: `${name}@flowkit-local`, version, url: endpoint.href };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildCodexMarketplace(undefined, {
    url: process.env.FLOWKIT_MCP_URL, tokenEnv: process.env.FLOWKIT_MCP_TOKEN_ENV
  })));
}
