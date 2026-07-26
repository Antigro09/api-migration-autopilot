import ts from "typescript";
import type {
  SyntaxValidationResult,
  SyntaxValidator,
} from "./patch-security";

function scriptKind(path: string): ts.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:c|m)?ts$/.test(lower)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/**
 * Parse-only syntax proof for generated files. The TypeScript parser never
 * executes repository code and never resolves modules, so this runs safely on
 * untrusted source and produces the syntax evidence the publication invariant
 * requires.
 */
export class TypeScriptSyntaxValidator implements SyntaxValidator {
  async validate(
    path: string,
    content: string,
  ): Promise<SyntaxValidationResult> {
    let source: ts.SourceFile;
    try {
      source = ts.createSourceFile(
        path,
        content,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ false,
        scriptKind(path),
      );
    } catch (error) {
      return {
        valid: false,
        message:
          error instanceof Error
            ? `The generated file could not be parsed: ${error.message.slice(0, 200)}`
            : "The generated file could not be parsed.",
      };
    }

    const diagnostics = (
      source as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }
    ).parseDiagnostics;
    const first = diagnostics?.[0];
    if (!first) return { valid: true };

    const position = source.getLineAndCharacterOfPosition(first.start);
    const messageText =
      typeof first.messageText === "string"
        ? first.messageText
        : first.messageText.messageText;
    return {
      valid: false,
      message: `Syntax error at line ${position.line + 1}, column ${
        position.character + 1
      }: ${messageText}`.slice(0, 500),
    };
  }
}

export const syntaxValidatorVersion = "typescript-parser/1.0.0";
