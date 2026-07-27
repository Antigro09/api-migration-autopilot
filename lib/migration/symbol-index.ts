import {
  Node,
  Project,
  ScriptTarget,
  ModuleKind,
  ModuleResolutionKind,
  SyntaxKind,
} from "ts-morph";
import type { RepositoryFile } from "./contracts";

export type IndexedBinding = {
  moduleName: string;
  importedName: string;
  localName: string;
  kind: "default" | "namespace" | "named" | "require" | "reexport";
  start: number;
  end: number;
};

export type IndexedUsage = {
  kind: "call" | "new" | "reference";
  localName: string;
  memberPath: string[];
  start: number;
  end: number;
  argumentCount?: number;
};

export type IndexedFile = {
  path: string;
  bindings: IndexedBinding[];
  usages: IndexedUsage[];
  syntaxErrors: number;
};

export type RepositorySymbolIndex = {
  files: IndexedFile[];
  skipped: Array<{ path: string; reason: string }>;
};

const CODE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/i;

function rootAndMembers(
  node: Node,
): { localName: string; memberPath: string[] } | null {
  if (Node.isIdentifier(node)) {
    return { localName: node.getText(), memberPath: [] };
  }
  if (Node.isPropertyAccessExpression(node)) {
    const parent = rootAndMembers(node.getExpression());
    if (!parent) return null;
    return {
      localName: parent.localName,
      memberPath: [...parent.memberPath, node.getName()],
    };
  }
  if (Node.isElementAccessExpression(node)) {
    const argument = node.getArgumentExpression();
    if (!argument || !Node.isStringLiteral(argument)) return null;
    const parent = rootAndMembers(node.getExpression());
    if (!parent) return null;
    return {
      localName: parent.localName,
      memberPath: [...parent.memberPath, argument.getLiteralValue()],
    };
  }
  return null;
}

function requireModule(node: Node | undefined): string | null {
  if (!node || !Node.isCallExpression(node)) return null;
  if (node.getExpression().getText() !== "require") return null;
  const argument = node.getArguments()[0];
  return argument && Node.isStringLiteral(argument)
    ? argument.getLiteralValue()
    : null;
}

function declarationBindings(sourceFile: ReturnType<Project["createSourceFile"]>) {
  const bindings: IndexedBinding[] = [];

  for (const declaration of sourceFile.getImportDeclarations()) {
    const moduleName = declaration.getModuleSpecifierValue();
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) {
      bindings.push({
        moduleName,
        importedName: "default",
        localName: defaultImport.getText(),
        kind: "default",
        start: defaultImport.getStart(),
        end: defaultImport.getEnd(),
      });
    }
    const namespace = declaration.getNamespaceImport();
    if (namespace) {
      bindings.push({
        moduleName,
        importedName: "*",
        localName: namespace.getText(),
        kind: "namespace",
        start: namespace.getStart(),
        end: namespace.getEnd(),
      });
    }
    for (const named of declaration.getNamedImports()) {
      const local = named.getAliasNode() ?? named.getNameNode();
      bindings.push({
        moduleName,
        importedName: named.getName(),
        localName: local.getText(),
        kind: "named",
        start: local.getStart(),
        end: local.getEnd(),
      });
    }
  }

  for (const declaration of sourceFile.getDescendantsOfKind(
    SyntaxKind.ImportEqualsDeclaration,
  )) {
    const reference = declaration.getModuleReference();
    const expression = Node.isExternalModuleReference(reference)
      ? reference.getExpression()
      : undefined;
    if (
      expression &&
      Node.isStringLiteral(expression)
    ) {
      bindings.push({
        moduleName: expression.getLiteralValue(),
        importedName: "*",
        localName: declaration.getName(),
        kind: "require",
        start: declaration.getNameNode().getStart(),
        end: declaration.getNameNode().getEnd(),
      });
    }
  }

  for (const statement of sourceFile.getVariableStatements()) {
    for (const declaration of statement.getDeclarations()) {
      const initializer = declaration.getInitializer();
      const directModule = requireModule(initializer);
      const propertyModule =
        initializer && Node.isPropertyAccessExpression(initializer)
          ? requireModule(initializer.getExpression())
          : null;
      const moduleName = directModule ?? propertyModule;
      if (!moduleName) continue;
      const nameNode = declaration.getNameNode();
      if (Node.isIdentifier(nameNode)) {
        bindings.push({
          moduleName,
          importedName:
            propertyModule && Node.isPropertyAccessExpression(initializer)
              ? initializer.getName()
              : "*",
          localName: nameNode.getText(),
          kind: "require",
          start: nameNode.getStart(),
          end: nameNode.getEnd(),
        });
      } else if (Node.isObjectBindingPattern(nameNode)) {
        for (const element of nameNode.getElements()) {
          const property = element.getPropertyNameNode()?.getText();
          const local = element.getNameNode();
          if (!Node.isIdentifier(local)) continue;
          bindings.push({
            moduleName,
            importedName: property ?? local.getText(),
            localName: local.getText(),
            kind: "require",
            start: local.getStart(),
            end: local.getEnd(),
          });
        }
      }
    }
  }

  for (const declaration of sourceFile.getExportDeclarations()) {
    const moduleName = declaration.getModuleSpecifierValue();
    if (!moduleName) continue;
    const namedExports = declaration.getNamedExports();
    if (namedExports.length === 0) {
      bindings.push({
        moduleName,
        importedName: "*",
        localName: "*",
        kind: "reexport",
        start: declaration.getStart(),
        end: declaration.getEnd(),
      });
    }
    for (const named of namedExports) {
      bindings.push({
        moduleName,
        importedName: named.getName(),
        localName: named.getAliasNode()?.getText() ?? named.getName(),
        kind: "reexport",
        start: named.getStart(),
        end: named.getEnd(),
      });
    }
  }
  return bindings;
}

