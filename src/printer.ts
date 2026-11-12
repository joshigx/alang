// Canonical text output (rule 3.7): one statement per line, two spaces per
// level, and only the parentheses that rule 3.5 requires.

import type { Definition, Expr, FnDef, Param, Pattern, Payload, Stmt, TypeDef, TypeRef } from "./ast.ts";
import { pathText } from "./ast.ts";
import { escapeChar, groupDigits } from "./lexer.ts";

const STEP = "  ";

export function printProgram(defs: readonly Definition[]): string {
  return defs.map(printDefinition).join("\n\n") + "\n";
}

export function printDefinition(def: Definition): string {
  return def.kind === "fn" ? printFn(def) : printType(def);
}

function section(name: string, entries: readonly string[] | string | null): string[] {
  if (entries === null) return [`${STEP}${name}: none`];
  if (typeof entries === "string") return [`${STEP}${name}: ${entries}`];
  if (entries.length === 0) return [`${STEP}${name}: none`];
  return [`${STEP}${name}:`, ...entries.map((e) => `${STEP}${STEP}${e}`)];
}

function printParam(p: Param): string {
  return `${p.name}: ${printTypeRef(p.type)}`;
}

// The signature of a definition: every section except `body` (section 6).
// A type has no body, so its signature is its whole text.
export function printSignature(def: Definition): string {
  return def.kind === "fn" ? printFn(def, false) : printType(def);
}

function printFn(def: FnDef, body = true): string {
  const name = pathText(def.path);
  const inner = STEP + STEP;
  return [
    `fn ${name}`,
    ...section("doc", printString(def.doc)),
    ...section("in", def.params.map(printParam)),
    ...section("out", printTypeRef(def.out)),
    ...section("effects", def.effects.length === 0 ? null : def.effects.join(", ")),
    ...section("requires", def.requires && printExpr(def.requires, inner)),
    ...section("ensures", def.ensures && printExpr(def.ensures, inner)),
    ...section("examples", def.examples.map((e) => printExpr(e, inner))),
    ...(body ? [`${STEP}body:`, printStmts(def.body, inner)] : []),
    `end fn ${name}`,
  ].join("\n");
}

function printType(def: TypeDef): string {
  const name = pathText(def.path);
  const inner = STEP + STEP;
  const shape = def.shape.kind === "record" ? section("record", def.shape.fields.map(printParam)) : section(
    "variant",
    def.shape.cases.map((c) => (c.payload ? `${c.name}: ${printTypeRef(c.payload)}` : c.name)),
  );
  return [
    `type ${name}`,
    ...section("doc", printString(def.doc)),
    ...shape,
    ...section("where", def.where && printExpr(def.where, inner)),
    `end type ${name}`,
  ].join("\n");
}

export function printTypeRef(t: TypeRef): string {
  const head = pathText(t.path);
  return t.args.length === 0 ? head : `${head}<${t.args.map(printTypeRef).join(", ")}>`;
}

export function printString(value: string): string {
  let out = '"';
  for (const ch of value) out += escapeChar(ch) ?? ch;
  return out + '"';
}

// Expands JavaScript's exponent notation (`1e-7`, `1e+21`) into plain digits.
function withoutExponent(text: string): string {
  const m = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!m) return text;
  const digits = m[1] + (m[2] ?? "");
  const point = m[1].length + Number(m[3]);
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

function printNumber(value: number, float: boolean): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (!float) return sign + groupDigits(String(abs));
  const text = withoutExponent(String(abs));
  const [intPart, frac] = text.includes(".") ? text.split(".") : [text, "0"];
  return `${sign}${groupDigits(intPart)}.${frac}`;
}

// Statements, each on its own line at the given indentation.
export function printStmts(stmts: readonly Stmt[], indent: string): string {
  return stmts.map((s) => indent + printStmt(s, indent)).join("\n");
}

function printStmt(s: Stmt, indent: string): string {
  switch (s.kind) {
    case "let": {
      const head = `let ${s.name}: ${printTypeRef(s.type)} = ${printExpr(s.value, indent)}`;
      return s.elseReturn ? `${head} else return ${printExpr(s.elseReturn, indent)}` : head;
    }
    case "return":
      return `return ${printExpr(s.value, indent)}`;
    case "expr":
      return printExpr(s.expr, indent);
  }
}

