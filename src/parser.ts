// Recursive descent parser for the grammar in the specification, section 3.

import type {
  Arg,
  ArithOp,
  Arm,
  BinaryOp,
  Case,
  CompareOp,
  Definition,
  Expr,
  FnDef,
  Literal,
  Param,
  Path,
  Pattern,
  Payload,
  Stmt,
  TypeDef,
  TypeRef,
} from "./ast.ts";
import { type Effect, EFFECTS, pathText } from "./ast.ts";
import { AlangError, diagnostic, type Fix } from "./diagnostic.ts";
import { lex, type Token } from "./lexer.ts";

const COMPARE_OPS: readonly string[] = ["==", "!=", "<", "<=", ">", ">="];
const ADDITIVE: readonly string[] = ["+", "-"];
const MULTIPLICATIVE: readonly string[] = ["*", "/", "%"];

export function parseProgram(source: string): Definition[] {
  return new Parser(lex(source)).program();
}

// Parses a sequence of statements, as found in a body. Used for spec
// fragments and tests.
export function parseStatements(source: string): Stmt[] {
  const p = new Parser(lex(source));
  const stmts = p.block([]);
  p.expectEof();
  return stmts;
}

export function parseExpression(source: string): Expr {
  const p = new Parser(lex(source));
  const e = p.expr();
  p.skipNewlines();
  p.expectEof();
  return e;
}

class Parser {
  private pos = 0;
  private definition: string | null = null;
  private section: string | null = null;

  constructor(private readonly tokens: Token[]) {}

