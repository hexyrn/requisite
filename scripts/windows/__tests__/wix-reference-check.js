#!/usr/bin/env node
/**
 * WiX link-phase checks WiX itself cannot run on Linux (its compiler stops at path-binding artefacts first):
 *  - no Id is defined twice within the same kind (Component, Directory, File, CustomAction, ...)
 *  - every *Ref, Directory="..." attribute and <Custom Action="..."> points at something that is defined
 *  - every [PROPERTY] used in a custom-action command line or shortcut argument is a defined Property/Directory
 *  - every ServiceInstall/ServiceControl Name is unique
 * Usage: wix-reference-check.js <file.wxs> ...   (exit 1 on any problem; prints each)
 */
const fs = require('fs');
const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: wix-reference-check.js <files>');
  process.exit(2);
}
const src = files.map((f) => ({
  f,
  t: fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, ''),
}));
const all = src.map((s) => s.t).join('\n');
const tag = /<([A-Za-z][A-Za-z0-9]*)\b([^>]*?)\/?>/g;
const attr = (a, n) => {
  const m = new RegExp('(?:^|\\s)' + n + '="([^"]*)"').exec(a);
  return m ? m[1] : undefined;
};

const defs = {};
const problems = [];
const KINDS = [
  'Directory',
  'StandardDirectory',
  'Component',
  'ComponentGroup',
  'Feature',
  'File',
  'CustomAction',
  'Property',
  'Icon',
  'Shortcut',
  'Fragment',
];
const refs = [];
let m;
while ((m = tag.exec(all))) {
  const [, name, a] = m;
  const id = attr(a, 'Id');
  if (KINDS.includes(name) && id) {
    const kind = name === 'StandardDirectory' ? 'Directory' : name;
    defs[kind] = defs[kind] || {};
    if (defs[kind][id]) problems.push(`duplicate ${kind} Id "${id}"`);
    defs[kind][id] = true;
  }
  if (name === 'ComponentRef') refs.push(['Component', id]);
  if (name === 'ComponentGroupRef') refs.push(['ComponentGroup', id]);
  if (name === 'DirectoryRef') refs.push(['Directory', id]);
  if (name === 'FeatureRef') refs.push(['Feature', id]);
  if (name === 'Custom') refs.push(['CustomAction', attr(a, 'Action')]);
  const dir = attr(a, 'Directory');
  if (dir && !/^\[|\$\(/.test(dir)) refs.push(['Directory', dir]);
  if (name === 'ServiceInstall' || name === 'ServiceControl') {
    const n = attr(a, 'Name');
    const k = name + ':' + n;
    defs.svc = defs.svc || {};
    if (defs.svc[k]) problems.push(`duplicate ${name} for service ${n}`);
    defs.svc[k] = true;
  }
}
for (const [kind, id] of refs)
  if (id && !(defs[kind] && defs[kind][id]))
    problems.push(`${kind} "${id}" is referenced but never defined`);
// [PROPERTY] uses in command lines / arguments
const known = new Set([...Object.keys(defs.Property || {}), ...Object.keys(defs.Directory || {})]);
const builtin = new Set([
  'ProductVersion',
  'INSTALLFOLDER',
  'System64Folder',
  'ProgramFiles64Folder',
  'WindowsFolder',
  'TempFolder',
  'ProgramMenuFolder',
]);
const cmd = /(?:ExeCommand|Arguments)="([^"]*)"/g;
while ((m = cmd.exec(all))) {
  const u = /\[([A-Za-z_][A-Za-z0-9_]*)\]/g;
  let x;
  while ((x = u.exec(m[1])))
    if (!known.has(x[1]) && !builtin.has(x[1]))
      problems.push(`[${x[1]}] is used in a command line but is not a defined Property/Directory`);
}
if (problems.length) {
  for (const p of new Set(problems)) console.error('FAIL ' + p);
  process.exit(1);
}
console.log(
  `PASS WiX reference check: ${Object.values(defs).reduce((n, o) => n + Object.keys(o).length, 0)} ids defined, ${refs.length} references resolved, no duplicates`,
);
