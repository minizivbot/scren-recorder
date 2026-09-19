/**
 * Removes release assets the current build did not produce.
 *
 * Release assets are added, never replaced, so renaming a file leaves the old
 * one on the download page beside the new one. A page offering four
 * installers, half of them stale and unable to update themselves, is how a
 * download starts looking untrustworthy.
 *
 * This deletes carefully, because the first version of this step deleted the
 * entire release — the installer included. It compared names with `grep -w`
 * against a list built in bash, and Python on the Windows runner ended every
 * line with \r, so no name ever matched its own entry and every asset looked
 * stale. Two rules now make that failure impossible:
 *
 *   1. Names are compared as trimmed exact strings, never as patterns.
 *   2. If any expected file is absent from the release, nothing is deleted.
 *      A keep-list matching nothing means the list is wrong — not that every
 *      asset is garbage.
 *
 * Usage: node scripts/prune-release-assets.mjs <owner/repo> <tag> <keep...>
 *        GH_TOKEN must be set. Pass --dry-run to print without deleting.
 */

/**
 * Decides what to remove.
 *
 * Returns `{ toDelete, problem }`. A non-null `problem` means delete nothing
 * and say why.
 */
export function planDeletions(assets = [], keep = []) {
  const wanted = new Set(keep.map((name) => String(name).trim()).filter(Boolean));
  if (wanted.size === 0) return { toDelete: [], problem: 'no keep-list given' };

  const named = assets.map((asset) => ({ ...asset, name: String(asset?.name ?? '').trim() }));
  const present = new Set(named.map((asset) => asset.name));

  const missing = [...wanted].filter((name) => !present.has(name)).sort();
  if (missing.length) {
    return { toDelete: [], problem: `expected files missing from the release: ${missing.join(', ')}` };
  }

  return { toDelete: named.filter((asset) => !wanted.has(asset.name)), problem: null };
}

async function api(url, token, method = 'GET') {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw Object.assign(new Error(`${method} ${url} → ${response.status}`), { status: response.status });
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const args = argv.filter((a) => a !== '--dry-run');
  const [repo, tag, ...keep] = args;
  if (!repo || !tag || keep.length === 0) {
    console.log('usage: node scripts/prune-release-assets.mjs <owner/repo> <tag> <keep...>');
    return 2;
  }

  const token = process.env.GH_TOKEN;
  if (!token) {
    console.log('GH_TOKEN is not set; skipping cleanup rather than guessing.');
    return 0;
  }

  const base = `https://api.github.com/repos/${repo}`;
  let release;
  try {
    release = await api(`${base}/releases/tags/${tag}`, token);
  } catch (err) {
    console.log(`Could not read the ${tag} release (${err.status || err.message}); nothing deleted.`);
    return 0;
  }

  const assets = release.assets || [];
  const { toDelete, problem } = planDeletions(assets, keep);

  if (problem) {
    // Not a build failure: the app published fine, only the tidying was
    // skipped. Failing here would mark a good build red for a cosmetic step.
    console.log(`::warning::Skipped asset cleanup — ${problem}`);
    console.log('On the release:', assets.map((a) => a.name).sort().join(', ') || '(none)');
    return 0;
  }

  if (!toDelete.length) {
    console.log('Nothing stale to remove.');
    return 0;
  }

  for (const asset of toDelete) {
    console.log(`removing stale asset: ${asset.name}`);
    if (!dryRun) await api(`${base}/releases/assets/${asset.id}`, token, 'DELETE');
  }
  console.log('kept:', [...keep].sort().join(', '));
  return 0;
}

const isMain = process.argv[1] && process.argv[1].endsWith('prune-release-assets.mjs');
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code));
