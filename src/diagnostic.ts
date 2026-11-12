// Diagnostics are data (rule 5.5): fixed fields, the location as quoted text,
// and a ready-made fix where one is known.
//
// Code ranges: E00xx lexer, E01xx parser, E02xx checker, E03xx emitter.

export interface Fix {
  readonly replace: string;
  readonly with: string;
}

export interface Diagnostic {
  readonly code: string;
  readonly definition: string | null;
  readonly section: string | null;
  readonly at: string;
  readonly message: string;
  readonly expected: string | null;
  readonly fix: Fix | null;
}

export class AlangError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(`${diagnostic.code}: ${diagnostic.message} at \`${diagnostic.at}\``);
    this.name = "AlangError";
  }
}

export function diagnostic(
  fields: Pick<Diagnostic, "code" | "at" | "message"> & Partial<Diagnostic>,
): Diagnostic {
  // Fixed field order, as in the spec's example.
  return {
    code: fields.code,
    definition: fields.definition ?? null,
    section: fields.section ?? null,
    at: fields.at,
    message: fields.message,
    expected: fields.expected ?? null,
    fix: fields.fix ?? null,
  };
}
