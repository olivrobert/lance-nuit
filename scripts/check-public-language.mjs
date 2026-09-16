#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicRoots = ["README.md", "bin", "docs", "guide", "examples", "src/engine/backends/claude-code/prompts"];
const accentedFrench = /[àâäçéèêëîïôöùûüÿœ]/i;
// Unaccented French tokens that cannot be mistaken for English. Accent
// detection above catches the rest; this list only closes the gap left by words
// that carry no diacritic at all.
const frenchWords =
  /\b(artefact|aucune?|attend|avec|connus?|dans|doit|echec|erreur|fichier|illisible|inconnue?|introuvable|invalide|manquante?|perimee?|possiblement|pour|repertoire|reprenable|retourne|satisfaite|sortie|supprimable|veuillez)\b/i;

function filesUnder(path) {
  const absolute = join(root, path);
  if (!statSync(absolute).isDirectory()) return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", ".lance-nuit", "coverage", "node_modules"].includes(entry.name)) return [];
    const child = join(absolute, entry.name);
    return entry.isDirectory() ? filesUnder(relative(root, child)) : [child];
  });
}

const violations = [];
for (const file of publicRoots.flatMap(filesUnder)) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (accentedFrench.test(line)) violations.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
  }
}

// Every TypeScript file is public: sources ship in the package, tests are
// readable on the repository. Accents anywhere in them are a language leak,
// whether in an error message, a comment, or a test fixture.
for (const file of filesUnder(".").filter((path) => path.endsWith(".ts"))) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (accentedFrench.test(line) || frenchWords.test(line)) {
      violations.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`Public-language check failed:\n- ${violations.join("\n- ")}\n`);
  process.exit(1);
}

console.log("Public-language check passed.");
