#!/usr/bin/env node
// Dead-CSS report (read-only): lists class selectors in styles.css that appear
// NOWHERE in the Solid source. CONSERVATIVE — a class referenced as any literal
// substring in src is treated as used, so this UNDER-reports dead code (safe).
// CAVEAT: dynamically-built class names (classList, `tier-${n}`) can't be seen
// by a static scan, so review every candidate before deleting.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CSS = 'frontend-solid/src/styles.css';
const SRC_DIRS = ['frontend-solid/src', 'shared', 'frontend-solid/index.html'];

const css = readFileSync(CSS, 'utf8');

// Collect class names: ".name" where the first char after "." is a letter/_/-
// (so decimals like ".5rem" are skipped). Strips comments first.
const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
const classes = new Set();
for (const m of noComments.matchAll(/\.(-?[_a-zA-Z][-_a-zA-Z0-9]*)/g)) {
  classes.add(m[1]);
}

// Match the class as a STANDALONE token: not preceded/followed by a char that
// could be part of a class name ([-_a-zA-Z0-9]). So "card" won't match
// "PostCard" or "card-content". Still conservative: a bare word in a comment or
// JS identifier counts as a use (keeps the class), so we UNDER-report dead code.
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const used = (name) => {
  const pattern = `(?<![-_a-zA-Z0-9])${reEsc(name)}(?![-_a-zA-Z0-9])`;
  try {
    // Search only files where classes are USED (jsx/js/ts/html), NOT .css where
    // they're DEFINED — otherwise every class matches its own stylesheet rule.
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

const dead = [];
for (const name of [...classes].sort()) {
  if (!used(name)) dead.push(name);
}

// Estimate how many lines each dead class's rule blocks occupy (rough): count
// lines in css where the selector token appears as the start of a selector.
const totalLines = css.split('\n').length;
console.log(`stylesheet: ${CSS} (${totalLines} lines)`);
console.log(`unique class selectors: ${classes.size}`);
console.log(`classes with ZERO source references (candidates): ${dead.length}`);
console.log('');
console.log('--- candidate dead classes (review before deleting) ---');
console.log(dead.join('\n'));