function usageIndex(
  sourceFile: ReturnType<Project["createSourceFile"]>,
  bindings: readonly IndexedBinding[],
): IndexedUsage[] {
  const bindingNames = new Set(
    bindings.filter((binding) => binding.localName !== "*").map((binding) => binding.localName),
  );
  const aliases = new Map<string, string>();
  for (const declaration of sourceFile.getVariableDeclarations()) {
    const name = declaration.getNameNode();
    const initializer = declaration.getInitializer();
    if (
      Node.isIdentifier(name) &&
      initializer &&
      Node.isIdentifier(initializer) &&
      bindingNames.has(initializer.getText())
    ) {
      aliases.set(name.getText(), initializer.getText());
    }
  }
  for (const alias of aliases.keys()) bindingNames.add(alias);

  const usages: IndexedUsage[] = [];
  const addExpression = (
    kind: "call" | "new",
    expression: Node,
    argumentCount: number,
  ) => {
    const root = rootAndMembers(expression);
    if (!root || !bindingNames.has(root.localName)) return;
    usages.push({
      kind,
      localName: aliases.get(root.localName) ?? root.localName,
      memberPath: root.memberPath,
      start: expression.getStart(),
      end: expression.getEnd(),
      argumentCount,
    });
  };
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    addExpression("call", call.getExpression(), call.getArguments().length);
  }
  for (const expression of sourceFile.getDescendantsOfKind(
    SyntaxKind.NewExpression,
  )) {
    addExpression(
      "new",
      expression.getExpression(),
      expression.getArguments().length,
    );
  }
  for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const localName = aliases.get(identifier.getText()) ?? identifier.getText();
    if (!bindingNames.has(identifier.getText())) continue;
    const parent = identifier.getParent();
    if (
      Node.isImportDeclaration(parent) ||
      Node.isImportSpecifier(parent) ||
      Node.isNamespaceImport(parent) ||
      Node.isImportClause(parent) ||
      Node.isVariableDeclaration(parent) ||
      (Node.isPropertyAccessExpression(parent) &&
        parent.getNameNode() === identifier) ||
      Node.isCallExpression(parent) ||
      Node.isNewExpression(parent)
    ) {
      continue;
    }
    const root = rootAndMembers(
      Node.isPropertyAccessExpression(parent) &&
        parent.getExpression() === identifier
        ? parent
        : identifier,
    );
    if (!root) continue;
    usages.push({
      kind: "reference",
      localName,
      memberPath: root.memberPath,
      start: identifier.getStart(),
      end: root.memberPath.length > 0 ? parent.getEnd() : identifier.getEnd(),
    });
  }
  const unique = new Map<string, IndexedUsage>();
  for (const usage of usages) {
    unique.set(
      `${usage.kind}:${usage.localName}:${usage.memberPath.join(".")}:${usage.start}:${usage.end}`,
      usage,
    );
  }
  return [...unique.values()].sort((left, right) => left.start - right.start);
}

export function buildRepositorySymbolIndex(
  files: readonly RepositoryFile[],
): RepositorySymbolIndex {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      noEmit: true,
      noResolve: true,
      skipLibCheck: true,
      target: ScriptTarget.ESNext,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
    },
  });
  const indexedFiles: IndexedFile[] = [];
  const skipped: RepositorySymbolIndex["skipped"] = [];
  for (const file of files) {
    if (!CODE_EXTENSIONS.test(file.path)) continue;
    if (file.content.includes("\0")) {
      skipped.push({ path: file.path, reason: "Binary content is never analyzed." });
      continue;
    }
    try {
      const sourceFile = project.createSourceFile(file.path, file.content, {
        overwrite: true,
      });
      const bindings = declarationBindings(sourceFile);
      indexedFiles.push({
        path: file.path,
        bindings,
        usages: usageIndex(sourceFile, bindings),
        syntaxErrors:
          project.getProgram().getSyntacticDiagnostics(sourceFile).length,
      });
    } catch {
      skipped.push({
        path: file.path,
        reason: "The TypeScript parser could not create a safe syntax tree.",
      });
    }
  }
  return { files: indexedFiles, skipped };
}

export const symbolIndexerVersion = "typescript-ts-morph-symbol-index/2.0.0";
