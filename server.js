import express from 'express';
import yaml from 'js-yaml';
import semver from 'semver';
import { randomUUID } from 'crypto';
import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import { parseArgs } from 'util';
import { isSea, getAsset, getAssetKeys } from 'node:sea';
import pkg from './package.json' with { type: 'json' };

const HELP = `helm-versions ${pkg.version}
${pkg.description}

Usage: helm-versions [options]

Options:
  -p, --port <port>     HTTP port (env PORT, default 3000)
  -s, --sources <file>  chart list to read and save (env SOURCES_FILE)
                        default: ./sources.json in the current directory
                        (when run from the repo: the repo's sources.json)
                        created as an empty list if it does not exist
  -h, --help            show this help
  -v, --version         show the version
`;

let args;
try {
  args = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      sources: { type: 'string', short: 's' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  }).values;
} catch (err) {
  console.error(`${err.message}\n\n${HELP}`);
  process.exit(1);
}
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.version) {
  console.log(pkg.version);
  process.exit(0);
}

// As a single executable (Node SEA) the frontend and the default chart list are embedded assets
const SEA = isSea();

const PORT = args.port || process.env.PORT || 3000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TIMEOUT_MS = 15_000;
// Default: next to server.js; the executable has no app directory and uses the current directory
const DEFAULT_SOURCES = SEA ? 'sources.json' : fileURLToPath(new URL('./sources.json', import.meta.url));
const SOURCES_FILE = resolve(args.sources || process.env.SOURCES_FILE || DEFAULT_SOURCES);

// ---------- Helpers ----------

async function get(url, headers = {}) {
  return fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

// All valid semver versions, newest first, with a pre-release flag
function sortVersions(list) {
  return list
    .filter((v) => semver.valid(v.version, { loose: true }))
    .map((v) => ({ ...v, prerelease: !!semver.prerelease(v.version, { loose: true }) }))
    .sort((a, b) => semver.rcompare(a.version, b.version, { loose: true }));
}

// Latest stable version; pre-releases only if nothing else exists
const latest = (sorted) => sorted.find((v) => !v.prerelease) ?? sorted[0] ?? null;

const typeOf = (source) => (source.startsWith('oci://') ? 'oci' : 'http');

// Parse a JSON response; a registry that answers with HTML (e.g. a website redirect) gets a readable error
async function json(res, what) {
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) {
    throw new Error(`${what}: expected JSON but got ${type.split(';')[0] || 'unknown content'} from ${new URL(res.url).host} – is this a registry host?`);
  }
  return res.json();
}

// Docker Hub's registry API is not served under docker.io (same mapping as Helm/Docker)
const REGISTRY_ALIASES = { 'docker.io': 'registry-1.docker.io', 'index.docker.io': 'registry-1.docker.io' };

// ---------- HTTP repos (index.yaml) ----------

async function fromHttpRepo(repoUrl, chart) {
  const url = repoUrl.replace(/\/+$/, '') + '/index.yaml';
  const res = await get(url);
  if (!res.ok) throw new Error(`index.yaml: HTTP ${res.status}`);

  const index = yaml.load(await res.text());
  const entries = index?.entries?.[chart];
  if (!entries?.length) throw new Error(`Chart "${chart}" not found in repo`);

  return sortVersions(
    entries.map((e) => ({ version: String(e.version), appVersion: e.appVersion ?? null, created: e.created ?? null })),
  );
}

// ---------- OCI registries ----------

