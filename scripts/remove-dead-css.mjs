#!/usr/bin/env node
// Remove dead CSS using postcss (precise selector surgery). Removes a selector
// only when EVERY class it references is a confirmed-dead component candidate
// (hyphenated, zero static references). Rules mixing dead + live classes are
// kept untouched. Single-word candidates (dynamic state/tier risk) are KEPT.
//
// Dry-run by default; pass --write to modify styles.css.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire('/var/opt/docker/intellacc.com/frontend-solid/');
const postcss = require('postcss');

const CSS = 'frontend-solid/src/styles.css';
const SRC_DIRS = ['frontend-solid/src', 'shared', 'frontend-solid/index.html'];
const WRITE = process.argv.includes('--write');

const css = readFileSync(CSS, 'utf8');
const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
const CLASS_RE = /\.(-?[_a-zA-Z][-_a-zA-Z0-9]*)/g;

// All class selectors in the sheet.
const allClasses = new Set([...noComments.matchAll(CLASS_RE)].map((m) => m[1]));

// A class is "used" if it appears as a standalone token in JS/JSX/HTML source.
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isUsed = (name) => {
  const pattern = `(?<![-_a-zA-Z0-9])${reEsc(name)}(?![-_a-zA-Z0-9])`;
  try {
    execFileSync('grep', [
      '-rqP',
      '--include=*.jsx', '--include=*.js', '--include=*.tsx', '--include=*.ts', '--include=*.html',
      '--', pattern, ...SRC_DIRS
    ], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// Removal set: dead AND hyphenated (component-style). Single-word dead classes
// are kept (likely dynamic state/tier classes the static scan can't see).
const removal = new Set();
for (const name of allClasses) {
  if (name.includes('-') && !isUsed(name)) removal.add(name);
}

const classesIn = (selector) => [...selector.matchAll(CLASS_RE)].map((m) => m[1]);
// A selector is removable if it has ≥1 class and ALL its classes are in removal.
const selectorRemovable = (selector) => {
  const cls = classesIn(selector);
  return cls.length > 0 && cls.every((c) => removal.has(c));
};

let rulesRemoved = 0;
let selectorsTrimmed = 0;

const root = postcss.parse(css);
root.walkRules((rule) => {
  // Skip keyframe rules (their "selectors" are 0%/from/to, not class selectors).
  if (rule.parent && rule.parent.type === 'atrule' && /keyframes/i.test(rule.parent.name)) return;
  const selectors = rule.selectors; // splits the comma group, trims
  const survivors = selectors.filter((s) => !selectorRemovable(s));
  if (survivors.length === 0) {
    rule.remove();
    rulesRemoved += 1;
  } else if (survivors.length < selectors.length) {
    selectorsTrimmed += selectors.length - survivors.length;
    rule.selectors = survivors;
  }
});

// Clean up any @media/@supports blocks left empty by rule removal.
let emptyAtrules = 0;
root.walkAtRules((at) => {
  if (/^(media|supports)$/i.test(at.name) && at.nodes && at.nodes.length === 0) {
    at.remove();
    emptyAtrules += 1;
  }
});

const out = root.toString();
const before = css.split('\n').length;
const after = out.split('\n').length;

console.log(`removal-set size (dead + hyphenated): ${removal.size}`);
console.log(`whole rules removed:    ${rulesRemoved}`);
console.log(`selectors trimmed from grouped rules: ${selectorsTrimmed}`);
console.log(`empty @media/@supports removed: ${emptyAtrules}`);
console.log(`lines: ${before} -> ${after}  (-${before - after})`);

if (WRITE) {
  writeFileSync(CSS, out);
  console.log(`\nWROTE ${CSS}`);
} else {
  console.log('\n(dry-run — pass --write to apply)');
}
