/**
 * Validates package.json's `build` block against electron-builder's own schema.
 *
 * electron-builder rejects unknown keys (additionalProperties: false) but its
 * error only says "configuration.win should be one of these: null" — it never
 * names the offending key. That cost a whole CI run once. This fails fast and
 * points at the key.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const schemaPath = path.join(root, 'node_modules/app-builder-lib/scheme.json');

if (!fs.existsSync(schemaPath)) {
  console.error('app-builder-lib schema not found — run npm install first.');
  process.exit(2);
}

const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

/** Follows the $ref chain / anyOf union until it finds an object with properties. */
function propertiesOf(node, seen = new Set()) {
  if (!node || typeof node !== 'object') return null;
  if (node.$ref) {
    const name = node.$ref.replace('#/definitions/', '');
    if (seen.has(name)) return null;
    seen.add(name);
    return propertiesOf(schema.definitions[name], seen);
  }
  if (node.properties) return node.properties;
  for (const branch of node.anyOf || node.oneOf || node.allOf || []) {
    const found = propertiesOf(branch, seen);
    if (found) return found;
  }
  return null;
}

const top = propertiesOf(schema);
const problems = [];

for (const section of ['win', 'nsis', 'portable', 'linux', 'mac', 'directories']) {
  const config = pkg.build?.[section];
  if (!config || typeof config !== 'object') continue;

  const allowed = propertiesOf(top[section]);
  if (!allowed) {
    console.warn(`  ${section}: no schema properties found, skipping`);
    continue;
  }

  for (const key of Object.keys(config)) {
    if (!(key in allowed)) problems.push(`build.${section}.${key}`);
  }
  console.log(`  build.${section}: ${Object.keys(config).length} keys checked`);
}

// Unknown keys at the top level of `build` are just as fatal.
for (const key of Object.keys(pkg.build || {})) {
  if (!(key in top)) problems.push(`build.${key}`);
}

if (problems.length) {
  console.error('\nThese keys are not in the electron-builder schema:');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nelectron-builder will reject the whole config. Remove them.');
  process.exit(1);
}

console.log('\nbuild config validates against electron-builder ' +
  `${pkg.devDependencies['electron-builder']}.`);
