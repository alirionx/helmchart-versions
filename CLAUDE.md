# helm-versions

Kleine Web-App, die die aktuelle Version von Helm Charts aus HTTP-Repos und OCI-Registries abfragt und als Tabelle anzeigt.

## Stack

- Node.js >= 24 (Docker-Image: Node 26 LTS), ES-Module (`"type": "module"`)
- Backend: Express (`server.js`), Abhängigkeiten nur `express`, `js-yaml`, `semver`
- Frontend: eine einzige Seite `public/index.html` mit Alpine.js 3 per CDN
- Kein Build-Schritt, kein Bundler, kein TypeScript – bitte so beibehalten

## Struktur

- `server.js` – API und Auslieferung der statischen Dateien aus `public/`
- `public/index.html` – Alpine-Seite mit Tabelle, Dialogen für Anlegen/Bearbeiten/Löschen und Light/Dark-Theme (Zustand in `charts()`); Stil angelehnt an cloudinit-nocloud-configurator, reines CSS ohne Framework
- `sources.json` – Liste der abzufragenden Charts (wird über die API gepflegt); Pfad über `SOURCES_FILE` änderbar, fehlt die Datei dort, wird die mitgelieferte `sources.json` als Startliste übernommen
- `Dockerfile` – node:26-alpine, läuft als `node`, Daten in `/data/sources.json` (Volume)
- `README.md` – Doku für Nutzer (Englisch)

## Befehle

- `npm install` – Abhängigkeiten installieren
- `npm start` – Server starten (Port über `PORT`, Standard 3000)
- `npm run dev` – Start mit `node --watch`
- `docker build -t helm-versions .` / `docker run -p 3000:3000 -v helm-versions-data:/data helm-versions`

## Funktionsweise

- `GET /api/charts` liefert `{ checkedAt, charts: [...] }`; `?refresh=1` umgeht den Cache (10 Minuten, im Speicher, pro Chart)
- `POST /api/charts` legt an, `PUT /api/charts/:id` ändert, `DELETE /api/charts/:id` löscht; Body `{ name, source, chart? }`, bei ungültigen Daten 422 mit `{ error, fields: { feld: meldung } }`
- `POST /api/charts/:id/refresh` fragt einen einzelnen Chart neu ab
- `GET /api/charts/:id/versions?limit=10&prereleases=0|1&refresh=0|1` liefert den Eintrag plus `total` und `versions: [{ version, appVersion, created, prerelease }]`, nach Semver absteigend sortiert; nutzt dieselbe gecachte Abfrage wie die Tabelle (Limit 1–100)
- Jeder Eintrag: `id`, `name`, `type` (`http`/`oci`), `source`, `chart`, `version`, `appVersion`, `created`, `error`, `checkedAt`
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

## Bekannte Einschränkungen / mögliche nächste Schritte

- Bei OCI fehlen `appVersion` und `created` (stehen erst im Manifest bzw. in der Chart.yaml-Config)
- Keine Authentifizierung für private Registries oder Repos
- Noch ungetestet gegen die echten Quellen

## Konventionen

- Code-Kommentare, Fehlermeldungen und UI-Texte auf Englisch (App ist English only)
- Keine neuen Abhängigkeiten ohne Rückfrage
- Ausgaben im Frontend über `x-text`, nicht `x-html` (Daten stammen aus externen Quellen)
