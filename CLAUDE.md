# helm-versions

Kleine Web-App, die die aktuelle Version von Helm Charts aus HTTP-Repos und OCI-Registries abfragt und als Tabelle anzeigt.

## Stack

- Node.js >= 24 (Docker-Image: Node 26 LTS), ES-Module (`"type": "module"`)
- Backend: Express (`server.js`), Abhängigkeiten nur `express`, `js-yaml`, `semver`
- Frontend: eine Seite aus `public/index.html`, `public/style.css` und `public/app.js`, Alpine.js 3 per CDN
- Kein Build-Schritt, kein TypeScript – bitte so beibehalten. Einzige Ausnahme: `npm run build:sea` (esbuild als einzige devDependency) baut für Releases ein Single Executable (Node SEA, Linux x64); Entwicklung und Docker nutzen `server.js` direkt

## Struktur

- `server.js` – API und Auslieferung der statischen Dateien aus `public/`
- `public/index.html` – Markup (Tabelle, Dialoge für Anlegen/Bearbeiten/Löschen und Versionen) und das Theme-Snippet im `<head>` (muss inline bleiben, verhindert Aufblitzen des falschen Themes)
- `public/style.css` – komplettes CSS; Stil angelehnt an cloudinit-nocloud-configurator, reines CSS ohne Framework, Light/Dark über `data-theme`
- `public/app.js` – `api()` und der Alpine-Zustand `charts()`; wird ohne `defer` vor Alpine geladen, damit `charts()` existiert, wenn Alpine startet
- `sources.json` – Liste der abzufragenden Charts (wird über die API gepflegt); Nutzerdaten, steht in `.gitignore` und ist weder im Docker-Image noch im Executable; Pfad über `--sources`/`SOURCES_FILE` änderbar; fehlt die Datei, startet die App mit `[]` und legt Datei samt Ordner an
- `Dockerfile` – node:26-alpine, läuft als `node`, Daten in `/data/sources.json` (Volume)
- `README.md` – Doku für Nutzer (Englisch)
- `scripts/build-sea.mjs` – bündelt `server.js` mit esbuild zu `dist/server.mjs` (ESM, `require`-Shim im Banner), bettet `public/*` als SEA-Assets ein, baut mit `node --build-sea`
- `.github/workflows/release.yml` – bei Tag `v*`: Version gegen `package.json` prüfen, bauen, Smoke-Test, Release mit `helm-versions-linux-x64.tar.gz` + `.sha256` (Name ohne Version, damit `releases/latest/download/…` funktioniert); manuell gestartet nur Build + Artifact
- Im SEA-Modus (`isSea()`) liefert `server.js` das Frontend aus den Assets statt per `express.static`; Standard für die Chart-Liste ist dann `./sources.json` im Arbeitsverzeichnis

## Befehle

- `npm install` – Abhängigkeiten installieren
- `npm start` – Server starten (Port über `PORT`, Standard 3000)
- `npm run dev` – Start mit `node --watch`
- `npm run build:sea` – Single Executable nach `dist/helm-versions` (braucht Node 26, baut für die eigene Plattform)
- Optionen: `-p/--port`, `-s/--sources`, `-h/--help`, `-v/--version` (vor Umgebungsvariablen)
- `docker build -t helm-versions .` / `docker run -p 3000:3000 -v helm-versions-data:/data helm-versions`

## Funktionsweise

- `GET /api/charts` liefert `{ checkedAt, charts: [...] }`; `?refresh=1` umgeht den Cache (10 Minuten, im Speicher, pro Chart)
- `POST /api/charts` legt an, `PUT /api/charts/:id` ändert, `DELETE /api/charts/:id` löscht; Body `{ name, source, chart?, group? }`, bei ungültigen Daten 422 mit `{ error, fields: { feld: meldung } }`
- `POST /api/charts/:id/refresh` fragt einen einzelnen Chart neu ab
- `GET /api/charts/:id/versions?limit=10&prereleases=0|1&refresh=0|1` liefert den Eintrag plus `total` und `versions: [{ version, appVersion, created, prerelease }]`, nach Semver absteigend sortiert; nutzt dieselbe gecachte Abfrage wie die Tabelle (Limit 1–100)
- Jeder Eintrag: `id`, `name`, `type` (`http`/`oci`), `source`, `chart`, `group`, `version`, `appVersion`, `created`, `error`, `checkedAt`
- `sources.json` wird beim Start einmal gelesen und bei jeder Änderung atomar (Temp-Datei + rename) zurückgeschrieben; Einträge ohne `id` bekommen beim Start eine
- HTTP-Repos: `<source>/index.yaml` laden, `entries[chart]` auswerten
- OCI: `GET https://<registry>/v2/<repo>/tags/list`; bei 401 anonymes Bearer-Token über den `WWW-Authenticate`-Header holen; Paginierung über den `Link`-Header
- Versionsauswahl: neueste gültige Semver-Version, Pre-Releases nur, wenn keine stabile existiert
- Fehler einer Quelle landen im Feld `error` des Eintrags, die anderen Quellen laufen weiter

## Format von sources.json

```json
[
  { "id": "…", "name": "cert-manager", "source": "https://charts.jetstack.io", "chart": "cert-manager" },
  { "id": "…", "name": "podinfo", "source": "oci://ghcr.io/stefanprodan/charts/podinfo" }
]
```

HTTP-Quellen brauchen `chart`, OCI-Quellen nicht (der Chart ist Teil der Adresse).
`group` ist optional (Freitext, max. 40 Zeichen) und wird nur gespeichert, wenn gesetzt. Es gibt keine eigene Gruppenverwaltung: Die Sidebar leitet die Gruppen aus den Charts ab, eine Gruppe existiert, solange ein Chart sie nutzt. Genau eine Gruppe pro Chart, keine Verschachtelung.

## Bekannte Einschränkungen / mögliche nächste Schritte

- Bei OCI fehlen `appVersion` und `created` (stehen erst im Manifest bzw. in der Chart.yaml-Config)
- Keine Authentifizierung für private Registries oder Repos
- Noch ungetestet gegen die echten Quellen

## Konventionen

- Code-Kommentare, Fehlermeldungen und UI-Texte auf Englisch (App ist English only)
- Keine neuen Abhängigkeiten ohne Rückfrage
- Ausgaben im Frontend über `x-text`, nicht `x-html` (Daten stammen aus externen Quellen)
