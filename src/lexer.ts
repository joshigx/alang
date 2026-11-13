// Lexer. Whitespace has no meaning except that line breaks separate entries
// and statements (rule 3.7). The lexer enforces the spelling of names (3.6),
// grouped numbers (4.7), the closed set of string escapes, and reports
// common forms from other languages (5.7).

import { AlangError, diagnostic, type Fix } from "./diagnostic.ts";

export type TokenKind =
  | "name" // snake_case
  | "typename" // PascalCase
  | "keyword"
  | "int"
  | "float"
  | "string"
  | "symbol"
  | "newline"
  | "eof";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly value?: number | string;
  readonly line: number;
  // The full source line, used as quoted location in diagnostics (rule 5.5).
  readonly lineText: string;
}

export const KEYWORDS = new Set([
  "fn",
  "type",
  "const",
  "extern",
  "end",
  "doc",
  "in",
  "out",
  "effects",
  "requires",
  "ensures",
  "examples",
  "body",
  "record",
  "variant",
  "where",
  "none",
  "let",
  "else",
  "return",
  "if",
  "then",
  "match",
  "case",
  "for",
  "do",
  "and",
  "or",
  "not",
  "true",
  "false",
]);

// Longest first, so that `<=` wins over `<`. There is deliberately no `>>`:
// `List<Result<Int, E>>` must close two type argument lists.
const SYMBOLS = ["=>", "==", "!=", "<=", ">=", "(", ")", "<", ">", ",", ":", ".", "=", "+", "-", "*", "/", "%"];

// Forms from other languages with a dedicated message (rule 5.7).
const FOREIGN: readonly { form: string; message: string; replacement?: string }[] = [
  { form: "===", message: "`===` does not exist; equality is `==` for every type.", replacement: "==" },
  { form: "!==", message: "`!==` does not exist; inequality is `!=`.", replacement: "!=" },
  { form: "&&", message: "`&&` does not exist; use `and`.", replacement: "and" },
  { form: "||", message: "`||` does not exist; use `or`.", replacement: "or" },
  { form: "//", message: "There are no comments; describe a definition in its `doc` section." },
  { form: "/*", message: "There are no comments; describe a definition in its `doc` section." },
  { form: "#", message: "There are no comments; describe a definition in its `doc` section." },
  {
    form: "{",
    message: "There are no curly braces; blocks end with `end if`, `end for`, `end match`, `end fn <name>`.",
  },
  {
    form: "}",
    message: "There are no curly braces; blocks end with `end if`, `end for`, `end match`, `end fn <name>`.",
  },
  { form: "[", message: "There is no index access or list literal; use `std.list.get(list: xs, index: i)`." },
  { form: "]", message: "There is no index access or list literal; use `std.list.get(list: xs, index: i)`." },
  {
    form: "?",
    message: "There is no `?` operator; propagate errors with `let name: Type = expression else return ...`.",
  },
  { form: ";", message: "There are no semicolons; line breaks separate statements." },
  { form: "'", message: "Strings use double quotes." },
  { form: "!", message: "`!` does not exist; use `not`.", replacement: "not " },
];

const FOREIGN_KEYWORDS: Record<string, string> = {
  var: "There is no `var`; every binding is `let name: Type = expression` and immutable.",
  null: "There is no `null`; a missing value is `None` of type `Option<T>`.",
  nil: "There is no `nil`; a missing value is `None` of type `Option<T>`.",
  while: "There are no loops except `for` over a list; repeat with recursion.",
  elif: "There is no `elif`; nest an `if` inside `else`.",
  switch: "There is no `switch`; distinguish variants with `match`.",
  function: "Functions are defined with `fn module.name` and its sections.",
  def: "Functions are defined with `fn module.name` and its sections.",
  import: "There are no imports; write names from other modules fully qualified.",
  self: "There are no methods; pass the value as a named parameter.",
  this: "There are no methods; pass the value as a named parameter.",
};

