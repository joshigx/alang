// Syntax tree of alang. The tree carries no source positions and no
// parentheses: by rule 3.7 the canonical text is derived from the tree alone,
// so two texts with the same tree are the same program.

export type Path = readonly string[];

export interface TypeRef {
  readonly kind: "type";
  readonly path: Path;
  readonly args: readonly TypeRef[];
}

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
  // or a qualified constant. Which one is decided by name resolution.
  | { readonly kind: "name"; readonly path: Path }
  // Field access on an expression that is not a plain name (call, construct, parenthesized).
  | { readonly kind: "field"; readonly target: Expr; readonly field: string }
  | {
    readonly kind: "call";
    readonly path: Path;
    readonly typeArgs: readonly TypeRef[];
    readonly args: readonly Arg[];
  }
  | { readonly kind: "construct"; readonly path: Path; readonly payload: Payload }
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

// Record construction carries named args (`Port(value: 1)`), a variant case
// carries at most one unnamed value (`OutOfRange(n)`), rule 4.2.
export type Payload =
  | null
  | { readonly kind: "args"; readonly args: readonly Arg[] }
  | { readonly kind: "value"; readonly value: Expr };

export interface Arm {
  readonly pattern: Pattern;
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
  | { readonly kind: "return"; readonly value: Expr }
  | { readonly kind: "expr"; readonly expr: Expr };

export interface FnDef {
  readonly kind: "fn";
  readonly path: Path;
  readonly doc: string;
  readonly params: readonly Param[];
  readonly out: TypeRef;
  readonly effects: readonly string[];
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
  readonly doc: string;
  readonly shape:
    | { readonly kind: "record"; readonly fields: readonly Param[] }
    | { readonly kind: "variant"; readonly cases: readonly Case[] };
  readonly where: Expr | null;
}

export type Definition = FnDef | TypeDef;

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

export function moduleOf(path: Path): Path {
  return path.slice(0, -1);
}

export function pathText(path: Path): string {
  return path.join(".");
}