// Binding strength for parenthesization. Arithmetic splits into two groups
// that may not be mixed without parentheses.
type Level = "logic" | "not" | "compare" | "add" | "mul" | "lambda" | "atom";

function levelOf(e: Expr): Level {
  if (e.kind === "not") return "not";
  // A lambda body extends as far right as possible, so a lambda as an
  // operand always needs parentheses.
  if (e.kind === "lambda") return "lambda";
  if (e.kind !== "binary") return "atom";
  switch (e.op) {
    case "and":
    case "or":
      return "logic";
    case "+":
    case "-":
      return "add";
    case "*":
    case "/":
    case "%":
      return "mul";
    default:
      return "compare";
  }
}

// Whether `child` needs parentheses as the operand of `parent`.
function needsParens(parent: Expr, child: Expr, side: "left" | "right" | "only"): boolean {
  const c = levelOf(child);
  if (c === "atom") return false;
  if (c === "lambda") return parent.kind === "binary" || parent.kind === "not" || parent.kind === "field";
  if (parent.kind === "not") return c === "logic";
  if (parent.kind === "field") return true;
  if (parent.kind !== "binary") return false;
  const p = levelOf(parent);
  switch (p) {
    case "logic":
      if (c === "logic") return side === "right" || (child as { op: string }).op !== parent.op;
      return false;
    case "compare":
      return c === "logic" || c === "not" || c === "compare";
    case "add":
    case "mul":
      if (c === p) return side === "right";
      return true;
    default:
      return false;
  }
}

function operand(parent: Expr, child: Expr, side: "left" | "right" | "only", indent: string): string {
  const text = printExpr(child, indent);
  return needsParens(parent, child, side) ? `(${text})` : text;
}

function printArgs(args: readonly { name: string; value: Expr }[], indent: string): string {
  return args.map((a) => `${a.name}: ${printExpr(a.value, indent)}`).join(", ");
}

function printPayload(p: Payload, indent: string): string {
  if (p === null) return "";
  if (p.kind === "args") return `(${printArgs(p.args, indent)})`;
  return `(${printExpr(p.value, indent)})`;
}

function printPattern(p: Pattern): string {
  switch (p.kind) {
    case "bind":
      return p.name;
    case "literal":
      return printExpr(p.value, "");
    case "case":
      return pathText(p.path) + (p.sub ? `(${printPattern(p.sub)})` : "");
  }
}

// An expression starting on a line with the given indentation. Block
// expressions continue on following lines and close at that indentation.
export function printExpr(e: Expr, indent: string): string {
  const inner = indent + STEP;
  switch (e.kind) {
    case "int":
      return printNumber(e.value, false);
    case "float":
      return printNumber(e.value, true);
    case "string":
      return printString(e.value);
    case "bool":
      return e.value ? "true" : "false";
    case "name":
      return pathText(e.path);
    case "field":
      return `${operand(e, e.target, "only", indent)}.${e.field}`;
    case "call": {
      const typeArgs = e.typeArgs.length === 0 ? "" : `<${e.typeArgs.map(printTypeRef).join(", ")}>`;
      return `${pathText(e.path)}${typeArgs}(${printArgs(e.args, indent)})`;
    }
    case "construct":
      return pathText(e.path) + printPayload(e.payload, indent);
    case "binary":
      return `${operand(e, e.left, "left", indent)} ${e.op} ${operand(e, e.right, "right", indent)}`;
    case "not":
      return `not ${operand(e, e.operand, "only", indent)}`;
    case "if": {
      const lines = [`if ${printExpr(e.cond, indent)} then`, printStmts(e.then, inner)];
      if (e.else) lines.push(`${indent}else`, printStmts(e.else, inner));
      lines.push(`${indent}end if`);
      return lines.join("\n");
    }
    case "match": {
      const lines = [`match ${printExpr(e.subject, indent)}`];
      for (const arm of e.arms) {
        lines.push(`${inner}case ${printPattern(arm.pattern)} then`, printStmts(arm.body, inner + STEP));
      }
      lines.push(`${indent}end match`);
      return lines.join("\n");
    }
    case "for":
      return [
        `for ${e.name}: ${printTypeRef(e.type)} in ${printExpr(e.iterable, indent)} do`,
        printStmts(e.body, inner),
        `${indent}end for`,
      ].join("\n");
    case "lambda":
      return `fn(${e.params.map(printParam).join(", ")}): ${printTypeRef(e.out)} => ${printExpr(e.body, indent)}`;
  }
}