const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;

export function toSnakeCase(word: string): string {
  return word
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function toPascalCase(word: string): string {
  return word
    .split(/_+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

// Canonical spelling of the integer part of a number (rule 4.7).
export function groupDigits(digits: string): string {
  if (digits.length <= 4) return digits;
  const head = digits.length % 3 === 0 ? 3 : digits.length % 3;
  const groups = [digits.slice(0, head)];
  for (let i = head; i < digits.length; i += 3) groups.push(digits.slice(i, i + 3));
  return groups.join("_");
}

// Characters a string literal must spell as an escape. Everything else is
// written as itself, so every string has exactly one spelling.
export function escapeChar(ch: string): string | null {
  switch (ch) {
    case '"':
      return '\\"';
    case "\\":
      return "\\\\";
    case "\n":
      return "\\n";
    case "\t":
      return "\\t";
  }
  const cp = ch.codePointAt(0)!;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return `\\u{${cp.toString(16).toUpperCase()}}`;
  return null;
}

// Escapes of C and its descendants that alang spells as `\u{...}`, with the
// code point each stands for.
const C_ESCAPES: ReadonlyMap<string, number> = new Map([
  ["r", 0x0d],
  ["0", 0x00],
  ["a", 0x07],
  ["b", 0x08],
  ["f", 0x0c],
  ["v", 0x0b],
  ["e", 0x1b],
]);

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  const lines = source.split("\n");
  let i = 0;
  let line = 1;

  const lineText = () => (lines[line - 1] ?? "").trim();
  const fail = (code: string, message: string, at?: string, extra?: { expected?: string; fix?: Fix }) => {
    throw new AlangError(diagnostic({ code, message, at: at ?? lineText(), ...extra }));
  };
  const push = (kind: TokenKind, text: string, value?: number | string) => {
    tokens.push({ kind, text, value, line, lineText: lineText() });
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === "\n") {
      if (tokens.length > 0 && tokens[tokens.length - 1].kind !== "newline") push("newline", "\n");
      line++;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
      continue;
    }

    // Identifiers and keywords.
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
      const word = source.slice(i, j);
      if (KEYWORDS.has(word)) {
        push("keyword", word);
      } else if (word in FOREIGN_KEYWORDS && FOREIGN_KEYWORDS[word] !== "") {
        fail("E0006", FOREIGN_KEYWORDS[word], word);
      } else if (SNAKE.test(word)) {
        push("name", word);
      } else if (PASCAL.test(word)) {
        push("typename", word);
      } else {
        const isType = /^[A-Z]/.test(word);
        const fixed = isType ? toPascalCase(word) : toSnakeCase(word);
        fail(
          "E0002",
          isType
            ? `Type and variant names are written in PascalCase without underscores: \`${fixed}\`.`
            : `Values, functions and modules are written in snake_case: \`${fixed}\`.`,
          word,
          { expected: fixed, fix: { replace: word, with: fixed } },
        );
      }
      i = j;
      continue;
    }

    // Numbers.
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9_]/.test(source[j])) j++;
      const intText = source.slice(i, j);
      let fracText: string | null = null;
      if (source[j] === "." && /[0-9]/.test(source[j + 1] ?? "")) {
        let k = j + 1;
        while (k < source.length && /[0-9]/.test(source[k])) k++;
        fracText = source.slice(j + 1, k);
        j = k;
      }
      const digits = intText.replace(/_/g, "");
      const canonicalInt = groupDigits(digits.replace(/^0+(?=\d)/, ""));
      const written = source.slice(i, j);
      if (intText !== canonicalInt) {
        const fixed = fracText === null ? canonicalInt : `${canonicalInt}.${fracText}`;
        fail(
          "E0003",
          "Numbers with more than four digits group thousands with `_`; shorter numbers and leading zeros are not allowed.",
          written,
          { expected: fixed, fix: { replace: written, with: fixed } },
        );
      }
      if (fracText === null) {
        const value = Number(digits);
        if (!Number.isSafeInteger(value)) {
          fail("E0004", "Integer literal is outside the range of `Int` (2^53 - 1).", written);
        }
        push("int", written, value);
      } else {
        push("float", written, Number(`${digits}.${fracText}`));
      }
      i = j;
      continue;
    }

    // Strings.
    if (ch === '"') {
      let j = i + 1;
      let value = "";
      for (;;) {
        if (j >= source.length || source[j] === "\n") fail("E0005", "String literal is not closed on the same line.");
        const c = String.fromCodePoint(source.codePointAt(j)!);
        if (c === '"') {
          j++;
          break;
        }
        if (c === "\\") {
          const next = source[j + 1];
          if (next === '"' || next === "\\") {
            value += next;
            j += 2;
          } else if (next === "n") {
            value += "\n";
            j += 2;
          } else if (next === "t") {
            value += "\t";
            j += 2;
          } else if (next === "u" && source[j + 2] === "{") {
            const close = source.indexOf("}", j + 3);
            const hex = close < 0 ? "" : source.slice(j + 3, close);
            const written = source.slice(j, close + 1);
            if (!/^[0-9A-F]{1,6}$/.test(hex)) {
              fail("E0005", "A `\\u{...}` escape holds 1 to 6 uppercase hex digits.", written);
            }
            const cp = parseInt(hex, 16);
            if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
              fail("E0005", "`\\u{...}` must name a Unicode scalar value.", written);
            }
            const decoded = String.fromCodePoint(cp);
            const canonical = escapeChar(decoded);
            if (canonical !== written) {
              const fixed = canonical ?? decoded;
              fail(
                "E0005",
                "`\\u{...}` is only for control characters; every other character is written as itself.",
                written,
                { expected: fixed, fix: { replace: written, with: fixed } },
              );
            }
            value += decoded;
            j = close + 1;
          } else {
            const written = source.slice(j, j + 2);
            const message =
              'Unknown escape. The escapes are `\\"`, `\\\\`, `\\n`, `\\t` and `\\u{...}` for control characters.';
            // A C escape names a control character, so its fix is that
            // character's one spelling. `\0` before a digit is a C octal
            // escape (`\033`), which `\u{0}` would misread.
            const cp = C_ESCAPES.get(next);
            const octal = next === "0" && /[0-9]/.test(source[j + 2] ?? "");
            const fixed = cp === undefined || octal ? null : escapeChar(String.fromCodePoint(cp));
            if (fixed === null) {
              fail("E0005", message, written);
            } else {
              fail("E0005", `${message} \`${written}\` is written \`${fixed}\`.`, written, {
                expected: fixed,
                fix: { replace: written, with: fixed },
              });
            }
          }
          continue;
        }
        if (escapeChar(c) !== null) {
          fail("E0005", `Control character in string literal; write it as \`${escapeChar(c)}\`.`);
        }
        value += c;
        j += c.length;
      }
      push("string", source.slice(i, j), value);
      i = j;
      continue;
    }

    // Foreign forms before symbols, so that `===` is not read as `==` `=`.
    const foreign = FOREIGN.find((f) => source.startsWith(f.form, i));
    if (foreign && !(foreign.form === "!" && source[i + 1] === "=")) {
      fail(
        "E0006",
        foreign.message,
        lineText(),
        foreign.replacement
          ? { expected: foreign.replacement.trim(), fix: { replace: foreign.form, with: foreign.replacement.trim() } }
          : {},
      );
    }

    const symbol = SYMBOLS.find((s) => source.startsWith(s, i));
    if (symbol) {
      push("symbol", symbol);
      i += symbol.length;
      continue;
    }

    fail("E0001", `Unexpected character \`${ch}\`.`, ch);
  }

  if (tokens.length > 0 && tokens[tokens.length - 1].kind !== "newline") push("newline", "\n");
  push("eof", "");
  return tokens;
}
