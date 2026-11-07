async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText);
    err.fields = data?.fields;
    throw err;
  }
  return data;
}

// Compare two version strings roughly like semver: numeric parts first, a pre-release sorts before its release
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, ...pre] = v.replace(/^v/i, '').split('+')[0].split('-');
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre.join('-') };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}

const SORT_COLUMNS = [
  { key: 'name', label: 'Chart' },
  { key: 'type', label: 'Type' },
  { key: 'version', label: 'Version' },
  { key: 'appVersion', label: 'App version' },
  { key: 'created', label: 'Published' },
  { key: 'checkedAt', label: 'Checked' },
];

function loadSort() {
  try {
    const s = JSON.parse(localStorage.getItem('hv-sort'));
    if (SORT_COLUMNS.some((c) => c.key === s?.key) && ['asc', 'desc'].includes(s.dir)) return s;
  } catch (e) { /* storage unavailable or invalid */ }
  return { key: 'name', dir: 'asc' };
}

function charts() {
  return {
    items: [], checkedAt: null, loading: false, error: null,
    search: '', busy: {}, deleting: null, toast: null, toastTimer: null,
    activeGroup: null, // null = all charts, '' = ungrouped, otherwise a group name
    dark: document.documentElement.dataset.theme !== 'light',
    columns: SORT_COLUMNS,
    sort: loadSort(),
    hist: { chart: null, limit: 10, prereleases: false, versions: [], total: 0, latest: null, loading: false, error: null },
    form: { open: false, id: null, name: '', source: '', chart: '', group: '', errors: {}, saving: false },

    // Groups come from the charts themselves; a group exists as long as a chart uses it
    get groups() {
      const counts = {};
      for (const c of this.items) if (c.group) counts[c.group] = (counts[c.group] ?? 0) + 1;
      return Object.keys(counts)
        .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
        .map((name) => ({ name, count: counts[name] }));
    },
    get ungroupedCount() {
      return this.items.filter((c) => !c.group).length;
    },
    get inGroup() {
      if (this.activeGroup === null) return this.items;
      return this.items.filter((c) => (c.group ?? '') === this.activeGroup);
    },
    get filtered() {
      const q = this.search.trim().toLowerCase();
      const list = !q ? this.inGroup : this.inGroup.filter((c) =>
        [c.name, c.source, c.chart ?? '', c.group ?? ''].some((t) => t.toLowerCase().includes(q)));
      return this.sorted(list);
    },
    get title() {
      if (this.activeGroup === null) return 'Charts';
      return this.activeGroup || 'Ungrouped';
    },
    get isOci() {
      return this.form.source.trim().startsWith('oci://');
    },

    // Empty values always go last, ties are broken by name
    sorted(list) {
      const { key, dir } = this.sort;
      const sign = dir === 'asc' ? 1 : -1;
      const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true });
      const cmp = {
        version: compareVersions,
        appVersion: compareVersions,
        created: (a, b) => Date.parse(a) - Date.parse(b),
        checkedAt: (a, b) => Date.parse(a) - Date.parse(b),
      }[key] ?? ((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }));
      return [...list].sort((a, b) => {
        const x = a[key], y = b[key];
        if (!x || !y) return (!x - !y) || byName(a, b);
        return sign * cmp(x, y) || byName(a, b);
      });
    },

    sortBy(key) {
      this.sort = this.sort.key === key
        ? { key, dir: this.sort.dir === 'asc' ? 'desc' : 'asc' }
        // Dates start with the newest first, everything else ascending
        : { key, dir: ['created', 'checkedAt'].includes(key) ? 'desc' : 'asc' };
      try { localStorage.setItem('hv-sort', JSON.stringify(this.sort)); } catch (e) { /* storage unavailable */ }
    },

    ariaSort(key) {
      if (this.sort.key !== key) return 'none';
      return this.sort.dir === 'asc' ? 'ascending' : 'descending';
    },

    async load(refresh = false) {
      this.loading = true; this.error = null;
      try {
        const body = await api('GET', '/api/charts' + (refresh ? '?refresh=1' : ''));
        this.items = body.charts;
        this.checkedAt = body.checkedAt;
      } catch (e) {
        this.error = 'Could not load charts: ' + e.message;
      } finally {
        this.loading = false;
      }
    },

    upsert(entry) {
      const i = this.items.findIndex((c) => c.id === entry.id);
      if (i === -1) this.items.push(entry); else this.items[i] = entry;
    },

    // Back to "All charts" when the selected group no longer has any charts
    keepGroupValid() {
      if (this.activeGroup !== null && !this.inGroup.length) this.activeGroup = null;
    },

    async refreshOne(c) {
      this.busy[c.id] = true;
      try {
        this.upsert(await api('POST', `/api/charts/${c.id}/refresh`));
      } catch (e) {
        this.notify(`Refreshing "${c.name}" failed: ${e.message}`, 'error');
      } finally {
        this.busy[c.id] = false;
      }
    },

    openVersions(c) {
      Object.assign(this.hist, { chart: c, versions: [], total: 0, latest: c.version, error: null });
      this.$refs.versionsDialog.showModal();
      this.loadVersions();
    },

    async loadVersions(refresh = false) {
      const h = this.hist;
      const id = h.chart.id;
      h.loading = true; h.error = null;
      try {
        const q = new URLSearchParams({ limit: h.limit, prereleases: h.prereleases ? '1' : '0', refresh: refresh ? '1' : '0' });
        const body = await api('GET', `/api/charts/${id}/versions?${q}`);
        if (h.chart?.id !== id) return; // dialog was reopened for another chart
        const { versions, total, ...entry } = body;
        Object.assign(h, { versions, total, latest: entry.version });
        this.upsert(entry);
      } catch (e) {
        h.versions = []; h.total = 0;
        h.error = e.message;
      } finally {
        h.loading = false;
      }
    },

    openForm(c = null) {
      this.form = {
        open: true, id: c?.id ?? null, name: c?.name ?? '', source: c?.source ?? '', chart: c?.chart ?? '',
        // New charts start in the group that is currently selected
        group: c ? (c.group ?? '') : (this.activeGroup ?? ''),
        errors: {}, saving: false,
      };
      this.$refs.formDialog.showModal();
    },

    async save() {
      const f = this.form;
      f.saving = true; f.errors = {};
      const body = { name: f.name, source: f.source, chart: this.isOci ? undefined : f.chart, group: f.group };
      try {
        const entry = f.id
          ? await api('PUT', `/api/charts/${f.id}`, body)
          : await api('POST', '/api/charts', body);
        this.upsert(entry);
        // Follow the chart if it moved out of the selected group
        if (this.activeGroup !== null && (entry.group ?? '') !== this.activeGroup) this.activeGroup = entry.group ?? '';
        this.keepGroupValid();
        this.$refs.formDialog.close();
        this.notify(`${f.id ? 'Saved' : 'Added'} "${entry.name}".`, 'success');
      } catch (e) {
        f.errors = e.fields ?? { _: e.message };
      } finally {
        f.saving = false;
      }
    },

    askDelete(c) {
      this.deleting = c;
      this.$refs.deleteDialog.showModal();
    },

    async confirmDelete() {
      const c = this.deleting;
      this.$refs.deleteDialog.close();
      try {
        await api('DELETE', `/api/charts/${c.id}`);
        this.items = this.items.filter((x) => x.id !== c.id);
        this.keepGroupValid();
        this.notify(`Deleted "${c.name}".`, 'success');
      } catch (e) {
        this.notify(`Deleting failed: ${e.message}`, 'error');
      }
    },

    notify(text, kind) {
      clearTimeout(this.toastTimer);
      this.toast = { text, kind };
      this.toastTimer = setTimeout(() => (this.toast = null), 3000);
    },

    toggleTheme() {
      this.dark = !this.dark;
      const theme = this.dark ? 'dark' : 'light';
      document.documentElement.dataset.theme = theme;
      try { localStorage.setItem('hv-theme', theme); } catch (e) { /* storage unavailable */ }
    },

    formatDate(iso, withTime = true) {
      const opts = withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' };
      return new Intl.DateTimeFormat('en-US', opts).format(new Date(iso));
    },
  };
}
