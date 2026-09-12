#!/usr/bin/env node
// Local operator helper. No setup service, credential store, or workflow runner.
import { createSign, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const permissions = {
  cadence: { metadata: 'read', contents: 'read', actions: 'read', pull_requests: 'write', issues: 'write', checks: 'write' },
  symphony: { metadata: 'read', contents: 'write', actions: 'read', pull_requests: 'write', issues: 'write', checks: 'read', statuses: 'read', workflows: 'write' },
};
class SetupError extends Error {}
const fail = message => { throw new SetupError(message); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const slug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(value);
const id = value => Number.isSafeInteger(value) && value > 0;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export function checkPermissions(actual, required) {
  for (const [name, level] of Object.entries(required)) {
    // GitHub may omit the implicit metadata read grant.
    if (name === 'metadata' && level === 'read' && actual?.metadata === undefined) continue;
    if (!(actual?.[name] === 'write' || (level === 'read' && actual?.[name] === 'read'))) {
      fail(`Missing ${name}:${level}; the installation owner must accept this grant.`);
    }
  }
}

export function manifestFor(input, role, name) {
  if (!permissions[role]) fail('Role must be cadence or symphony.');
  const allowed = ['name', 'url', 'description', 'public', 'default_events', 'default_permissions'];
  if (!input || Object.keys(input).some(key => !allowed.includes(key))) fail('Use an inert manifest with only the documented fields.');
  const manifest = { ...input, name: name || input.name };
  if (!slug(manifest.name)) fail('Use a slug-shaped App name (letters, numbers, hyphens).');
  if (!/^https:\/\//.test(manifest.url) || typeof manifest.public !== 'boolean' || !Array.isArray(manifest.default_events) || manifest.default_events.length) {
    fail('Manifest needs an HTTPS homepage, explicit public flag and empty default_events.');
  }
  // These presets deliberately exclude administrative and provider privileges.
  if (JSON.stringify(Object.entries(manifest.default_permissions || {}).sort()) !== JSON.stringify(Object.entries(permissions[role]).sort())) {
    fail(`Manifest permissions must match the reviewed ${role} preset.`);
  }
  return manifest;
}

function command(argv, input, token) {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1' };
  delete env.GH_DEBUG;
  if (token) { env.GH_TOKEN = token; delete env.GITHUB_TOKEN; }
  const result = spawnSync(argv[0], argv.slice(1), { input, env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const status = result.stderr?.match(/HTTP (\d{3})/)?.[1];
    // Never echo command arguments, API responses or provisioning stderr.
    fail(`Command failed${status ? ` (HTTP ${status})` : ''}; check operator access and the selected configuration. Output withheld.`);
  }
  return result.stdout;
}

export async function api(path, { token, method = 'GET', body } = {}) {
  if (path.startsWith('app-manifests/') || token?.split('.').length === 3) {
    // gh uses "token" auth; App JWTs require "Bearer". Keep both JWTs and the
    // conversion code out of process arguments by making these calls in memory.
    const response = await fetch(`https://api.github.com/${path}`, { method,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000), redirect: 'error' });
    if (!response.ok) fail(`GitHub App API failed (HTTP ${response.status}); inspect the existing App and grants before retrying.`);
    return response.status === 204 ? null : response.json();
  }
  const args = ['gh', 'api', '--hostname', 'github.com', '--method', method, path,
    '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
  if (body) args.push('--input', '-');
  const output = command(args, body ? JSON.stringify(body) : undefined, token);
  return output.trim() ? JSON.parse(output) : null;
}

function appIdentity(app) {
  if (!id(app?.id) || !slug(app.slug)) fail('Invalid App identity readback.');
  return { id: app.id, slug: app.slug, botLogin: `${app.slug}[bot]` };
}

export async function prepare(options, request = api) {
  const { owner, role, manifest: manifestPath, name, repositories, 'other-app': other, 'existing-app': existing } = options;
  if (!slug(owner) || !slug(other) || (existing && !slug(existing))) fail('Supply owner and the other role\'s App slug.');
  const repos = [...new Set((repositories || '').split(',').map(value => value.trim()))].sort();
  if (!repos.length || repos.length > 500 || repos.some(repo => !/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(repo) || !same(repo.split('/')[0], owner))) {
    fail('Repositories must be comma-separated OWNER/REPO names belonging to owner (maximum 500).');
  }
  const manifest = manifestFor(json(manifestPath), role, name);
  const directory = resolve(options.directory);
  const statePath = join(directory, 'state.json');
  const config = { owner, role, repositories: repos, otherApp: other, manifest, existingApp: existing || null };
  if (existsSync(statePath)) {
    const previous = json(statePath);
    if (JSON.stringify(previous.config) !== JSON.stringify(config)) fail('Setup directory belongs to different inputs; reuse its original inputs or choose another directory.');
    return previous;
  }
  // Do not put resume material inside a Git checkout or overwrite any directory.
  if (existsSync(directory)) fail('Choose a new directory outside the checkout.');
  const account = await request(`users/${owner}`);
  if (!same(account.login, owner) || !['User', 'Organization'].includes(account.type)) fail('Owner readback mismatch.');
  if (account.type === 'User') {
    const viewer = await request('user');
    if (!same(viewer.login, owner)) fail('Personal App registration requires gh and browser signed in as owner.');
  }
  for (const repo of repos) {
    const actual = await request(`repos/${repo}`);
    if (!same(actual.full_name, repo)) fail('Repository readback mismatch.');
  }
  // The other role may still need registration. Resolve its ID during verify.
  const otherApp = { slug: other };
  if (same(manifest.name, otherApp.slug)) fail('Author and reviewer must be different Apps.');
  const state = { config, otherApp, nonce: randomBytes(24).toString('hex'), createdAt: Date.now() };
  if (existing) {
    state.app = appIdentity(await request(`apps/${existing}`));
    if (same(state.app.slug, otherApp.slug)) fail('Author and reviewer must be different Apps.');
  }
  let parent = directory;
  while (parent !== resolve(parent, '..')) {
    if (existsSync(join(parent, '.git'))) fail('Setup directory must be outside a Git checkout.');
    parent = resolve(parent, '..');
  }
  mkdirSync(directory, { mode: 0o700 });
  save(statePath, state);
  if (!existing) {
    const registration = account.type === 'Organization' ? `https://github.com/organizations/${owner}/settings/apps/new` : 'https://github.com/settings/apps/new';
    const escaped = JSON.stringify({ ...manifest, redirect_url: 'http://127.0.0.1:8765/callback' })
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    writeFileSync(join(directory, 'register.html'), `<!doctype html><meta charset="utf-8"><title>Register ${role} App</title>
<p>Confirm the owner and reviewed permissions on GitHub. Register only once.</p>
<form method="post" action="${registration}?state=${state.nonce}">
<input type="hidden" name="manifest" value="${escaped}"><button>Register ${manifest.name}</button></form>\n`, { mode: 0o600 });
  }
  return state;
}

export async function complete(directory, callback, keyCommand, request = api, provision = command) {
  const statePath = join(directory, 'state.json');
  const state = json(statePath);
  if (state.app) return state; // No conversion, key rotation or provisioning on repeats.
  if (state.conversionAttempted) fail('Conversion was already attempted. Recover the existing App in GitHub settings; do not register another.');
  if (Date.now() - state.createdAt > 3600000) fail('Registration session expired; inspect GitHub Apps before starting another registration.');
  const url = new URL(callback.trim());
  const code = url.searchParams.get('code');
  if (url.origin !== 'http://127.0.0.1:8765' || url.pathname !== '/callback' || url.searchParams.get('state') !== state.nonce || !/^[a-z0-9]+$/i.test(code || '')) fail('Invalid registration callback or state.');
  if (!Array.isArray(keyCommand) || !keyCommand.length || keyCommand.some(arg => typeof arg !== 'string' || !arg)) fail('Supply the secure provisioning command as a JSON argument array.');
  state.conversionAttempted = true;
  save(statePath, state); // Ambiguous API failures must not silently create a duplicate.
  const converted = await request(`app-manifests/${code}/conversions`, { method: 'POST' });
  state.app = appIdentity(converted);
  save(statePath, state); // Persist only nonsecret identity, even if provisioning fails.
  if (!same(converted.owner?.login, state.config.owner) || same(state.app.slug, state.otherApp.slug)) fail('Created App owner or role identity mismatch; inspect GitHub settings.');
  const readback = await request(`apps/${state.app.slug}`);
  if (readback.id !== state.app.id) fail('Created App identity readback mismatch.');
  checkPermissions(readback.permissions, state.config.manifest.default_permissions);
  if (!converted.pem?.includes('PRIVATE KEY')) fail('Conversion returned no private key; recover the existing App in settings.');
  provision(keyCommand, converted.pem); // Existing gh secret set / operator vault process, stdin only.
  state.keyHandedOff = true;
  save(statePath, state);
  return state;
}

export function validateReadback(state, app, installation, token, repositories) {
  if (app.id !== state.app.id || !same(app.slug, state.app.slug) || app.id === state.otherApp.id) fail('App/key or role identity mismatch.');
  if (!id(installation.id) || installation.app_id !== app.id || !same(installation.account?.login, state.config.owner) || installation.suspended_at !== null) fail('Installation owner/App mismatch or suspended installation.');
  if (!['all', 'selected'].includes(installation.repository_selection)) fail('Missing installation repository selection.');
  checkPermissions(installation.permissions, state.config.manifest.default_permissions);
  checkPermissions(token.permissions, state.config.manifest.default_permissions);
  if (state.config.role === 'cadence' && (installation.permissions.contents === 'write' || installation.permissions.workflows === 'write')) fail('Cadence must not have author contents/workflows write grants.');
  const wanted = state.config.repositories.map(value => value.toLowerCase()).sort();
  const actual = repositories.map(repo => repo.full_name?.toLowerCase()).sort();
  if (JSON.stringify(wanted) !== JSON.stringify(actual) || repositories.some(repo => !id(repo.id))) fail('Token repository selection does not match the requested repositories.');
  return { role: state.config.role, appId: app.id, appSlug: app.slug, botLogin: `${app.slug}[bot]`,
    installationId: installation.id, installationRepositorySelection: installation.repository_selection,
    repositories: repositories.map(({ id, full_name }) => ({ id, full_name })), permissions: token.permissions,
    status: 'App installation verified; provider, forwarding and live operations still require proof' };
}

export async function verify(state, pem, request = api) {
  if (!state.app) fail('Complete registration or select an existing App first.');
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: state.app.id })}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(pem, 'base64url')}`;
  const otherApp = appIdentity(await request(`apps/${state.config.otherApp}`));
  state = { ...state, otherApp };
  const app = await request('app', { token: jwt });
  if (app.id !== state.app.id || app.id === state.otherApp.id || !same(app.slug, state.app.slug)) fail('App/key or role identity mismatch.');
  const bot = await request(`users/${encodeURIComponent(`${app.slug}[bot]`)}`);
  if (!same(bot.login, `${app.slug}[bot]`) || bot.type !== 'Bot' || !id(bot.id)) fail('Bot login readback mismatch.');
  let installation;
  for (const repo of state.config.repositories) {
    const found = await request(`repos/${repo}/installation`, { token: jwt });
    if (installation && found.id !== installation.id) fail('Repositories do not share the same installation.');
    if (!id(found.id) || found.app_id !== app.id || found.suspended_at !== null || !same(found.account?.login, state.config.owner)) fail('Installation owner/App mismatch or suspended installation.');
    checkPermissions(found.permissions, state.config.manifest.default_permissions);
    installation = found;
  }
  const token = await request(`app/installations/${installation.id}/access_tokens`, { token: jwt, method: 'POST', body: {
    repositories: state.config.repositories.map(repo => repo.split('/')[1]), permissions: state.config.manifest.default_permissions,
  } });
  if (!token.token) fail('Installation token missing.');
  try {
    const repositories = [];
    for (let page = 1; ; page++) {
      const result = await request(`installation/repositories?per_page=100&page=${page}`, { token: token.token });
      repositories.push(...result.repositories);
      if (result.repositories.length < 100) break;
    }
    return validateReadback(state, app, installation, token, repositories);
  } finally {
    await request('installation/token', { token: token.token, method: 'DELETE' });
  }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(
    ['owner', 'role', 'name', 'repositories', 'manifest', 'directory', 'other-app', 'existing-app', 'key-command', 'key-file'].map(key => [key, { type: 'string' }])) });
  const [action] = positionals;
  if (!values.directory || positionals.length !== 1) fail('Use prepare, complete or verify with --directory; see APP-SETUP.md.');
  const directory = resolve(values.directory);
  let state;
  if (action === 'prepare') state = await prepare(values);
  else if (action === 'complete') {
    state = json(join(directory, 'state.json'));
    if (!state.app) {
      if (process.stdin.isTTY) fail('Pass the callback URL on stdin with terminal echo disabled; see APP-SETUP.md.');
      state = await complete(directory, readFileSync(0, 'utf8'), JSON.parse(values['key-command'] || 'null'));
    }
  } else if (action === 'verify') {
    state = json(join(directory, 'state.json'));
    if (!values['key-file']) fail('Supply --key-file with a protected PEM file or - for vault output on stdin.');
    const result = await verify(state, readFileSync(values['key-file'] === '-' ? 0 : values['key-file'], 'utf8'));
    save(join(directory, 'verification.json'), result);
    console.log(JSON.stringify(result, null, 2));
    return;
  } else fail('Expected prepare, complete or verify.');
  if (state.app) {
    console.log(JSON.stringify({ ...state.app, keyHandedOff: state.keyHandedOff === true, install: `https://github.com/apps/${state.app.slug}/installations/new` }, null, 2));
  } else console.log(`Open ${join(directory, 'register.html')} in your browser. After registration, copy the callback URL from the address bar into complete. No localhost server is required.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Parse/crypto errors can include secret-bearing input. Only our own messages are safe.
    console.error(error instanceof SetupError ? error.message : 'Invalid input or unavailable service; check configuration and access. Details withheld.');
    process.exitCode = 1;
  });
}
