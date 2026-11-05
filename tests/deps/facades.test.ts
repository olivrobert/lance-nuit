// A facade is the surface of a context, so two things keep it honest that the import
// graph cannot see: it holds nothing but re-exports, and it exposes no name nobody
// outside the context asks for. A name without a caller is a door left open for
// the next import, which is how a surface grows back to the whole context.
//
// Tests do not count as callers: they are outside the architecture gate and import
// the files they exercise directly.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { FACADES, moduleEntries } = createRequire(import.meta.url)(join(REPO_ROOT, "scripts/layers.cjs")) as {
  FACADES: { name: string; path: string; entry: string; otherEntries?: string[] }[];
  moduleEntries: (module: { entry: string; otherEntries?: string[] }) => string[];
};

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(join(REPO_ROOT, path), "utf8"), ts.ScriptTarget.Latest, true);
}

function productionFiles(directory: string): string[] {
  return readdirSync(join(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(directory, entry.name);

    if (entry.isDirectory()) return path === "src/dashboard/ui/app" ? [] : productionFiles(path);

    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The file a relative specifier of `from` names, as `.ts`; `null` for a package. */
function targetOf(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;

  return posix.normalize(posix.join(posix.dirname(from), specifier)).replace(/\.js$/, ".ts");
}

function callersByFacadeFile(): Map<string, Set<string>> {
  const called = new Map<string, Set<string>>();
  const note = (facadeFile: string | null, name: string): void => {
    if (facadeFile === null) return;

    const names = called.get(facadeFile) ?? new Set<string>();

    names.add(name);
    called.set(facadeFile, names);
  };

  for (const path of productionFiles("src")) {
    const source = parse(path);
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const bindings = node.importClause?.namedBindings;

        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            note(targetOf(path, node.moduleSpecifier.text), (element.propertyName ?? element.name).text);
          }
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            note(targetOf(path, node.moduleSpecifier.text), (element.propertyName ?? element.name).text);
          }
        }
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        const { literal } = node.argument;
        let first: ts.EntityName | undefined = node.qualifier;

        while (first && ts.isQualifiedName(first)) first = first.left;

        if (first && ts.isStringLiteral(literal)) note(targetOf(path, literal.text), first.text);
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return called;
}

const facadeFiles = FACADES.flatMap((facade) => moduleEntries(facade).map((entry) => posix.join(facade.path, entry)));

test("a facade holds nothing but named re-exports", () => {
  const offending = facadeFiles.flatMap((file) =>
    parse(file)
      .statements.filter(
        (statement) =>
          !ts.isExportDeclaration(statement) ||
          statement.moduleSpecifier === undefined ||
          statement.exportClause === undefined ||
          !ts.isNamedExports(statement.exportClause),
      )
      .map((statement) => `${file}: ${statement.getText().slice(0, 60)}`),
  );

  expect(offending).toEqual([]);
});

test("every name a facade exports has a caller outside its context", () => {
  const callers = callersByFacadeFile();
  const unused = facadeFiles.flatMap((file) =>
    parse(file).statements.flatMap((statement) => {
      if (!ts.isExportDeclaration(statement) || !statement.exportClause) return [];
      if (!ts.isNamedExports(statement.exportClause)) return [];

      return statement.exportClause.elements
        .map((element) => element.name.text)
        .filter((name) => !callers.get(file)?.has(name))
        .map((name) => `${relative(REPO_ROOT, join(REPO_ROOT, file))}: ${name}`);
    }),
  );

  expect(unused).toEqual([]);
});
