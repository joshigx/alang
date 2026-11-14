// Syntax tree of alang. The tree carries no source positions and no
// parentheses: by rule 3.7 the canonical text is derived from the tree alone,
// so two texts with the same tree are the same program.

export type Path = readonly string[];

export type TypeRef =
  | { readonly kind: "type"; readonly path: Path; readonly args: readonly TypeRef[] }
  // `(A, B) -> R`: at least one parameter (F5); always pure (F3).
  | { readonly kind: "function"; readonly params: readonly TypeRef[]; readonly out: TypeRef };

export interface Param {
  readonly name: string;
  readonly type: TypeRef;
}

export interface Arg {
  readonly name: string;
  readonly value: Expr;
}

export type ArithOp = "+" | "-" | "*" | "/" | "%";
export type CompareOp = "==" | "!=" | "<" | "<=" | ">" | ">=";
export type LogicOp = "and" | "or";
export type BinaryOp = ArithOp | CompareOp | LogicOp;

export type Expr =
  | { readonly kind: "int"; readonly value: number }
  | { readonly kind: "float"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean }
  // A dotted chain of snake_case names: a local, a field chain on a local,
  // a constant (with fields) or a function value. Which one is decided by
  // name resolution.
  | { readonly kind: "name"; readonly path: Path }
  // Field access on an expression that is not a plain name (call, construct, parenthesized).
  | { readonly kind: "field"; readonly target: Expr; readonly field: string }
  | {
    readonly kind: "call";
    readonly path: Path;
    readonly typeArgs: readonly TypeRef[];
    readonly args: readonly Arg[];
  }
  // Applying a function value (F2): a local, or a field of one, of function
  // type, with unnamed arguments, since a function type names no parameters.
  | {
    readonly kind: "apply";
    readonly target: { readonly kind: "name"; readonly path: Path };
    readonly args: readonly Expr[];
  }
  // `typeArgs` are written where neither the expected type nor the value
  // gives the case's type (G7): `None<Int>`, `Leaf<Int>`; `[]` otherwise.
  | {
    readonly kind: "construct";
    readonly path: Path;
    readonly typeArgs: readonly TypeRef[];
    readonly payload: Payload;
  }
  // `[a, b, c]`: at least one item in valid text; `[]` parses so that the
  // checker can name the empty list's one spelling (E0228).
  | { readonly kind: "list"; readonly items: readonly Expr[] }
  // `["a": 1, "b": 2]`: at least one entry in valid text; `[:]` parses so
  // that the checker can name the empty map's one spelling (E0228).
  | { readonly kind: "map"; readonly entries: readonly MapEntry[] }
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr }
  | { readonly kind: "not"; readonly operand: Expr }
  | {
    readonly kind: "if";
    readonly cond: Expr;
    readonly then: readonly Stmt[];
    readonly else: readonly Stmt[] | null;
  }
  | { readonly kind: "match"; readonly subject: Expr; readonly arms: readonly Arm[] }
  | {
    readonly kind: "for";
    readonly name: string;
    readonly type: TypeRef;
    readonly iterable: Expr;
    readonly body: readonly Stmt[];
  }
  | {
    readonly kind: "lambda";
    readonly params: readonly Param[];
    readonly out: TypeRef;
    readonly body: Expr;
  };

export interface MapEntry {
  readonly key: Expr;
  readonly value: Expr;
}

// Record construction carries named args (`Port(value: 1)`), a variant case
// carries at most one unnamed value (`OutOfRange(n)`), rule 4.2.
export type Payload =
  | null
  | { readonly kind: "args"; readonly args: readonly Arg[] }
  | { readonly kind: "value"; readonly value: Expr };

// A case: one pattern, or several joined by `or` that share the body
// (`case A or B then`), at least one.
export interface Arm {
  readonly patterns: readonly Pattern[];
  readonly body: readonly Stmt[];
}

export type Literal = Extract<Expr, { kind: "int" | "float" | "string" | "bool" }>;

export type Pattern =
  | { readonly kind: "case"; readonly path: Path; readonly sub: Pattern | null }
  | { readonly kind: "bind"; readonly name: string }
  | { readonly kind: "literal"; readonly value: Literal };

export type Stmt =
  | {
    readonly kind: "let";
    readonly name: string;
    readonly type: TypeRef;
    readonly value: Expr;
    readonly elseReturn: Expr | null;
  }
  // `expression else return value`: a `Result<Unit, E>` or `Option<Unit>`
  // propagated without a binding, since its content carries nothing (3.2).
  | { readonly kind: "propagate"; readonly value: Expr; readonly elseReturn: Expr }
  // `let [a, b]: List<T> = list else return value`: binds the items of a
  // list of exactly as many items as names (3.2); `type` is the list's.
  | {
    readonly kind: "destructure";
    readonly names: readonly string[];
    readonly type: TypeRef;
    readonly value: Expr;
    readonly elseReturn: Expr;
  }
  | { readonly kind: "return"; readonly value: Expr }
  | { readonly kind: "expr"; readonly expr: Expr };

export interface FnDef {
  readonly kind: "fn";
  readonly path: Path;
  // `fn util.last<T>` (G1, G3): one capital letter each; `[]` without them.
  readonly typeParams: readonly string[];
  readonly doc: string;
  readonly params: readonly Param[];
  readonly out: TypeRef;
  readonly effects: readonly Effect[];
  readonly requires: Expr | null;
  readonly ensures: Expr | null;
  readonly examples: readonly Expr[];
  readonly body: readonly Stmt[];
}

export interface Case {
  readonly name: string;
  readonly payload: TypeRef | null;
}

export interface TypeDef {
  readonly kind: "type";
  readonly path: Path;
  // `type tree.Tree<T>` (G8), as for functions; `[]` without them.
  readonly typeParams: readonly string[];
  readonly doc: string;
  readonly shape:
    | { readonly kind: "record"; readonly fields: readonly Param[] }
    | { readonly kind: "variant"; readonly cases: readonly Case[] };
  readonly where: Expr | null;
}

// `const shop.max_items` (C1): a named value of a module, pure, evaluated
// once when first used; its body ends in `return`, as a function's does.
export interface ConstDef {
  readonly kind: "const";
  readonly path: Path;
  readonly doc: string;
  readonly out: TypeRef;
  readonly body: readonly Stmt[];
}

export type Definition = FnDef | TypeDef | ConstDef;

export const EFFECTS = [
  "fs.read",
  "fs.write",
  "net",
  "time",
  "random",
  "env",
  "log",
  "console",
] as const;

export type Effect = typeof EFFECTS[number];

export function moduleOf(path: Path): Path {
  return path.slice(0, -1);
}

export function pathText(path: Path): string {
  return path.join(".");
}
