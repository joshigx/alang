// Diagnostics are data (rule 5.5): fixed fields, the location as quoted text,
// and a ready-made fix where one is known.
//
// Code ranges: E00xx lexer, E01xx parser, E02xx checker, E03xx emitter and
// toolchain, E04xx examples (5.1), E05xx database operations (6).

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

// One or more diagnostics; the checker reports all causes it finds (5.6).
export class AlangError extends Error {
  readonly diagnostics: readonly Diagnostic[];
  constructor(diagnostics: Diagnostic | readonly Diagnostic[]) {
    const list = Array.isArray(diagnostics) ? diagnostics : [diagnostics as Diagnostic];
    super(list.map((d) => `${d.code}: ${d.message} at \`${d.at}\``).join("\n"));
    this.name = "AlangError";
    this.diagnostics = list;
  }

  get diagnostic(): Diagnostic {
    return this.diagnostics[0];
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