  // ---- token helpers ----

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.pos++;
    return t;
  }

  private isKeyword(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "keyword" && t.text === word;
  }

  private isSymbol(symbol: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "symbol" && t.text === symbol;
  }

  private fail(message: string, extra: { expected?: string; fix?: Fix; code?: string; at?: string } = {}): never {
    const t = this.peek();
    throw new AlangError(
      diagnostic({
        code: extra.code ?? "E0101",
        definition: this.definition,
        section: this.section,
        at: extra.at ?? (t.kind === "eof" ? "<end of text>" : t.lineText),
        message,
        expected: extra.expected ?? null,
        fix: extra.fix ?? null,
      }),
    );
  }

  private describe(t: Token): string {
    if (t.kind === "eof") return "end of text";
    if (t.kind === "newline") return "line break";
    return `\`${t.text}\``;
  }

  private expectKeyword(word: string): void {
    if (!this.isKeyword(word)) {
      this.fail(`Expected \`${word}\`, found ${this.describe(this.peek())}.`, { expected: word });
    }
    this.next();
  }

  private expectSymbol(symbol: string): void {
    if (!this.isSymbol(symbol)) {
      this.fail(`Expected \`${symbol}\`, found ${this.describe(this.peek())}.`, { expected: symbol });
    }
    this.next();
  }

  private expectName(): string {
    const t = this.peek();
    if (t.kind !== "name") this.fail(`Expected a snake_case name, found ${this.describe(t)}.`);
    return this.next().text;
  }

  private expectTypeName(): string {
    const t = this.peek();
    if (t.kind !== "typename") this.fail(`Expected a PascalCase type name, found ${this.describe(t)}.`);
    return this.next().text;
  }

  skipNewlines(): void {
    while (this.peek().kind === "newline") this.next();
  }

  private expectNewline(): void {
    const t = this.peek();
    if (t.kind === "eof") return;
    if (t.kind !== "newline") this.fail(`Expected a line break, found ${this.describe(t)}.`);
    this.skipNewlines();
  }

  expectEof(): void {
    this.skipNewlines();
    if (this.peek().kind !== "eof") this.fail(`Expected end of text, found ${this.describe(this.peek())}.`);
  }

  // ---- definitions ----

  program(): Definition[] {
    const defs: Definition[] = [];
    this.skipNewlines();
    while (this.peek().kind !== "eof") {
      defs.push(this.definitionDef());
      this.skipNewlines();
    }
    return defs;
  }

  private definitionDef(): Definition {
    this.definition = null;
    this.section = null;
    if (this.isKeyword("fn")) return this.fnDef();
    if (this.isKeyword("type")) return this.typeDef();
    if (this.isKeyword("const") || this.isKeyword("extern")) {
      this.fail(`\`${this.peek().text}\` definitions are not supported yet.`, { code: "E0199" });
    }
    return this.fail(`Expected a definition (\`fn\` or \`type\`), found ${this.describe(this.peek())}.`);
  }

  // `a.b.c` where every segment is snake_case: function and module paths.
  private valuePath(): Path {
    const segments = [this.expectName()];
    while (this.isSymbol(".")) {
      this.next();
      segments.push(this.expectName());
    }
    return segments;
  }

  // `a.b.Name`: zero or more snake_case segments, then one PascalCase segment.
  private typePath(): Path {
    const segments: string[] = [];
    while (this.peek().kind === "name") {
      segments.push(this.next().text);
      this.expectSymbol(".");
    }
    segments.push(this.expectTypeName());
    return segments;
  }

  private definitionPath(kind: "fn" | "type"): Path {
    const path = kind === "fn" ? this.valuePath() : this.typePath();
    if (path.length < 2) {
      this.fail(`A definition name has a module: \`module.${path[0]}\`.`);
    }
    return path;
  }

  private sectionHeader(word: string): void {
    this.section = word;
    this.expectKeyword(word);
    this.expectSymbol(":");
  }

  private endDef(kind: "fn" | "type", path: Path): void {
    this.section = null;
    this.expectKeyword("end");
    this.expectKeyword(kind);
    const endPath = this.definitionPath(kind);
    if (pathText(endPath) !== pathText(path)) {
      this.fail(`The block end names \`${pathText(endPath)}\`, but the definition is \`${pathText(path)}\`.`, {
        code: "E0103",
        expected: `end ${kind} ${pathText(path)}`,
        fix: { replace: `end ${kind} ${pathText(endPath)}`, with: `end ${kind} ${pathText(path)}` },
      });
    }
    this.expectNewline();
  }

  private docSection(): string {
    this.sectionHeader("doc");
    const t = this.peek();
    if (t.kind !== "string") this.fail("`doc` holds one string literal.");
    this.next();
    this.expectNewline();
    return t.value as string;
  }

  // `none` on the same line, or a line break followed by entries.
  private noneOrEntries<T>(entry: () => T, stop: () => boolean): T[] {
    if (this.isKeyword("none")) {
      this.next();
      this.expectNewline();
      return [];
    }
    this.expectNewline();
    const items: T[] = [];
    while (!stop()) {
      items.push(entry());
      this.expectNewline();
    }
    if (items.length === 0) this.fail("An empty section is written `none`.");
    return items;
  }

  private noneOrExpr(): Expr | null {
    if (this.isKeyword("none")) {
      this.next();
      this.expectNewline();
      return null;
    }
    const e = this.expr();
    this.expectNewline();
    return e;
  }

  // A name that introduces a binding. `result` (in `ensures`) and `error`
  // (in `let ... else`) are bound by the language and cannot be rebound.
  private bindingName(): string {
    const t = this.peek();
    if (t.kind === "name" && (t.text === "result" || t.text === "error")) {
      this.fail(`\`${t.text}\` is bound by the language and cannot name a parameter or binding.`, {
        code: "E0109",
        at: t.text,
      });
    }
    return this.expectName();
  }

  private param(binding = true): Param {
    const name = binding ? this.bindingName() : this.expectName();
    this.expectSymbol(":");
    return { name, type: this.type() };
  }

  private fnDef(): FnDef {
    this.expectKeyword("fn");
    const path = this.definitionPath("fn");
    this.definition = pathText(path);
    this.expectNewline();
    const doc = this.docSection();

    this.sectionHeader("in");
    const params = this.noneOrEntries(() => this.param(), () => this.peek().kind !== "name");

    this.sectionHeader("out");
    const out = this.type();
    this.expectNewline();

    this.sectionHeader("effects");
    const effects: Effect[] = [];
    if (this.isKeyword("none")) {
      this.next();
    } else {
      effects.push(this.effect());
      while (this.isSymbol(",")) {
        this.next();
        effects.push(this.effect());
      }
      // One spelling per set of effects: the order of the effect table, each once.
      const canonical = EFFECTS.filter((e) => effects.includes(e));
      if (canonical.join(", ") !== effects.join(", ")) {
        this.fail("Effects are listed once each, in the order of the effect table.", {
          code: "E0111",
          at: `effects: ${effects.join(", ")}`,
          expected: canonical.join(", "),
          fix: { replace: `effects: ${effects.join(", ")}`, with: `effects: ${canonical.join(", ")}` },
        });
      }
    }
    this.expectNewline();

    this.sectionHeader("requires");
    const requires = this.noneOrExpr();
    this.sectionHeader("ensures");
    const ensures = this.noneOrExpr();

    this.sectionHeader("examples");
    const examples = this.noneOrEntries(
      () => this.example(),
      () => this.isKeyword("body") || this.peek().kind === "eof",
    );

    this.sectionHeader("body");
    this.expectNewline();
    const body = this.block(["end"]);

    this.endDef("fn", path);
    return { kind: "fn", path, doc, params, out, effects, requires, ensures, examples, body };
  }

  private effect(): Effect {
    const written = pathText(this.valuePath());
    if (!(EFFECTS as readonly string[]).includes(written)) {
      this.fail(`Unknown effect \`${written}\`. The effects are: ${EFFECTS.join(", ")}.`, {
        code: "E0104",
        at: written,
      });
    }
    return written as Effect;
  }

  private example(): Expr {
    const e = this.expr();
    if (e.kind !== "binary" || e.op !== "==" || e.left.kind !== "call") {
      this.fail("An example has the form `call(...) == expected`.", { code: "E0105" });
    }
    return e;
  }

  private typeDef(): TypeDef {
    this.expectKeyword("type");
    const path = this.definitionPath("type");
    this.definition = pathText(path);
    this.expectNewline();
    const doc = this.docSection();

    let shape: TypeDef["shape"];
    if (this.isKeyword("record")) {
      this.sectionHeader("record");
      this.expectNewline();
      const fields: Param[] = [];
      while (this.peek().kind === "name") {
        fields.push(this.param(false));
        this.expectNewline();
      }
      if (fields.length === 0) this.fail("A record has at least one field.");
      shape = { kind: "record", fields };
    } else if (this.isKeyword("variant")) {
      this.sectionHeader("variant");
      this.expectNewline();
      const cases: Case[] = [];
      while (this.peek().kind === "typename") {
        const name = this.next().text;
        let payload: TypeRef | null = null;
        if (this.isSymbol(":")) {
          this.next();
          payload = this.type();
        }
        cases.push({ name, payload });
        this.expectNewline();
      }
      if (cases.length === 0) this.fail("A variant has at least one case.");
      shape = { kind: "variant", cases };
    } else {
      return this.fail("Expected `record:` or `variant:`.");
    }

    this.sectionHeader("where");
    const where = this.noneOrExpr();
    this.endDef("type", path);
    return { kind: "type", path, doc, shape, where };
  }

  // ---- types ----

  type(): TypeRef {
    const path = this.typePath();
    const args: TypeRef[] = [];
    if (this.isSymbol("<")) {
      this.next();
      args.push(this.type());
      while (this.isSymbol(",")) {
        this.next();
        args.push(this.type());
      }
      this.expectSymbol(">");
    }
    if (this.isSymbol("[")) {
      this.fail("A list type is written `List<T>`.", { code: "E0006", expected: "List<T>" });
    }
    return { kind: "type", path, args };
  }

  // ---- statements ----

  // Statements up to (not including) one of the given keywords. With no
  // keywords, up to end of text.
  block(terminators: readonly string[]): Stmt[] {
    const atEnd = () => {
      const t = this.peek();
      return t.kind === "eof" || (t.kind === "keyword" && terminators.includes(t.text));
    };
    this.skipNewlines();
    const stmts: Stmt[] = [];
    while (!atEnd()) {
      stmts.push(this.stmt());
      if (!atEnd()) this.expectNewline();
    }
    if (stmts.length === 0) this.fail("A block holds at least one statement.");
    return stmts;
  }

  private stmt(): Stmt {
    if (this.isKeyword("let")) {
      this.next();
      const name = this.bindingName();
      this.expectSymbol(":");
      const type = this.type();
      this.expectSymbol("=");
      const value = this.expr();
      let elseReturn: Expr | null = null;
      if (this.isKeyword("else")) {
        this.next();
        this.expectKeyword("return");
        elseReturn = this.expr();
      }
      return { kind: "let", name, type, value, elseReturn };
    }
    if (this.isKeyword("return")) {
      this.next();
      return { kind: "return", value: this.expr() };
    }
    if (this.isKeyword("if")) return { kind: "expr", expr: this.ifExpr(true) };
    return { kind: "expr", expr: this.expr() };
  }

  // ---- expressions ----
  // Precedence (rule 3.5): logic < comparison < arithmetic. Mixing `and` with
  // `or`, or `+ -` with `* / %`, requires parentheses. Comparisons do not chain.

  expr(): Expr {
    const first = this.notExpr();
    if (!(this.isKeyword("and") || this.isKeyword("or"))) return first;
    const op = this.peek().text as "and" | "or";
    let left = first;
    while (this.isKeyword("and") || this.isKeyword("or")) {
      if (this.peek().text !== op) {
        this.fail("Mixing `and` with `or` requires parentheses.", { code: "E0102" });
      }
      this.next();
      left = { kind: "binary", op, left, right: this.notExpr() };
    }
    return left;
  }

  private notExpr(): Expr {
    if (this.isKeyword("not")) {
      this.next();
      return { kind: "not", operand: this.notExpr() };
    }
    return this.comparison();
  }

  private comparison(): Expr {
    const left = this.arith();
    const t = this.peek();
    if (t.kind !== "symbol" || !COMPARE_OPS.includes(t.text)) return left;
    this.next();
    const right = this.arith();
    const after = this.peek();
    if (after.kind === "symbol" && COMPARE_OPS.includes(after.text)) {
      this.fail("Comparisons do not chain; combine them with `and`.", { code: "E0102" });
    }
    return { kind: "binary", op: t.text as CompareOp, left, right };
  }

  private arith(): Expr {
    let left = this.postfix();
    const t = this.peek();
    if (t.kind !== "symbol") return left;
    const group = ADDITIVE.includes(t.text) ? ADDITIVE : MULTIPLICATIVE.includes(t.text) ? MULTIPLICATIVE : null;
    if (group === null) return left;
    for (;;) {
      const op = this.peek();
      if (op.kind !== "symbol") break;
      const isAdd = ADDITIVE.includes(op.text);
      const isMul = MULTIPLICATIVE.includes(op.text);
      if (!isAdd && !isMul) break;
      if (!group.includes(op.text)) {
        this.fail("Mixing `+ -` with `* / %` requires parentheses.", { code: "E0102" });
      }
      this.next();
      left = { kind: "binary", op: op.text as ArithOp, left, right: this.postfix() };
    }
    return left;
  }

  // Field access on calls, constructs and parenthesized expressions. No
  // valid text has `[` right after an expression, so it is index access.
  private postfix(): Expr {
    let e = this.primary();
    while (this.isSymbol(".") && e.kind !== "name") {
      this.next();
      e = { kind: "field", target: e, field: this.expectName() };
    }
    if (this.isSymbol("[")) {
      this.fail("There is no index access; use `std.list.get(list: xs, index: i)` (4.6).", { code: "E0006" });
    }
    return e;
  }

  private literal(): Literal | null {
    const t = this.peek();
    const negative = t.kind === "symbol" && t.text === "-" &&
      (this.peek(1).kind === "int" || this.peek(1).kind === "float");
    const num = negative ? this.peek(1) : t;
    if (num.kind === "int" || num.kind === "float") {
      if (negative) this.next();
      this.next();
      if (negative && num.value === 0) {
        this.fail("`-0` is written `0`.", {
          code: "E0003",
          expected: "0",
          fix: { replace: `-${num.text}`, with: num.text },
        });
      }
      const value = (negative ? -1 : 1) * (num.value as number);
      return num.kind === "int" ? { kind: "int", value } : { kind: "float", value };
    }
    if (t.kind === "string") {
      this.next();
      return { kind: "string", value: t.value as string };
    }
    if (this.isKeyword("true") || this.isKeyword("false")) {
      this.next();
      return { kind: "bool", value: t.text === "true" };
    }
    return null;
  }

  private primary(): Expr {
    const lit = this.literal();
    if (lit) return lit;

    const t = this.peek();
    if (this.isSymbol("(")) {
      this.next();
      this.skipNewlines();
      const e = this.expr();
      this.skipNewlines();
      this.expectSymbol(")");
      return e;
    }
    if (this.isSymbol("[")) return this.listExpr();
    if (this.isKeyword("if")) return this.ifExpr(false);
    if (this.isKeyword("match")) return this.matchExpr();
    if (this.isKeyword("for")) return this.forExpr();
    if (this.isKeyword("fn")) return this.lambda();
    if (t.kind === "name" || t.kind === "typename") return this.pathExpr();
    if (this.isSymbol("-")) {
      this.fail("There is no unary minus except on number literals; write `0 - x`.", { code: "E0106" });
    }
    return this.fail(`Expected an expression, found ${this.describe(t)}.`);
  }

  private pathExpr(): Expr {
    const segments: string[] = [];
    for (;;) {
      const t = this.next();
      segments.push(t.text);
      if (t.kind === "typename") {
        return { kind: "construct", path: segments, payload: this.payload() };
      }
      if (!(this.isSymbol(".") && (this.peek(1).kind === "name" || this.peek(1).kind === "typename"))) break;
      this.next();
    }
    const typeArgs = this.tryTypeArgs();
    if (typeArgs !== null || this.isSymbol("(")) {
      return { kind: "call", path: segments, typeArgs: typeArgs ?? [], args: this.args() };
    }
    return { kind: "name", path: segments };
  }

  // `<T, U>` directly followed by `(`, or null without consuming anything.
  // Distinguishes `std.list.empty<Int>()` from the comparison `n < limit`.
  private tryTypeArgs(): TypeRef[] | null {
    if (!this.isSymbol("<")) return null;
    const start = this.pos;
    try {
      this.next();
      const args = [this.type()];
      while (this.isSymbol(",")) {
        this.next();
        args.push(this.type());
      }
      this.expectSymbol(">");
      if (this.isSymbol("(")) return args;
    } catch (e) {
      if (!(e instanceof AlangError)) throw e;
    }
    this.pos = start;
    return null;
  }

  // `[a, b, c]`. Line breaks inside the brackets are ignored, as inside
  // parentheses. `[]` parses, so that the checker can name the empty list's
  // spelling with its item type (E0228).
  private listExpr(): Expr {
    this.expectSymbol("[");
    this.skipNewlines();
    const items: Expr[] = [];
    if (!this.isSymbol("]")) {
      items.push(this.expr());
      this.skipNewlines();
      while (this.isSymbol(",")) {
        this.next();
        this.skipNewlines();
        if (this.isSymbol("]")) this.fail("A list ends after its last item; remove the comma before `]`.");
        items.push(this.expr());
        this.skipNewlines();
      }
    }
    this.expectSymbol("]");
    return { kind: "list", items };
  }

  private args(): Arg[] {
    this.expectSymbol("(");
    this.skipNewlines();
    const args: Arg[] = [];
    if (!this.isSymbol(")")) {
      args.push(this.arg());
      this.skipNewlines();
      while (this.isSymbol(",")) {
        this.next();
        this.skipNewlines();
        args.push(this.arg());
        this.skipNewlines();
      }
    }
    this.expectSymbol(")");
    return args;
  }

  private arg(): Arg {
    if (!(this.peek().kind === "name" && this.isSymbol(":", 1))) {
      this.fail("Every argument carries its parameter name: `name: value`.", { code: "E0107" });
    }
    const name = this.next().text;
    this.next();
    return { name, value: this.expr() };
  }

  private payload(): Payload {
    if (!this.isSymbol("(")) return null;
    if (this.peek(1).kind === "name" && this.isSymbol(":", 2)) {
      return { kind: "args", args: this.args() };
    }
    this.next();
    this.skipNewlines();
    const value = this.expr();
    this.skipNewlines();
    this.expectSymbol(")");
    return { kind: "value", value };
  }

  // Without `else` an `if` has no value, so it may only stand as a statement.
  private ifExpr(statement: boolean): Expr {
    this.expectKeyword("if");
    const cond = this.expr();
    this.expectKeyword("then");
    const then = this.block(["else", "end"]);
    let elseBlock: Stmt[] | null = null;
    if (this.isKeyword("else")) {
      this.next();
      elseBlock = this.block(["end"]);
    } else if (!statement) {
      this.fail("An `if` that yields a value needs an `else` branch.", { code: "E0110" });
    }
    this.expectKeyword("end");
    this.expectKeyword("if");
    return { kind: "if", cond, then, else: elseBlock };
  }

  private matchExpr(): Expr {
    this.expectKeyword("match");
    const subject = this.expr();
    this.skipNewlines();
    const arms: Arm[] = [];
    while (this.isKeyword("case")) {
      this.next();
      const pattern = this.pattern(true);
      this.expectKeyword("then");
      arms.push({ pattern, body: this.block(["case", "end"]) });
    }
    if (arms.length === 0) this.fail("A `match` has at least one `case`.");
    this.expectKeyword("end");
    this.expectKeyword("match");
    return { kind: "match", subject, arms };
  }

  private pattern(top: boolean): Pattern {
    const lit = this.literal();
    if (lit) return { kind: "literal", value: lit };
    const t = this.peek();
    if (t.kind === "name" && !this.isSymbol(".", 1)) {
      if (top) {
        this.fail("There is no catch-all case; every variant has its own `case` (rule 3.3).", { code: "E0108" });
      }
      return { kind: "bind", name: this.bindingName() };
    }
    const path = this.typePath();
    let sub: Pattern | null = null;
    if (this.isSymbol("(")) {
      this.next();
      sub = this.pattern(false);
      this.expectSymbol(")");
    }
    return { kind: "case", path, sub };
  }

  private forExpr(): Expr {
    this.expectKeyword("for");
    const name = this.bindingName();
    this.expectSymbol(":");
    const type = this.type();
    this.expectKeyword("in");
    const iterable = this.expr();
    this.expectKeyword("do");
    const body = this.block(["end"]);
    this.expectKeyword("end");
    this.expectKeyword("for");
    return { kind: "for", name, type, iterable, body };
  }

  private lambda(): Expr {
    this.expectKeyword("fn");
    this.expectSymbol("(");
    const params = [this.param()];
    while (this.isSymbol(",")) {
      this.next();
      params.push(this.param());
    }
    this.expectSymbol(")");
    this.expectSymbol(":");
    const out = this.type();
    this.expectSymbol("=>");
    return { kind: "lambda", params, out, body: this.expr() };
  }
}

export type { BinaryOp };