// On 401, fetch an (anonymous) bearer token based on the WWW-Authenticate header
async function ociToken(wwwAuth) {
  const params = Object.fromEntries(
    [...wwwAuth.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );
  if (!params.realm) throw new Error('No token endpoint in WWW-Authenticate');

  const url = new URL(params.realm);
  if (params.service) url.searchParams.set('service', params.service);
  if (params.scope) url.searchParams.set('scope', params.scope);

  const res = await get(url);
  if (!res.ok) throw new Error(`Token: HTTP ${res.status}`);
  const body = await json(res, 'Token');
  return body.token || body.access_token;
}

async function fromOci(ref) {
  const [host, ...rest] = ref.replace(/^oci:\/\//, '').split('/');
  const registry = REGISTRY_ALIASES[host] ?? host;
  const repository = rest.join('/');
  let url = `https://${registry}/v2/${repository}/tags/list?n=1000`;
  let headers = {};
  const tags = [];

  // Pagination via the Link header
  while (url) {
    let res = await get(url, headers);
    if (res.status === 401 && !headers.Authorization) {
      const token = await ociToken(res.headers.get('www-authenticate') || '');
      headers = { Authorization: `Bearer ${token}` };
      res = await get(url, headers);
    }
    if (!res.ok) throw new Error(`tags/list: HTTP ${res.status}`);

    const body = await json(res, 'tags/list');
    tags.push(...(body.tags || []));

    const next = res.headers.get('link')?.match(/<([^>]+)>/)?.[1];
    url = next ? new URL(next, `https://${registry}`).toString() : null;
  }

  if (!tags.length) throw new Error('No tags found');
  // appVersion/created are not part of the tag list
  return sortVersions(tags.map((t) => ({ version: t, appVersion: null, created: null })));
}

// ---------- Sources (sources.json) ----------

let sources;
let created = false;
try {
  sources = JSON.parse(await readFile(SOURCES_FILE, 'utf-8'));
} catch (err) {
  // No list yet: start empty and create the file (and its directory)
  if (err.code !== 'ENOENT') throw err;
  sources = [];
  await mkdir(dirname(SOURCES_FILE), { recursive: true });
  created = true;
}
if (!Array.isArray(sources)) {
  console.error(`${SOURCES_FILE} must contain a JSON array`);
  process.exit(1);
}
let writing = Promise.resolve();

// Writes are serialized and atomic (temp file + rename)
function saveSources() {
  const json = JSON.stringify(sources, null, 2) + '\n';
  writing = writing
    .catch(() => {})
    .then(async () => {
      const tmp = SOURCES_FILE + '.tmp';
      await writeFile(tmp, json);
      await rename(tmp, SOURCES_FILE);
    });
  return writing;
}

// Older files have no ids yet
if (created || sources.some((s) => !s.id)) {
  sources = sources.map((s) => ({ id: s.id || randomUUID(), ...s }));
  await saveSources();
}

function validate(body) {
  const name = String(body?.name ?? '').trim();
  const source = String(body?.source ?? '').trim();
  const chart = String(body?.chart ?? '').trim();
  const group = String(body?.group ?? '').trim();
  const fields = {};

  if (!name) fields.name = 'Name is required';
  if (!/^(https?|oci):\/\/[^/\s]+/.test(source)) {
    fields.source = 'Must start with https://, http:// or oci://';
  } else if (typeOf(source) === 'oci' && !/^oci:\/\/[^/\s]+\/\S+/.test(source)) {
    fields.source = 'OCI source needs a repository path, e.g. oci://ghcr.io/org/charts/name';
  }
  if (typeOf(source) === 'http' && !chart) fields.chart = 'Chart name is required for HTTP repos';
  if (group.length > 40) fields.group = 'Group must be 40 characters or less';

  // Optional fields are only stored when set
  const value = { name, source };
  if (typeOf(source) === 'http') value.chart = chart;
  if (group) value.group = group;
  return { fields, value };
}

// ---------- Version checks (cached per chart) ----------

const results = new Map(); // id -> { version, appVersion, created, error, time, all }
const pending = new Map(); // id -> running check

async function check(src) {
  try {
    const all =
      typeOf(src.source) === 'oci' ? await fromOci(src.source) : await fromHttpRepo(src.source, src.chart);
    const top = latest(all);
    return {
      version: top?.version ?? null,
      appVersion: top?.appVersion ?? null,
      created: top?.created ?? null,
      error: null,
      time: Date.now(),
      all,
    };
  } catch (err) {
    return { version: null, appVersion: null, created: null, error: err.message, time: Date.now(), all: [] };
  }
}

function refresh(src, force = false) {
  const cached = results.get(src.id);
  if (!force && cached && Date.now() - cached.time < CACHE_TTL_MS) return cached;
  if (pending.has(src.id)) return pending.get(src.id);

  const job = check(src).then((result) => {
    // Only store if the chart was not edited or deleted in the meantime
    if (pending.get(src.id) === job) {
      results.set(src.id, result);
      pending.delete(src.id);
    }
    return result;
  });
  pending.set(src.id, job);
  return job;
}

function forget(id) {
  results.delete(id);
  pending.delete(id);
}

function toEntry(src, result) {
  const { time, all, ...rest } = result;
  return {
    id: src.id,
    name: src.name,
    type: typeOf(src.source),
    source: src.source,
    chart: src.chart ?? null,
    group: src.group ?? null,
    ...rest,
    checkedAt: new Date(time).toISOString(),
  };
}

const entry = async (src, force) => toEntry(src, await refresh(src, force));

// ---------- Server ----------

const app = express();
app.use(express.json());
if (SEA) {
  const assets = new Set(getAssetKeys());
  app.use((req, res, next) => {
    const key = 'public' + (req.path === '/' ? '/index.html' : req.path);
    if (req.method !== 'GET' || !assets.has(key)) return next();
    res.type(key.slice(key.lastIndexOf('.'))).send(Buffer.from(getAsset(key)));
  });
} else {
  app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));
}

