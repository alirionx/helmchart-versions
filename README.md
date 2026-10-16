# helm-versions

A small web app that shows the latest version of your Helm charts in one table, from classic HTTP chart repos and OCI registries.

- One table with the latest version, app version, publish date and when it was last checked
- Add, edit and delete charts in the browser
- Refresh a single chart or all of them
- Version history per chart (the newest 10 to 100 versions, optionally including pre-releases)
- Light and dark theme

It does nothing more than that, on purpose. There is no database, no login and no build step: one Node.js server, one HTML page and a JSON file with your charts.

## Requirements

- Node.js 24 or newer, **or** Docker
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

Environment variables:

| Variable       | Default                    | Description                                                            |
| -------------- | -------------------------- | ---------------------------------------------------------------------- |
| `PORT`         | `3000`                     | HTTP port                                                              |
| `SOURCES_FILE` | `./sources.json`           | Where the chart list is read from and saved to. In Docker: `/data/sources.json` |

If `SOURCES_FILE` points to a file that does not exist, the app starts with the bundled `sources.json` and creates the file.

## Managing charts

Normally you add charts in the UI with **Add chart**:

- **HTTP repo:** the repo URL, the same one you would use with `helm repo add` (e.g. `https://charts.jetstack.io`), plus the chart name (e.g. `cert-manager`).
- **OCI registry:** the full `oci://` address including the chart, the same one you would use with `helm pull` (e.g. `oci://ghcr.io/stefanprodan/charts/podinfo`). No separate chart name is needed.

`oci://docker.io/...` works as well. Like Helm, the app talks to `registry-1.docker.io` for Docker Hub.

Every change is saved to `sources.json` immediately. You can also edit the file by hand while the app is stopped:

```json
[
  { "name": "cert-manager", "source": "https://charts.jetstack.io", "chart": "cert-manager" },
  { "name": "podinfo", "source": "oci://ghcr.io/stefanprodan/charts/podinfo" }
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
| `POST /api/charts`                    | Add a chart. Body: `{ "name", "source", "chart"? }`                          |
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
public/index.html   the whole UI (Alpine.js, plain CSS)
sources.json        the chart list
Dockerfile
```
