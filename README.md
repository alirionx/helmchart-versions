# helm-versions

A small web app that shows the latest version of your Helm charts in one table, from classic HTTP chart repos and OCI registries.

- One table with the latest version, app version, publish date and when it was last checked
- Add, edit and delete charts in the browser
- Optional groups (e.g. per team or cluster) to filter the table from the sidebar
- Refresh a single chart or all of them
- Version history per chart (the newest 10 to 100 versions, optionally including pre-releases)
- Light and dark theme

It does nothing more than that, on purpose. There is no database and no login: one Node.js server, one small web page and a JSON file with your charts. Run it from source, as a Docker container or as a single Linux executable.

## Requirements

- Node.js 24 or newer, **or** Docker, **or** Linux x64 for the [single executable](#single-executable-linux-x64)
- Outbound HTTPS access from the server to your chart repos and registries
- Internet access from the browser (Alpine.js and the Inter font are loaded from a CDN)

## Quick start

```sh
git clone <repo-url> helm-versions
cd helm-versions
npm install
npm start
```

Open <http://localhost:3000>.

The repo comes with a few example charts in `sources.json`. Delete them in the UI or edit the file before you start.

For development, `npm run dev` restarts the server when `server.js` changes.

## Single executable (Linux x64)

Every [release](../../releases) has a self-contained executable for Linux x64. Node.js is not needed. This is handy if you only want to keep an eye on your own set of charts, e.g. the apps you are responsible for.

```sh
curl -LO https://github.com/<owner>/<repo>/releases/latest/download/helm-versions-linux-x64.tar.gz
curl -LO https://github.com/<owner>/<repo>/releases/latest/download/helm-versions-linux-x64.tar.gz.sha256
sha256sum -c helm-versions-linux-x64.tar.gz.sha256
tar -xzf helm-versions-linux-x64.tar.gz
./helm-versions
```

Open <http://localhost:3000>.

The chart list is saved as `sources.json` in the **current directory**. On the first start it is created from the example list built into the executable. Use `--sources` to keep several lists side by side:

```sh
./helm-versions --sources ~/charts/team-payments.json --port 8080
```

| Option                 | Environment variable | Default            |
| ---------------------- | -------------------- | ------------------ |
| `-p`, `--port <port>`  | `PORT`               | `3000`             |
| `-s`, `--sources <file>` | `SOURCES_FILE`     | `./sources.json`   |
| `-h`, `--help`         |                      |                    |
| `-v`, `--version`      |                      |                    |

Requirements: glibc 2.28 or newer (e.g. Ubuntu 20.04+, Debian 10+, RHEL 8+), `libstdc++` and `libatomic`. Regular servers and desktops have them. Minimal container images may need `libatomic1` installed. Alpine (musl) is not supported, use the Docker image there.

The file is about 150 MB (48 MB compressed) because it contains the complete Node.js runtime.

To build it yourself on Linux x64 with Node.js 26: `npm ci && npm run build:sea`, the result is `dist/helm-versions`.

## Docker

Build the image:

```sh
docker build -t helm-versions .
```

Run it:

```sh
docker run -d --name helm-versions \
  -p 3000:3000 \
  -v helm-versions-data:/data \
  helm-versions
```

Open <http://localhost:3000>.

Inside the container the chart list is stored in `/data/sources.json`. On the first start, when that file does not exist yet, the app copies the example list from the image into it. Keep `/data` on a volume, as above, or the charts you add in the UI are lost when the container is removed.

To keep the file in a host directory instead of a named volume, the directory must be writable for UID 1000, the `node` user the container runs as:

```sh
mkdir -p ./data
docker run -d --name helm-versions -p 3000:3000 -v "$PWD/data:/data" helm-versions
```

To use another port, change the left side of `-p`, e.g. `-p 8080:3000`.

## Configuration

| Option           | Environment variable | Default                                    | Description                                   |
| ---------------- | -------------------- | ------------------------------------------ | --------------------------------------------- |
| `-p`, `--port`   | `PORT`               | `3000`                                     | HTTP port                                     |
| `-s`, `--sources`| `SOURCES_FILE`       | see below                                  | Where the chart list is read from and saved to |

Default for the chart list: `sources.json` in the repo when started with `npm start`, `/data/sources.json` in Docker, `./sources.json` in the current directory for the single executable.

Options win over environment variables. With npm, pass them after `--`, e.g. `npm start -- --port 8080`.

If the chart list file does not exist, the app starts with the bundled `sources.json` and creates the file.

## Managing charts

Normally you add charts in the UI with **Add chart**:

- **HTTP repo:** the repo URL, the same one you would use with `helm repo add` (e.g. `https://charts.jetstack.io`), plus the chart name (e.g. `cert-manager`).
- **OCI registry:** the full `oci://` address including the chart, the same one you would use with `helm pull` (e.g. `oci://ghcr.io/stefanprodan/charts/podinfo`). No separate chart name is needed.

Optionally give the chart a **group**. The sidebar lists every group in use with its number of charts; a group disappears again when no chart uses it. Charts without a group show up under *Ungrouped*.

`oci://docker.io/...` works as well. Like Helm, the app talks to `registry-1.docker.io` for Docker Hub.

Every change is saved to `sources.json` immediately. You can also edit the file by hand while the app is stopped:

```json
[
  { "name": "cert-manager", "source": "https://charts.jetstack.io", "chart": "cert-manager" },
  { "name": "podinfo", "source": "oci://ghcr.io/stefanprodan/charts/podinfo", "group": "Demo" }
]
```

Entries without an `id` get one on the next start.

## How versions are determined

- **HTTP repos:** the app reads `<repo>/index.yaml` and looks at the entries of the chart.
- **OCI registries:** the app lists the tags via the registry API (`/v2/<repo>/tags/list`), with an anonymous token if the registry asks for one.
- "Latest" is the highest valid [semver](https://semver.org) version. Pre-releases count only if a chart has no stable release.
- The version history is sorted by version number, not by date.
- Results are cached in memory for 10 minutes per chart. **Refresh** bypasses the cache.

## Limitations

- **Public sources only:** no credentials for private repos or registries.
- **OCI charts show no app version and no publish date.** That information is not part of the tag list.
- **The cache lives in memory**, so the first page load after a start queries every source.
- **There is no authentication.** Anyone who can reach the app can change the chart list, so do not expose it to the internet as is.

## API

The UI uses a small JSON API, which you can also call directly:

| Method & path                         | Description                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/charts`                     | All charts with their latest version. `?refresh=1` bypasses the cache        |
| `POST /api/charts`                    | Add a chart. Body: `{ "name", "source", "chart"?, "group"? }`                          |
| `PUT /api/charts/:id`                 | Change a chart (same body)                                                  |
| `DELETE /api/charts/:id`              | Delete a chart                                                              |
| `POST /api/charts/:id/refresh`        | Check one chart again                                                       |
| `GET /api/charts/:id/versions`        | Newest versions. Query: `limit` (1–100, default 10), `prereleases=1`, `refresh=1` |

Invalid input returns `422` with a message per field, e.g. `{ "error": "Validation failed", "fields": { "chart": "Chart name is required for HTTP repos" } }`.

Example:

```sh
curl -X POST http://localhost:3000/api/charts \
  -H 'Content-Type: application/json' \
  -d '{"name":"argo-cd","source":"https://argoproj.github.io/argo-helm","chart":"argo-cd"}'
```

## Project layout

```
server.js           API, version checks and static file serving (Express)
public/index.html   the UI markup (Alpine.js)
public/style.css    styles (plain CSS, light and dark theme)
public/app.js       UI state and API calls
sources.json        the chart list (and the example list built into Docker image and executable)
scripts/build-sea.mjs  builds the single executable (esbuild + Node SEA)
.github/workflows/release.yml  release pipeline
Dockerfile
```

## Releasing

1. Set the new version in `package.json` (e.g. `1.1.0`).
2. Commit, then tag and push: `git tag v1.1.0 && git push origin v1.1.0`
3. The *Release* workflow builds and tests the executable and publishes a GitHub release with `helm-versions-linux-x64.tar.gz` and its checksum. It fails if the tag does not match the version in `package.json`.

The workflow can also be started by hand (*Actions → Release → Run workflow*). It then only builds and tests and attaches the file to the workflow run.