function findSource(req, res) {
  const src = sources.find((s) => s.id === req.params.id);
  if (!src) res.status(404).json({ error: 'Chart not found' });
  return src;
}

app.get('/api/charts', async (req, res) => {
  const force = req.query.refresh === '1';
  const charts = await Promise.all(sources.map((s) => entry(s, force)));
  const oldest = charts.reduce((min, c) => (c.checkedAt < min ? c.checkedAt : min), new Date().toISOString());
  res.json({ checkedAt: oldest, charts });
});

app.post('/api/charts', async (req, res) => {
  const { fields, value } = validate(req.body);
  if (Object.keys(fields).length) return res.status(422).json({ error: 'Validation failed', fields });

  const src = { id: randomUUID(), ...value };
  sources.push(src);
  await saveSources();
  res.status(201).json(await entry(src, true));
});

app.put('/api/charts/:id', async (req, res) => {
  const src = findSource(req, res);
  if (!src) return;
  const { fields, value } = validate(req.body);
  if (Object.keys(fields).length) return res.status(422).json({ error: 'Validation failed', fields });

  const changed = src.source !== value.source || (src.chart ?? '') !== (value.chart ?? '');
  const updated = { id: src.id, ...value };
  sources = sources.map((s) => (s.id === src.id ? updated : s));
  await saveSources();
  if (changed) forget(src.id);
  res.json(await entry(updated, false));
});

app.delete('/api/charts/:id', async (req, res) => {
  const src = findSource(req, res);
  if (!src) return;
  sources = sources.filter((s) => s.id !== src.id);
  await saveSources();
  forget(src.id);
  res.status(204).end();
});

app.post('/api/charts/:id/refresh', async (req, res) => {
  const src = findSource(req, res);
  if (!src) return;
  res.json(await entry(src, true));
});

// Newest versions of one chart (from the same cached check as the table)
app.get('/api/charts/:id/versions', async (req, res) => {
  const src = findSource(req, res);
  if (!src) return;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
  const result = await refresh(src, req.query.refresh === '1');
  if (result.error) return res.status(502).json({ error: result.error });

  const versions = result.all.filter((v) => req.query.prereleases === '1' || !v.prerelease);
  res.json({ ...toEntry(src, result), total: versions.length, versions: versions.slice(0, limit) });
});

// Errors (e.g. invalid JSON in the request body) as JSON instead of HTML
app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`Running on http://localhost:${PORT} (sources: ${SOURCES_FILE})`));
