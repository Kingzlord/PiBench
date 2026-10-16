import { BCM_TO_PHYSICAL, PIN_BY_PHYS } from "../data/pins";
import { evaluateCircuit, type DriveMap, type Part, type Wire } from "./circuit";

export type LogLevel = "stdout" | "system" | "warn" | "error" | "gpio";

export interface HardwareSnapshot {
  mode: "BOARD" | "BCM" | null;
  drive: DriveMap;
}

export interface TraceSnap {
  t: number;
  drive: DriveMap;
  note: string;
}

export interface ExecOptions {
  onLog: (level: LogLevel, message: string) => void;
  onHardware: (snap: HardwareSnapshot) => void;
  onSnapshot: (snap: TraceSnap) => void;
  onClock: (t: number) => void;
  onWait: (wait: { total: number; remaining: number } | null) => void;
  shouldStop: () => boolean;
  getWiring: () => { wires: Wire[]; parts: Part[] };
  timeScale?: number;
}

export class StopError extends Error {
  constructor() {
    super("Stopped");
    this.name = "StopError";
  }
}

export class PyError extends Error {
  pyName: string;
  line: number;
  trace: { fn: string; line: number }[];
  constructor(pyName: string, message: string, line = 1, trace: { fn: string; line: number }[] = []) {
    super(message);
    this.name = "PyError";
    this.pyName = pyName;
    this.line = line;
    this.trace = trace;
  }
}

export function formatPyError(e: PyError): string {
  const trace = e.trace.length ? e.trace : [{ fn: "<module>", line: e.line }];
  const body = trace.map((f) => `  File "main.py", line ${f.line}, in ${f.fn}`).join("\n");
  return `Traceback (most recent call last):\n${body}\n${e.pyName}: ${e.message}`;
}

interface Token {
  type: string;
  value: string;
  line: number;
  col: number;
}

const KEYWORDS = new Set([
  "import", "as", "from", "def", "return", "for", "in", "if", "elif", "else", "while",
  "break", "continue", "pass", "and", "or", "not", "True", "False", "None", "global",
  "lambda", "class", "try", "except", "finally", "with", "yield", "async", "await",
  "raise", "assert", "del", "is", "elif",
]);

function tokenize(source: string): Token[] {
  source = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!source.endsWith("\n")) source += "\n";
  const tokens: Token[] = [];
  const indentStack = [0];
  let i = 0;
  let line = 1;
  let col = 1;
  let paren = 0;

  const emit = (type: string, value: string, l = line, c = col) => {
    tokens.push({ type, value, line: l, col: c });
  };
  const syntax = (message: string, l = line): never => {
    throw new PyError("SyntaxError", message, l);
  };

  const startsIdent = (ch: string) => /[A-Za-z_]/.test(ch);
  const identChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);

  while (i < source.length) {
    if (col === 1 && paren === 0) {
      let j = i;
      while (source[j] === " " || source[j] === "\t") j++;
      if (source[j] === "#" || source[j] === "\n" || source[j] === undefined) {
        while (i < source.length && source[i] !== "\n") i++;
        if (source[i] === "\n") {
          i++;
          line++;
          col = 1;
        }
        continue;
      }
      let indent = 0;
      const startLine = line;
      while (source[i] === " " || source[i] === "\t") {
        indent += source[i] === "\t" ? 4 : 1;
        i++;
        col++;
      }
      const top = indentStack[indentStack.length - 1];
      if (indent > top) {
        indentStack.push(indent);
        emit("INDENT", "", startLine, 1);
      } else if (indent < top) {
        while (indentStack[indentStack.length - 1] > indent) {
          indentStack.pop();
          emit("DEDENT", "", startLine, 1);
        }
        if (indentStack[indentStack.length - 1] !== indent) {
          syntax("unindent does not match any outer indentation level", startLine);
        }
      }
    }

    const ch = source[i];
    if (ch === undefined) break;
    if (ch === " " || ch === "\t") {
      i++;
      col++;
      continue;
    }
    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "\\") {
      if (source[i + 1] === "\n") {
        i += 2;
        line++;
        col = 1;
        continue;
      }
    }
    if (ch === "\n") {
      if (paren === 0) emit("NEWLINE", "\n");
      i++;
      line++;
      col = 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ((ch === "f" || ch === "F" || ch === "r" || ch === "R" || ch === "b" || ch === "B") && (source[i + 1] === '"' || source[i + 1] === "'"))) {
      let prefix = "";
      let q = ch;
      if (ch !== '"' && ch !== "'") {
        prefix = ch.toLowerCase();
        q = source[i + 1];
        i++;
        col++;
      }
      const triple = source.slice(i, i + 3) === q.repeat(3);
      const startLine = line;
      const startCol = col;
      i += triple ? 3 : 1;
      col += triple ? 3 : 1;
      let out = "";
      const end = triple ? q.repeat(3) : q;
      while (i < source.length && !source.startsWith(end, i)) {
        if (!triple && source[i] === "\n") syntax("unterminated string literal", startLine);
        if (source[i] === "\\" && prefix !== "r") {
          const n = source[i + 1] ?? "";
          const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
          if (n === "\n") {
            i += 2;
            line++;
            col = 1;
            continue;
          }
          out += map[n] ?? n;
          i += 2;
          col += 2;
          continue;
        }
        if (source[i] === "\n") {
          out += "\n";
          i++;
          line++;
          col = 1;
          continue;
        }
        out += source[i];
        i++;
        col++;
      }
      if (!source.startsWith(end, i)) syntax("unterminated string literal", startLine);
      i += end.length;
      col += end.length;
      emit(prefix === "f" ? "FSTRING" : "STRING", out, startLine, startCol);
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const startLine = line;
      const startCol = col;
      let num = "";
      if (source.startsWith("0x", i) || source.startsWith("0X", i)) {
        num = "0x";
        i += 2;
        col += 2;
        while (/[0-9a-fA-F_]/.test(source[i] ?? "")) {
          if (source[i] !== "_") num += source[i];
          i++;
          col++;
        }
        emit("NUMBER", String(parseInt(num, 16)), startLine, startCol);
        continue;
      }
      while (/[0-9_]/.test(source[i] ?? "")) {
        if (source[i] !== "_") num += source[i];
        i++;
        col++;
      }
      if (source[i] === "." && /[0-9]/.test(source[i + 1] ?? "")) {
        num += ".";
        i++;
        col++;
        while (/[0-9_]/.test(source[i] ?? "")) {
          if (source[i] !== "_") num += source[i];
          i++;
          col++;
        }
      }
      if (source[i] === "e" || source[i] === "E") {
        num += source[i];
        i++;
        col++;
        if (source[i] === "+" || source[i] === "-") {
          num += source[i];
          i++;
          col++;
        }
        while (/[0-9]/.test(source[i] ?? "")) {
          num += source[i];
          i++;
          col++;
        }
      }
      emit("NUMBER", num, startLine, startCol);
      continue;
    }

    if (startsIdent(ch)) {
      const startLine = line;
      const startCol = col;
      let word = "";
      while (identChar(source[i] ?? "")) {
        word += source[i];
        i++;
        col++;
      }
      if (KEYWORDS.has(word)) emit(word, word, startLine, startCol);
      else emit("IDENT", word, startLine, startCol);
      continue;
    }

    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    const ops3 = ["**=", "//="];
    const ops2 = ["**", "//", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%="];
    if (ops3.includes(three)) {
      emit(three, three);
      i += 3;
      col += 3;
      continue;
    }
    if (ops2.includes(two)) {
      emit(two, two);
      i += 2;
      col += 2;
      continue;
    }
    if ("()[]".includes(ch)) {
      if (ch === "(" || ch === "[") paren++;
      if (ch === ")" || ch === "]") paren = Math.max(0, paren - 1);
      emit(ch, ch);
      i++;
      col++;
      continue;
    }
    if ("+-*/%<>,.:=".includes(ch)) {
      emit(ch, ch);
      i++;
      col++;
      continue;
    }
    syntax(`invalid character ${JSON.stringify(ch)}`);
  }

  while (indentStack.length > 1) {
    indentStack.pop();
    emit("DEDENT", "", line, 1);
  }
  emit("EOF", "", line, col);
  return tokens;
}

type Expr =
  | { type: "Num"; value: number; line: number }
  | { type: "Str"; value: string; line: number }
  | { type: "FStr"; value: string; line: number }
  | { type: "Name"; name: string; line: number }
  | { type: "Bool"; value: boolean; line: number }
  | { type: "None"; line: number }
  | { type: "List"; items: Expr[]; line: number }
  | { type: "Unary"; op: string; expr: Expr; line: number }
  | { type: "Bin"; op: string; left: Expr; right: Expr; line: number }
  | { type: "BoolOp"; op: "and" | "or"; left: Expr; right: Expr; line: number }
  | { type: "Compare"; left: Expr; ops: { op: string; right: Expr }[]; line: number }
  | { type: "Attr"; obj: Expr; name: string; line: number }
  | { type: "Call"; func: Expr; args: Expr[]; kwargs: { name: string; value: Expr }[]; line: number }
  | { type: "Index"; obj: Expr; index: Expr; line: number };

type Stmt =
  | { type: "Import"; names: { module: string; as: string | null }[]; line: number }
  | { type: "From"; module: string; names: { name: string; as: string }[]; line: number }
  | { type: "Function"; name: string; params: string[]; defaults: Expr[]; body: Stmt[]; line: number }
  | { type: "Return"; value: Expr | null; line: number }
  | { type: "For"; targets: string[]; iter: Expr; body: Stmt[]; line: number }
  | { type: "While"; test: Expr; body: Stmt[]; line: number }
  | { type: "If"; test: Expr; body: Stmt[]; elifs: { test: Expr; body: Stmt[] }[]; elseBody: Stmt[] | null; line: number }
  | { type: "Assign"; names: string[]; value: Expr; line: number }
  | { type: "AugAssign"; name: string; op: string; value: Expr; line: number }
  | { type: "Expr"; expr: Expr; line: number }
  | { type: "Pass"; line: number }
  | { type: "Break"; line: number }
  | { type: "Continue"; line: number }
  | { type: "Global"; names: string[]; line: number };

class Parser {
  i = 0;
  constructor(private tokens: Token[]) {}
  get cur() {
    return this.tokens[this.i];
  }
  peek(n = 0) {
    return this.tokens[this.i + n];
  }
  eat(type: string) {
    if (this.cur.type === type) {
      this.i++;
      return true;
    }
    return false;
  }
  expect(type: string) {
    const t = this.cur;
    if (!this.eat(type)) {
      throw new PyError("SyntaxError", `expected ${type}, got ${t.type}${t.value ? ` (${t.value})` : ""}`, t.line);
    }
    return this.tokens[this.i - 1];
  }
  skipNl() {
    while (this.cur.type === "NEWLINE") this.i++;
  }
  parseModule(): Stmt[] {
    this.skipNl();
    const stmts: Stmt[] = [];
    while (this.cur.type !== "EOF") {
      stmts.push(...this.parseStmt());
      this.skipNl();
    }
    return stmts;
  }
  parseBlock(): Stmt[] {
    const stmts: Stmt[] = [];
    while (this.cur.type !== "DEDENT" && this.cur.type !== "EOF") {
      if (this.cur.type === "NEWLINE") {
        this.i++;
        continue;
      }
      stmts.push(...this.parseStmt());
    }
    return stmts;
  }
  parseSuite(): Stmt[] {
    this.expect(":");
    if (this.eat("NEWLINE")) {
      this.expect("INDENT");
      const body = this.parseBlock();
      this.expect("DEDENT");
      return body;
    }
    return this.parseSimpleList();
  }
  parseSimpleList(): Stmt[] {
    const stmts = [this.parseSmall()];
    while (this.eat(";")) {
      if (["NEWLINE", "EOF", "DEDENT"].includes(this.cur.type)) break;
      stmts.push(this.parseSmall());
    }
    this.eat("NEWLINE");
    return stmts;
  }
  parseStmt(): Stmt[] {
    const t = this.cur;
    if (t.type === "import") return [this.parseImport()];
    if (t.type === "from") return [this.parseFrom()];
    if (t.type === "def") return [this.parseDef()];
    if (t.type === "for") return [this.parseFor()];
    if (t.type === "while") return [this.parseWhile()];
    if (t.type === "if") return [this.parseIf()];
    if (t.type === "return") {
      const line = t.line;
      this.i++;
      let value: Expr | null = null;
      if (!["NEWLINE", ";", "DEDENT", "EOF"].includes(this.cur.type)) value = this.parseExpr();
      this.endSimple();
      return [{ type: "Return", value, line }];
    }
    if (t.type === "break" || t.type === "continue" || t.type === "pass") {
      this.i++;
      this.endSimple();
      return [{ type: t.type === "break" ? "Break" : t.type === "continue" ? "Continue" : "Pass", line: t.line }];
    }
    if (t.type === "global") {
      const line = t.line;
      this.i++;
      const names = [this.expect("IDENT").value];
      while (this.eat(",")) names.push(this.expect("IDENT").value);
      this.endSimple();
      return [{ type: "Global", names, line }];
    }
    if (["class", "try", "with", "raise", "assert", "del", "async", "yield", "lambda"].includes(t.type)) {
      throw new PyError("SyntaxError", `${t.type} is not supported in this simulator`, t.line);
    }
    return this.parseSimpleList();
  }
  endSimple() {
    if (this.cur.type === ";") return;
    if (this.cur.type === "NEWLINE") this.i++;
    else if (!["DEDENT", "EOF"].includes(this.cur.type)) {
      throw new PyError("SyntaxError", `unexpected token ${this.cur.type}`, this.cur.line);
    }
  }
  parseDotted(): string {
    let name = this.expect("IDENT").value;
    while (this.eat(".")) name += "." + this.expect("IDENT").value;
    return name;
  }
  parseImport(): Stmt {
    const line = this.cur.line;
    this.expect("import");
    const names: { module: string; as: string | null }[] = [];
    do {
      const module = this.parseDotted();
      const asName = this.eat("as") ? this.expect("IDENT").value : null;
      names.push({ module, as: asName });
    } while (this.eat(","));
    this.endSimple();
    return { type: "Import", names, line };
  }
  parseFrom(): Stmt {
    const line = this.cur.line;
    this.expect("from");
    const module = this.parseDotted();
    this.expect("import");
    if (this.cur.type === "*") {
      throw new PyError("SyntaxError", "import * is not supported", this.cur.line);
    }
    const paren = this.eat("(");
    const names: { name: string; as: string }[] = [];
    do {
      if (paren && this.cur.type === ")") break;
      const name = this.expect("IDENT").value;
      let as = name;
      if (this.eat("as")) as = this.expect("IDENT").value;
      names.push({ name, as });
    } while (this.eat(","));
    if (paren) this.expect(")");
    this.endSimple();
    return { type: "From", module, names, line };
  }
  parseDef(): Stmt {
    const line = this.cur.line;
    this.expect("def");
    const name = this.expect("IDENT").value;
    this.expect("(");
    const params: string[] = [];
    const defaults: Expr[] = [];
    if (!this.eat(")")) {
      do {
        params.push(this.expect("IDENT").value);
        if (this.eat("=")) defaults.push(this.parseExpr());
        else if (defaults.length) {
          throw new PyError("SyntaxError", "non-default argument follows default argument", line);
        }
      } while (this.eat(","));
      this.expect(")");
    }
    const body = this.parseSuite();
    return { type: "Function", name, params, defaults, body, line };
  }
  parseFor(): Stmt {
    const line = this.cur.line;
    this.expect("for");
    const targets = [this.expect("IDENT").value];
    while (this.eat(",")) {
      if (this.cur.type === "in") break;
      targets.push(this.expect("IDENT").value);
    }
    this.expect("in");
    const iter = this.parseExpr();
    const body = this.parseSuite();
    return { type: "For", targets, iter, body, line };
  }
  parseWhile(): Stmt {
    const line = this.cur.line;
    this.expect("while");
    const test = this.parseExpr();
    const body = this.parseSuite();
    return { type: "While", test, body, line };
  }
  parseIf(): Stmt {
    const line = this.cur.line;
    this.expect("if");
    const test = this.parseExpr();
    const body = this.parseSuite();
    const elifs: { test: Expr; body: Stmt[] }[] = [];
    while (this.cur.type === "elif") {
      this.i++;
      const et = this.parseExpr();
      const eb = this.parseSuite();
      elifs.push({ test: et, body: eb });
    }
    let elseBody: Stmt[] | null = null;
    if (this.eat("else")) elseBody = this.parseSuite();
    return { type: "If", test, body, elifs, elseBody, line };
  }
  parseSmall(): Stmt {
    const t = this.cur;
    const aug = ["+=", "-=", "*=", "/=", "//=", "%=", "**="];
    if (t.type === "IDENT" && (this.peek(1).type === "=" || this.peek(1).type === "," || aug.includes(this.peek(1).type))) {
      const names = [t.value];
      this.i++;
      while (this.eat(",")) {
        if (["=", "NEWLINE", "EOF"].includes(this.cur.type) || aug.includes(this.cur.type)) break;
        names.push(this.expect("IDENT").value);
      }
      if (aug.includes(this.cur.type)) {
        if (names.length !== 1) throw new PyError("SyntaxError", "augmented assignment needs a single name", t.line);
        const op = this.cur.type;
        this.i++;
        const value = this.parseExpr();
        return { type: "AugAssign", name: names[0], op, value, line: t.line };
      }
      this.expect("=");
      const value = this.parseExpr();
      return { type: "Assign", names, value, line: t.line };
    }
    const expr = this.parseExpr();
    if (this.cur.type === "=") {
      throw new PyError("SyntaxError", "only simple names can be assigned in this simulator", this.cur.line);
    }
    return { type: "Expr", expr, line: expr.line };
  }
  parseExpr(): Expr {
    return this.parseOr();
  }
  parseOr(): Expr {
    let left = this.parseAnd();
    while (this.eat("or")) {
      const right = this.parseAnd();
      left = { type: "BoolOp", op: "or", left, right, line: left.line };
    }
    return left;
  }
  parseAnd(): Expr {
    let left = this.parseNot();
    while (this.eat("and")) {
      const right = this.parseNot();
      left = { type: "BoolOp", op: "and", left, right, line: left.line };
    }
    return left;
  }
  parseNot(): Expr {
    if (this.eat("not")) {
      const expr = this.parseNot();
      return { type: "Unary", op: "not", expr, line: expr.line };
    }
    return this.parseCompare();
  }
  parseCompare(): Expr {
    let left = this.parseAdd();
    const ops: { op: string; right: Expr }[] = [];
    for (;;) {
      let op = "";
      if (["==", "!=", "<", ">", "<=", ">="].includes(this.cur.type)) op = this.cur.type;
      else if (this.cur.type === "in") op = "in";
      else if (this.cur.type === "not" && this.peek(1).type === "in") op = "not in";
      else if (this.cur.type === "is" && this.peek(1).type === "not") op = "is not";
      else if (this.cur.type === "is") op = "is";
      else break;
      this.i += op === "not in" || op === "is not" ? 2 : 1;
      ops.push({ op, right: this.parseAdd() });
    }
    if (!ops.length) return left;
    return { type: "Compare", left, ops, line: left.line };
  }
  parseAdd(): Expr {
    let left = this.parseMul();
    while (this.cur.type === "+" || this.cur.type === "-") {
      const op = this.cur.type;
      this.i++;
      const right = this.parseMul();
      left = { type: "Bin", op, left, right, line: left.line };
    }
    return left;
  }
  parseMul(): Expr {
    let left = this.parseUnary();
    while (["*", "/", "//", "%"].includes(this.cur.type)) {
      const op = this.cur.type;
      this.i++;
      const right = this.parseUnary();
      left = { type: "Bin", op, left, right, line: left.line };
    }
    return left;
  }
  parseUnary(): Expr {
    if (this.cur.type === "+" || this.cur.type === "-") {
      const op = this.cur.type;
      const line = this.cur.line;
      this.i++;
      return { type: "Unary", op, expr: this.parseUnary(), line };
    }
    return this.parsePower();
  }
  parsePower(): Expr {
    const left = this.parsePrimary();
    if (this.eat("**")) {
      const right = this.parseUnary();
      return { type: "Bin", op: "**", left, right, line: left.line };
    }
    return left;
  }
  parsePrimary(): Expr {
    let expr = this.parseAtom();
    for (;;) {
      if (this.eat("(")) {
        const args: Expr[] = [];
        const kwargs: { name: string; value: Expr }[] = [];
        if (!this.eat(")")) {
          do {
            if (this.cur.type === "IDENT" && this.peek(1).type === "=") {
              const name = this.cur.value;
              this.i += 2;
              kwargs.push({ name, value: this.parseExpr() });
            } else if (this.cur.type === "*" || this.cur.type === "**") {
              throw new PyError("SyntaxError", "starred arguments are not supported", this.cur.line);
            } else {
              args.push(this.parseExpr());
            }
          } while (this.eat(","));
          this.expect(")");
        }
        expr = { type: "Call", func: expr, args, kwargs, line: expr.line };
        continue;
      }
      if (this.eat("[")) {
        const index = this.parseExpr();
        if (this.cur.type === ":") throw new PyError("SyntaxError", "slicing is not supported", this.cur.line);
        this.expect("]");
        expr = { type: "Index", obj: expr, index, line: expr.line };
        continue;
      }
      if (this.eat(".")) {
        const name = this.expect("IDENT").value;
        expr = { type: "Attr", obj: expr, name, line: expr.line };
        continue;
      }
      break;
    }
    return expr;
  }
  parseAtom(): Expr {
    const t = this.cur;
    if (t.type === "NUMBER") {
      this.i++;
      return { type: "Num", value: Number(t.value), line: t.line };
    }
    if (t.type === "STRING") {
      this.i++;
      return { type: "Str", value: t.value, line: t.line };
    }
    if (t.type === "FSTRING") {
      this.i++;
      return { type: "FStr", value: t.value, line: t.line };
    }
    if (t.type === "True" || t.type === "False") {
      this.i++;
      return { type: "Bool", value: t.type === "True", line: t.line };
    }
    if (t.type === "None") {
      this.i++;
      return { type: "None", line: t.line };
    }
    if (t.type === "IDENT") {
      this.i++;
      return { type: "Name", name: t.value, line: t.line };
    }
    if (t.type === "[") {
      this.i++;
      const items: Expr[] = [];
      if (!this.eat("]")) {
        do {
          if (this.cur.type === "]") break;
          items.push(this.parseExpr());
        } while (this.eat(","));
        this.expect("]");
      }
      return { type: "List", items, line: t.line };
    }
    if (t.type === "(") {
      this.i++;
      if (this.eat(")")) return { type: "List", items: [], line: t.line };
      const first = this.parseExpr();
      if (this.eat(",")) {
        const items = [first];
        if (this.cur.type !== ")") {
          do {
            if (this.cur.type === ")") break;
            items.push(this.parseExpr());
          } while (this.eat(","));
        }
        this.expect(")");
        return { type: "List", items, line: t.line };
      }
      this.expect(")");
      return first;
    }
    if (t.type === "lambda") throw new PyError("SyntaxError", "lambda is not supported", t.line);
    throw new PyError("SyntaxError", `unexpected token ${t.type}${t.value ? ` (${t.value})` : ""}`, t.line);
  }
}

type Signal = { type: "return"; value: unknown } | { type: "break" } | { type: "continue" } | null;

interface Env {
  vars: Map<string, unknown>;
  parent: Env | null;
}

interface PyFunc {
  __pyfunc: true;
  __name: string;
  call: (args: unknown[], kwargs: Record<string, unknown>, line: number) => unknown;
}

function isPyFunc(v: unknown): v is PyFunc {
  return !!v && typeof v === "object" && (v as PyFunc).__pyfunc === true;
}

const BOARD = 10;
const BCM = 11;
const OUT = 0;
const IN = 1;
const HIGH = 1;
const LOW = 0;
const PUD_OFF = 20;
const PUD_DOWN = 21;
const PUD_UP = 22;

export async function executePython(source: string, options: ExecOptions): Promise<void> {
  const timeScale = options.timeScale ?? 1;
  const frames: { fn: string; line: number }[] = [{ fn: "<module>", line: 1 }];
  let steps = 0;
  let simTime = 0;
  const fail = (pyName: string, message: string, line?: number): never => {
    const ln = line ?? frames[frames.length - 1]?.line ?? 1;
    throw new PyError(pyName, message, ln, frames.map((f) => ({ ...f })));
  };
  const stop = () => {
    if (options.shouldStop()) throw new StopError();
  };
  let mode: "BOARD" | "BCM" | null = null;
  let warnings = true;
  let alive = true;
  const channels = new Map<number, { dir: "IN" | "OUT"; value: number; pull: number }>();
  interface PwmRec {
    bcm: number;
    physical: number;
    freq: number;
    duty: number;
    running: boolean;
    startedAt: number;
  }
  const pwms = new Map<number, PwmRec>();
  let pwmTimer: ReturnType<typeof setInterval> | null = null;

  const pwmVisual = (pwm: PwmRec, now = performance.now()) => {
    if (!pwm.running) return { high: false, duty: 0 };
    if (pwm.freq >= 20 || pwm.duty <= 0 || pwm.duty >= 100) {
      return { high: pwm.duty > 0, duty: pwm.duty };
    }
    const period = 1000 / pwm.freq;
    const phase = (now - pwm.startedAt) % period;
    const on = phase < (period * pwm.duty) / 100;
    return { high: on, duty: on ? 100 : 0 };
  };

  const driveOf = (): DriveMap => {
    const drive: DriveMap = {};
    const now = performance.now();
    for (const [bcm, ch] of channels) {
      const physical = BCM_TO_PHYSICAL[bcm];
      if (!physical) continue;
      const pwm = pwms.get(bcm);
      if (ch.dir === "OUT" && pwm?.running) {
        const vis = pwmVisual(pwm, now);
        drive[physical] = { dir: "OUT", high: vis.high, duty: vis.duty };
      } else {
        drive[physical] = { dir: ch.dir, high: ch.dir === "OUT" && ch.value === 1 };
      }
    }
    return drive;
  };

  const syncTicker = () => {
    const slow = [...pwms.values()].some((p) => p.running && p.freq < 20 && p.duty > 0 && p.duty < 100);
    if (slow && !pwmTimer) {
      pwmTimer = setInterval(() => {
        if (!alive || options.shouldStop()) return;
        options.onHardware({ mode, drive: driveOf() });
      }, 32);
    } else if (!slow && pwmTimer) {
      clearInterval(pwmTimer);
      pwmTimer = null;
    }
  };

  const stopPwm = (bcm: number) => {
    const pwm = pwms.get(bcm);
    if (!pwm) return;
    pwm.running = false;
    pwm.duty = 0;
    const ch = channels.get(bcm);
    if (ch && ch.dir === "OUT") ch.value = 0;
    syncTicker();
  };
  const publish = async (note: string, paint: boolean) => {
    const drive = driveOf();
    options.onHardware({ mode, drive });
    options.onSnapshot({ t: simTime, drive, note });
    options.onClock(simTime);
    if (paint && timeScale <= 1 && typeof requestAnimationFrame === "function") {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
  };

  const asIntChannel = (v: unknown, line: number): number => {
    if (typeof v === "boolean") fail("ValueError", "channel must be an integer pin number", line);
    if (typeof v === "number" && Number.isInteger(v)) return v;
    fail("ValueError", `channel must be an integer, not ${pyTypeName(v)}`, line);
  };

  const resolve = (channel: unknown, line: number): { bcm: number; physical: number } => {
    if (mode === null) {
      fail(
        "RuntimeError",
        "Please set pin numbering mode using GPIO.setmode(GPIO.BOARD) or GPIO.setmode(GPIO.BCM)",
        line,
      );
    }
    const n = asIntChannel(channel, line);
    if (mode === "BOARD") {
      if (n < 1 || n > 40 || !PIN_BY_PHYS[n] || PIN_BY_PHYS[n].bcm === null) {
        fail("ValueError", "The channel sent is invalid on a Raspberry Pi", line);
      }
      return { bcm: PIN_BY_PHYS[n].bcm!, physical: n };
    }
    if (!(n in BCM_TO_PHYSICAL)) fail("ValueError", "The channel sent is invalid on a Raspberry Pi", line);
    return { bcm: n, physical: BCM_TO_PHYSICAL[n] };
  };

  const eachChannel = (channel: unknown, line: number) => {
    const list = Array.isArray(channel) ? channel : [channel];
    if (!list.length) fail("ValueError", "The channel sent is invalid on a Raspberry Pi", line);
    return list.map((c) => resolve(c, line));
  };

  const asLevel = (v: unknown, line: number): number => {
    if (v === true || v === HIGH || v === "HIGH" || v === "high") return 1;
    if (v === false || v === LOW || v === "LOW" || v === "low") return 0;
    if (typeof v === "number") return v !== 0 ? 1 : 0;
    fail("ValueError", "output value must be GPIO.HIGH, GPIO.LOW, True, or False", line);
  };

  const isOut = (v: unknown) => v === OUT || v === "OUT" || v === "out";
  const isIn = (v: unknown) => v === IN || v === "IN" || v === "in";

  const gpio: Record<string, unknown> = {
    __pytype: "module",
    __name: "RPi.GPIO",
    BOARD,
    BCM,
    OUT,
    IN,
    HIGH,
    LOW,
    PUD_OFF,
    PUD_DOWN,
    PUD_UP,
    VERSION: "0.7.1-pibench",
    RPI_REVISION: 3,
  };

  const pyf = (name: string, fn: PyFunc["call"]): PyFunc => ({ __pyfunc: true, __name: name, call: fn });

  gpio.setmode = pyf("setmode", (args, _k, line) => {
    const m = args[0];
    const next = m === BOARD || m === "BOARD" ? "BOARD" : m === BCM || m === "BCM" ? "BCM" : null;
    if (!next) fail("ValueError", "An invalid mode was passed to setmode()", line);
    if (mode && mode !== next) fail("RuntimeError", "A different mode has already been set!", line);
    mode = next;
    options.onLog("gpio", `GPIO.setmode(GPIO.${next})`);
    options.onHardware({ mode, drive: driveOf() });
    return null;
  });
  gpio.getmode = pyf("getmode", () => (mode === "BOARD" ? BOARD : mode === "BCM" ? BCM : null));
  gpio.setwarnings = pyf("setwarnings", (args) => {
    warnings = truthy(args[0]);
    options.onLog("gpio", `GPIO.setwarnings(${warnings ? "True" : "False"})`);
    return null;
  });
  gpio.setup = pyf("setup", async (args, kwargs, line) => {
    const direction = args[1] ?? kwargs.direction;
    const pull = (args[2] ?? kwargs.pull_up_down ?? PUD_OFF) as number;
    const initial = args.length > 3 ? args[3] : kwargs.initial;
    if (!isOut(direction) && !isIn(direction)) {
      fail("ValueError", "direction must be GPIO.OUT or GPIO.IN", line);
    }
    const dir: "IN" | "OUT" = isOut(direction) ? "OUT" : "IN";
    const chans = eachChannel(args[0] ?? kwargs.channel, line);
    for (const ch of chans) {
      if (channels.has(ch.bcm) && warnings) {
        options.onLog(
          "warn",
          `RuntimeWarning: This channel is already in use, continuing anyway. Use GPIO.setwarnings(False) to disable warnings. (physical pin ${ch.physical})`,
        );
      }
      if ((ch.physical === 27 || ch.physical === 28) && warnings) {
        options.onLog("warn", `Physical pin ${ch.physical} is reserved for the HAT ID EEPROM (${PIN_BY_PHYS[ch.physical].name}).`);
      }
      const value = dir === "OUT" ? (initial === undefined ? 0 : asLevel(initial, line)) : 0;
      channels.set(ch.bcm, { dir, value, pull: typeof pull === "number" ? pull : PUD_OFF });
      options.onLog(
        "gpio",
        `GPIO.setup(${args[0] instanceof Object ? ch.physical : args[0]}, ${dir}) → BCM ${ch.bcm} · physical pin ${ch.physical}`,
      );
    }
    await publish(
      `setup ${chans.map((c) => `pin ${c.physical} ${dir}`).join(", ")}`,
      false,
    );
    return null;
  });
  gpio.output = pyf("output", async (args, kwargs, line) => {
    const channelsArg = args[0] ?? kwargs.channel;
    const valueArg = args.length > 1 ? args[1] : kwargs.value;
    const chans = eachChannel(channelsArg, line);
    const values = Array.isArray(valueArg) ? valueArg : chans.map(() => valueArg);
    if (Array.isArray(valueArg) && values.length !== chans.length) {
      fail("ValueError", "number of values does not match number of channels", line);
    }
    for (let i = 0; i < chans.length; i++) {
      const ch = chans[i];
      const state = channels.get(ch.bcm);
      if (!state || state.dir !== "OUT") {
        fail("RuntimeError", "The GPIO channel has not been set up as an OUTPUT", line);
      }
      state.value = asLevel(values[i], line);
      options.onLog(
        "gpio",
        `GPIO.output(${Array.isArray(channelsArg) ? ch.physical : channelsArg}, ${state.value ? "HIGH" : "LOW"}) → physical pin ${ch.physical} · BCM ${ch.bcm}`,
      );
    }
    const note = chans
      .map((c, i) => `physical pin ${c.physical} ${asLevel(values[i], line) ? "HIGH" : "LOW"}`)
      .join(", ");
    await publish(note, true);
    return null;
  });
  gpio.input = pyf("input", (args, kwargs, line) => {
    const ch = resolve(args[0] ?? kwargs.channel, line);
    const state = channels.get(ch.bcm);
    if (!state) fail("RuntimeError", "You must setup() the GPIO channel first", line);
    if (state.dir === "OUT") {
      const pwm = pwms.get(ch.bcm);
      if (pwm?.running) return pwm.duty >= 50 ? 1 : 0;
      return state.value;
    }
    const wiring = options.getWiring();
    const analysis = evaluateCircuit(wiring.wires, wiring.parts, driveOf(), mode);
    const v = analysis.pinVoltage[ch.physical];
    if (v === 0 || v === 1) return v;
    if (state.pull === PUD_UP) return 1;
    if (state.pull === PUD_DOWN) return 0;
    return 0;
  });
  gpio.cleanup = pyf("cleanup", async (args, _k, line) => {
    if (args.length === 0) {
      for (const bcm of [...pwms.keys()]) stopPwm(bcm);
      pwms.clear();
      channels.clear();
      syncTicker();
      options.onLog("gpio", "GPIO.cleanup() → all pins released");
      await publish("GPIO.cleanup() released all pins", true);
      return null;
    }
    const chans = eachChannel(args[0], line);
    for (const ch of chans) {
      stopPwm(ch.bcm);
      pwms.delete(ch.bcm);
      channels.delete(ch.bcm);
    }
    syncTicker();
    options.onLog("gpio", `GPIO.cleanup(${args[0]}) → released physical ${chans.map((c) => c.physical).join(", ")}`);
    await publish(`cleanup pin ${chans.map((c) => c.physical).join(", ")}`, true);
    return null;
  });
  const unsupported = (name: string) =>
    pyf(name, (_a, _k, line) => {
      fail(
        "RuntimeError",
        `GPIO.${name}() is not available in this browser simulator. Use GPIO.output() and time.sleep() to blink or time pins.`,
        line,
      );
    });
  const asDuty = (v: unknown, line: number) => {
    if (typeof v === "boolean") return v ? 100 : 0;
    if (typeof v !== "number" || Number.isNaN(v)) fail("ValueError", "duty cycle must be a number from 0 to 100", line);
    if (v < 0 || v > 100) fail("ValueError", "duty cycle must be between 0 and 100", line);
    return v;
  };
  const asFreq = (v: unknown, line: number) => {
    if (typeof v !== "number" || Number.isNaN(v) || v <= 0) {
      fail("ValueError", "frequency must be a number greater than 0", line);
    }
    return v;
  };
  gpio.PWM = pyf("PWM", (args, kwargs, line) => {
    const ch = resolve(args[0] ?? kwargs.channel, line);
    const freq = asFreq(args.length > 1 ? args[1] : kwargs.frequency, line);
    const existing = channels.get(ch.bcm);
    if (!existing || existing.dir !== "OUT") {
      fail("RuntimeError", "You must setup() the GPIO channel as an output before creating PWM", line);
    }
    if (pwms.has(ch.bcm)) {
      options.onLog("warn", `Replacing the PWM already running on physical pin ${ch.physical}.`);
      stopPwm(ch.bcm);
    }
    const rec: PwmRec = {
      bcm: ch.bcm,
      physical: ch.physical,
      freq,
      duty: 0,
      running: false,
      startedAt: performance.now(),
    };
    pwms.set(ch.bcm, rec);
    const requireOut = (ln: number) => {
      const state = channels.get(rec.bcm);
      if (!state || state.dir !== "OUT") fail("RuntimeError", "The GPIO channel has not been set up as an OUTPUT", ln);
      return state;
    };
    const api: Record<string, unknown> = { __pytype: "PWM", __name: "PWM" };
    api.start = pyf("start", async (a, k, ln) => {
      requireOut(ln);
      rec.duty = asDuty(a.length ? a[0] : k.dc ?? k.duty_cycle ?? k.dutyCycle, ln);
      rec.running = true;
      rec.startedAt = performance.now();
      const state = channels.get(rec.bcm);
      if (state) state.value = rec.duty > 0 ? 1 : 0;
      syncTicker();
      options.onLog("gpio", `PWM.start(${rec.duty}%) @ ${rec.freq} Hz → physical pin ${rec.physical} · BCM ${rec.bcm}`);
      await publish(`PWM ${rec.duty}% @ ${rec.freq} Hz on physical pin ${rec.physical}`, true);
      return null;
    });
    api.ChangeDutyCycle = pyf("ChangeDutyCycle", async (a, k, ln) => {
      requireOut(ln);
      rec.duty = asDuty(a.length ? a[0] : k.dutycycle ?? k.duty_cycle, ln);
      if (rec.running) {
        const state = channels.get(rec.bcm);
        if (state) state.value = rec.duty > 0 ? 1 : 0;
        syncTicker();
        options.onLog("gpio", `PWM.ChangeDutyCycle(${rec.duty}%) → physical pin ${rec.physical} · BCM ${rec.bcm}`);
        await publish(`PWM duty ${rec.duty}% on physical pin ${rec.physical}`, true);
      }
      return null;
    });
    api.ChangeFrequency = pyf("ChangeFrequency", async (a, k, ln) => {
      requireOut(ln);
      rec.freq = asFreq(a.length ? a[0] : k.frequency, ln);
      rec.startedAt = performance.now();
      if (rec.running) {
        syncTicker();
        options.onLog("gpio", `PWM.ChangeFrequency(${rec.freq} Hz) → physical pin ${rec.physical}`);
        await publish(`PWM ${rec.freq} Hz on physical pin ${rec.physical}`, true);
      }
      return null;
    });
    api.stop = pyf("stop", async (_a, _k, ln) => {
      requireOut(ln);
      stopPwm(rec.bcm);
      options.onLog("gpio", `PWM.stop() → physical pin ${rec.physical} LOW`);
      await publish(`PWM stopped on physical pin ${rec.physical}`, true);
      return null;
    });
    options.onLog("gpio", `GPIO.PWM(${args[0] ?? kwargs.channel}, ${freq} Hz) → BCM ${ch.bcm} · physical pin ${ch.physical}`);
    return api;
  });
  gpio.add_event_detect = unsupported("add_event_detect");
  gpio.remove_event_detect = unsupported("remove_event_detect");
  gpio.wait_for_edge = unsupported("wait_for_edge");
  gpio.event_detected = unsupported("event_detected");
  gpio.add_event_callback = unsupported("add_event_callback");

  const timeMod: Record<string, unknown> = {
    __pytype: "module",
    __name: "time",
    sleep: pyf("sleep", async (args, _k, line) => {
      const raw = args[0];
      if (typeof raw !== "number" || Number.isNaN(raw)) fail("TypeError", "sleep() argument must be a number", line);
      if (raw < 0) fail("ValueError", "sleep length must be non-negative", line);
      const sec = raw;
      options.onLog("system", `time.sleep(${sec})`);
      const scaled = (sec * 1000) / timeScale;
      const start = performance.now();
      const t0 = simTime;
      if (sec >= 0.25) options.onWait({ total: sec, remaining: sec });
      while (performance.now() - start < scaled) {
        stop();
        const elapsed = performance.now() - start;
        const frac = scaled === 0 ? 1 : elapsed / scaled;
        simTime = t0 + sec * Math.min(1, frac);
        options.onClock(simTime);
        if (sec >= 0.25) options.onWait({ total: sec, remaining: Math.max(0, sec * (1 - frac)) });
        await new Promise((r) => setTimeout(r, Math.min(40, Math.max(0, scaled - elapsed))));
      }
      simTime = t0 + sec;
      options.onClock(simTime);
      options.onWait(null);
      return null;
    }),
    time: pyf("time", () => performance.now() / 1000),
  };

  const rpiPkg = { __pytype: "module", __name: "RPi", GPIO: gpio };
  const modules: Record<string, Record<string, unknown>> = {
    "RPi.GPIO": gpio,
    RPi: rpiPkg,
    time: timeMod,
  };

  let printBuf = "";
  const flushPrint = (forceNl: boolean) => {
    if (printBuf.includes("\n")) {
      const parts = printBuf.split("\n");
      printBuf = parts.pop() ?? "";
      for (const p of parts) options.onLog("stdout", p);
    }
    if (forceNl && printBuf.length) {
      options.onLog("stdout", printBuf);
      printBuf = "";
    }
  };

  const builtins: Record<string, unknown> = {
    print: pyf("print", (args, kwargs) => {
      const sep = kwargs.sep === undefined ? " " : String(kwargs.sep);
      const end = kwargs.end === undefined ? "\n" : String(kwargs.end);
      printBuf += args.map((a) => pyStr(a)).join(sep) + end;
      flushPrint(false);
      return null;
    }),
    range: pyf("range", (args, _k, line) => {
      let start = 0;
      let stop = 0;
      let step = 1;
      if (args.length === 1) stop = num(args[0], line);
      else if (args.length === 2) {
        start = num(args[0], line);
        stop = num(args[1], line);
      } else if (args.length === 3) {
        start = num(args[0], line);
        stop = num(args[1], line);
        step = num(args[2], line);
      } else fail("TypeError", "range expected 1 to 3 arguments", line);
      if (step === 0) fail("ValueError", "range() arg 3 must not be zero", line);
      const out: number[] = [];
      if (step > 0) for (let n = start; n < stop; n += step) out.push(n);
      else for (let n = start; n > stop; n += step) out.push(n);
      if (out.length > 100000) fail("RuntimeError", "range is too large for the simulator", line);
      return out;
    }),
    len: pyf("len", (args, _k, line) => {
      const v = args[0];
      if (typeof v === "string" || Array.isArray(v)) return v.length;
      fail("TypeError", `object of type ${pyTypeName(v)} has no len()`, line);
    }),
    int: pyf("int", (args, _k, line) => {
      if (args.length === 0) return 0;
      const v = args[0];
      if (typeof v === "boolean") return v ? 1 : 0;
      if (typeof v === "number") return Math.trunc(v);
      if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Math.trunc(Number(v));
      fail("ValueError", "invalid literal for int()", line);
    }),
    float: pyf("float", (args, _k, line) => {
      const v = args[0];
      if (typeof v === "number") return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
      fail("ValueError", "could not convert to float", line);
    }),
    str: pyf("str", (args) => (args.length ? pyStr(args[0]) : "")),
    bool: pyf("bool", (args) => truthy(args[0])),
    abs: pyf("abs", (args, _k, line) => Math.abs(num(args[0], line))),
    min: pyf("min", (args, _k, line) => {
      const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      if (!list.length) fail("ValueError", "min() arg is an empty sequence", line);
      return list.slice(1).reduce((a: unknown, b: unknown) => (pyLess(b, a) ? b : a), list[0]);
    }),
    max: pyf("max", (args, _k, line) => {
      const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      if (!list.length) fail("ValueError", "max() arg is an empty sequence", line);
      return list.slice(1).reduce((a: unknown, b: unknown) => (pyLess(a, b) ? b : a), list[0]);
    }),
    sum: pyf("sum", (args, _k, line) => {
      const list = args[0];
      if (!Array.isArray(list)) fail("TypeError", "sum() requires a list", line);
      return list.reduce((a: number, b: unknown) => a + num(b, line), 0);
    }),
    round: pyf("round", (args, _k, line) => {
      const n = num(args[0], line);
      const d = args.length > 1 ? num(args[1], line) : 0;
      const p = 10 ** d;
      return Math.round(n * p) / p;
    }),
    sorted: pyf("sorted", (args, _k, line) => {
      if (!Array.isArray(args[0])) fail("TypeError", "sorted() requires a list", line);
      return [...args[0]].sort((a, b) => (pyEq(a, b) ? 0 : pyLess(a, b) ? -1 : 1));
    }),
    reversed: pyf("reversed", (args, _k, line) => {
      if (!Array.isArray(args[0]) && typeof args[0] !== "string") fail("TypeError", "reversed() requires a sequence", line);
      return [...(args[0] as unknown[])].reverse();
    }),
    enumerate: pyf("enumerate", (args, _k, line) => {
      const seq = args[0];
      if (!Array.isArray(seq) && typeof seq !== "string") fail("TypeError", "enumerate() requires a sequence", line);
      const start = args.length > 1 ? num(args[1], line) : 0;
      return [...seq].map((v, i) => [i + start, v]);
    }),
    list: pyf("list", (args) => {
      if (args.length === 0) return [];
      if (Array.isArray(args[0]) || typeof args[0] === "string") return [...(args[0] as unknown[])];
      return [];
    }),
    input: pyf("input", (_a, _k, line) => {
      fail("RuntimeError", "input() is not available in the simulator. Assign a variable instead.", line);
    }),
    __name__: "__main__",
  };

  function num(v: unknown, line: number): number {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    fail("TypeError", `a number is required, not ${pyTypeName(v)}`, line);
  }

  const globalEnv: Env = { vars: new Map(Object.entries(builtins)), parent: null };

  function lookup(env: Env, name: string, line: number, locals?: Set<string>): unknown {
    if (locals?.has(name)) {
      if (env.vars.has(name)) return env.vars.get(name);
      fail("UnboundLocalError", `local variable '${name}' referenced before assignment`, line);
    }
    let e: Env | null = locals ? env.parent : env;
    while (e) {
      if (e.vars.has(name)) return e.vars.get(name);
      e = e.parent;
    }
    const hint =
      name === "GPIO"
        ? " Did you forget `import RPi.GPIO as GPIO`?"
        : name === "sleep"
          ? " Did you forget `import time` and `time.sleep(...)`?"
          : "";
    fail("NameError", `name '${name}' is not defined.${hint}`, line);
  }

  function assignTo(env: Env, name: string, value: unknown, globals: Set<string> | null) {
    if (globals?.has(name)) {
      globalEnv.vars.set(name, value);
      return;
    }
    env.vars.set(name, value);
  }

  async function evalFString(raw: string, env: Env, locals: Set<string> | undefined, line: number): Promise<string> {
    let out = "";
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "{" && raw[i + 1] === "{") {
        out += "{";
        i++;
        continue;
      }
      if (raw[i] === "}" && raw[i + 1] === "}") {
        out += "}";
        i++;
        continue;
      }
      if (raw[i] === "{") {
        let depth = 1;
        let j = i + 1;
        while (j < raw.length && depth) {
          if (raw[j] === "{") depth++;
          else if (raw[j] === "}") depth--;
          if (depth) j++;
        }
        const exprSrc = raw.slice(i + 1, j);
        const tokens = tokenize(exprSrc + "\n");
        const parser = new Parser(tokens);
        const expr = parser.parseExpr();
        out += pyStr(await evalExpr(expr, env, locals));
        i = j;
        continue;
      }
      out += raw[i];
    }
    void line;
    return out;
  }

  async function evalExpr(expr: Expr, env: Env, locals?: Set<string>): Promise<unknown> {
    switch (expr.type) {
      case "Num":
        return expr.value;
      case "Str":
        return expr.value;
      case "FStr":
        return evalFString(expr.value, env, locals, expr.line);
      case "Bool":
        return expr.value;
      case "None":
        return null;
      case "Name":
        return lookup(env, expr.name, expr.line, locals);
      case "List":
        return Promise.all(expr.items.map((it) => evalExpr(it, env, locals)));
      case "Unary": {
        const v = await evalExpr(expr.expr, env, locals);
        if (expr.op === "not") return !truthy(v);
        if (expr.op === "-") return -num(v, expr.line);
        return num(v, expr.line);
      }
      case "BoolOp": {
        const left = await evalExpr(expr.left, env, locals);
        if (expr.op === "and") return truthy(left) ? evalExpr(expr.right, env, locals) : left;
        return truthy(left) ? left : evalExpr(expr.right, env, locals);
      }
      case "Bin": {
        const l = await evalExpr(expr.left, env, locals);
        const r = await evalExpr(expr.right, env, locals);
        return binOp(expr.op, l, r, expr.line);
      }
      case "Compare": {
        let left = await evalExpr(expr.left, env, locals);
        for (const cmp of expr.ops) {
          const right = await evalExpr(cmp.right, env, locals);
          if (!compare(cmp.op, left, right, expr.line)) return false;
          left = right;
        }
        return true;
      }
      case "Attr": {
        const obj = await evalExpr(expr.obj, env, locals);
        if (obj === null || obj === undefined) fail("AttributeError", `'NoneType' has no attribute '${expr.name}'`, expr.line);
        if (Array.isArray(obj) && expr.name === "append") {
          return pyf("append", (args) => {
            obj.push(args[0]);
            return null;
          });
        }
        if (Array.isArray(obj) && expr.name === "pop") {
          return pyf("pop", () => obj.pop() ?? null);
        }
        if (typeof obj === "string") {
          if (expr.name === "upper") return pyf("upper", () => obj.toUpperCase());
          if (expr.name === "lower") return pyf("lower", () => obj.toLowerCase());
          if (expr.name === "strip") return pyf("strip", () => obj.trim());
          if (expr.name === "startswith") return pyf("startswith", (args) => obj.startsWith(String(args[0] ?? "")));
        }
        if (typeof obj === "object") {
          const rec = obj as Record<string, unknown>;
          if (expr.name in rec) {
            const val = rec[expr.name];
            return val;
          }
          const mod = rec.__name ? `module '${String(rec.__name)}'` : pyTypeName(obj);
          fail("AttributeError", `${mod} has no attribute '${expr.name}'`, expr.line);
        }
        fail("AttributeError", `'${pyTypeName(obj)}' has no attribute '${expr.name}'`, expr.line);
      }
      case "Index": {
        const obj = await evalExpr(expr.obj, env, locals);
        const index = await evalExpr(expr.index, env, locals);
        if (typeof index !== "number") fail("TypeError", "indices must be integers", expr.line);
        const i = index < 0 && (Array.isArray(obj) || typeof obj === "string") ? obj.length + index : index;
        if (typeof obj === "string" || Array.isArray(obj)) {
          if (i < 0 || i >= obj.length) fail("IndexError", "index out of range", expr.line);
          return obj[i];
        }
        fail("TypeError", `'${pyTypeName(obj)}' object is not subscriptable`, expr.line);
      }
      case "Call": {
        const fn = await evalExpr(expr.func, env, locals);
        const args = [];
        for (const a of expr.args) args.push(await evalExpr(a, env, locals));
        const kwargs: Record<string, unknown> = {};
        for (const k of expr.kwargs) kwargs[k.name] = await evalExpr(k.value, env, locals);
        return callValue(fn, args, kwargs, expr.line, env);
      }
      default:
        fail("RuntimeError", "unsupported expression", 1);
    }
  }

  async function callValue(
    fn: unknown,
    args: unknown[],
    kwargs: Record<string, unknown>,
    line: number,
    caller: Env,
  ): Promise<unknown> {
    if (isPyFunc(fn)) return await fn.call(args, kwargs, line);
    if (isUserFn(fn)) {
      const local: Env = { vars: new Map(), parent: fn.env };
      if (args.length > fn.params.length) {
        fail("TypeError", `${fn.__name}() takes ${fn.params.length} positional arguments but ${args.length} were given`, line);
      }
      const bound = new Set<string>();
      args.forEach((a, i) => {
        local.vars.set(fn.params[i], a);
        bound.add(fn.params[i]);
      });
      for (const [k, v] of Object.entries(kwargs)) {
        if (!fn.params.includes(k)) fail("TypeError", `${fn.__name}() got an unexpected keyword argument '${k}'`, line);
        if (bound.has(k)) fail("TypeError", `${fn.__name}() got multiple values for argument '${k}'`, line);
        local.vars.set(k, v);
        bound.add(k);
      }
      const firstDefault = fn.params.length - fn.defaults.length;
      for (let i = 0; i < fn.params.length; i++) {
        if (bound.has(fn.params[i])) continue;
        const di = i - firstDefault;
        if (di < 0) fail("TypeError", `${fn.__name}() missing required argument '${fn.params[i]}'`, line);
        local.vars.set(fn.params[i], await evalExpr(fn.defaults[di], fn.env, undefined));
      }
      frames.push({ fn: fn.__name, line });
      try {
        const sig = await execBlock(fn.body, local, fn.locals, fn.globals, true);
        if (sig?.type === "return") return sig.value;
        if (sig?.type === "break" || sig?.type === "continue") {
          fail("SyntaxError", `'${sig.type}' outside loop`, line);
        }
        return null;
      } finally {
        frames.pop();
      }
    }
    void caller;
    fail("TypeError", `'${pyTypeName(fn)}' object is not callable`, line);
  }

  function binOp(op: string, l: unknown, r: unknown, line: number): unknown {
    if (op === "+") {
      if (typeof l === "number" || typeof l === "boolean") {
        if (typeof r === "number" || typeof r === "boolean") return num(l, line) + num(r, line);
      }
      if (typeof l === "string" && typeof r === "string") return l + r;
      if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
      fail("TypeError", `unsupported operand types for +: ${pyTypeName(l)} and ${pyTypeName(r)}`, line);
    }
    if (op === "*") {
      if ((typeof l === "number" || typeof l === "boolean") && (typeof r === "number" || typeof r === "boolean")) {
        return num(l, line) * num(r, line);
      }
      if (typeof l === "string" && typeof r === "number") return repeat(l, r, line);
      if (typeof r === "string" && typeof l === "number") return repeat(r, l, line);
      if (Array.isArray(l) && typeof r === "number") return repeatList(l, r, line);
      fail("TypeError", `unsupported operand types for *: ${pyTypeName(l)} and ${pyTypeName(r)}`, line);
    }
    if (op === "-") return num(l, line) - num(r, line);
    if (op === "/") {
      const b = num(r, line);
      if (b === 0) fail("ZeroDivisionError", "division by zero", line);
      return num(l, line) / b;
    }
    if (op === "//") {
      const b = num(r, line);
      if (b === 0) fail("ZeroDivisionError", "integer division by zero", line);
      return Math.floor(num(l, line) / b);
    }
    if (op === "%") {
      const b = num(r, line);
      if (b === 0) fail("ZeroDivisionError", "modulo by zero", line);
      return num(l, line) - Math.floor(num(l, line) / b) * b;
    }
    if (op === "**") return num(l, line) ** num(r, line);
    fail("RuntimeError", `unknown operator ${op}`, line);
  }

  function repeat(s: string, n: number, line: number) {
    const c = Math.trunc(num(n, line));
    if (c > 10000) fail("RuntimeError", "string repeat too large", line);
    return c <= 0 ? "" : s.repeat(c);
  }
  function repeatList(list: unknown[], n: number, line: number) {
    const c = Math.trunc(num(n, line));
    if (c > 10000) fail("RuntimeError", "list repeat too large", line);
    const out: unknown[] = [];
    for (let i = 0; i < c; i++) out.push(...list);
    return out;
  }

  function compare(op: string, l: unknown, r: unknown, line: number): boolean {
    if (op === "==") return pyEq(l, r);
    if (op === "!=") return !pyEq(l, r);
    if (op === "is") return l === r || (typeof l === "number" && typeof r === "number" && l === r);
    if (op === "is not") return !compare("is", l, r, line);
    if (op === "in") return contains(r, l, line);
    if (op === "not in") return !contains(r, l, line);
    if (op === "<") return pyLess(l, r);
    if (op === ">") return pyLess(r, l);
    if (op === "<=") return pyLess(l, r) || pyEq(l, r);
    if (op === ">=") return pyLess(r, l) || pyEq(l, r);
    return false;
  }

  function contains(container: unknown, item: unknown, line: number): boolean {
    if (typeof container === "string") return container.includes(pyStr(item));
    if (Array.isArray(container)) return container.some((v) => pyEq(v, item));
    fail("TypeError", `argument of type ${pyTypeName(container)} is not iterable`, line);
  }

  async function execBlock(
    stmts: Stmt[],
    env: Env,
    locals: Set<string> | undefined,
    globals: Set<string> | null,
    inFn: boolean,
  ): Promise<Signal> {
    for (const stmt of stmts) {
      stop();
      steps++;
      if (steps > 300000) {
        fail("RuntimeError", "Execution limit reached. Add time.sleep() in long loops, or press Stop.", stmt.line);
      }
      if (steps % 2000 === 0) await new Promise((r) => setTimeout(r, 0));
      frames[frames.length - 1].line = stmt.line;
      const sig = await execStmt(stmt, env, locals, globals, inFn);
      if (sig) return sig;
    }
    return null;
  }

  async function execStmt(
    stmt: Stmt,
    env: Env,
    locals: Set<string> | undefined,
    globals: Set<string> | null,
    inFn: boolean,
  ): Promise<Signal> {
    switch (stmt.type) {
      case "Pass":
        return null;
      case "Break":
        return { type: "break" };
      case "Continue":
        return { type: "continue" };
      case "Global":
        return null;
      case "Import": {
        for (const spec of stmt.names) {
          const mod = modules[spec.module];
          if (!mod) {
            fail(
              "ModuleNotFoundError",
              `No module named '${spec.module}'. This simulator provides RPi.GPIO and time.`,
              stmt.line,
            );
          }
          if (spec.as) env.vars.set(spec.as, mod);
          else if (spec.module === "RPi.GPIO") env.vars.set("RPi", modules.RPi);
          else env.vars.set(spec.module, mod);
        }
        return null;
      }
      case "From": {
        const mod = modules[stmt.module];
        if (!mod) fail("ModuleNotFoundError", `No module named '${stmt.module}'`, stmt.line);
        for (const spec of stmt.names) {
          if (!(spec.name in mod)) fail("ImportError", `cannot import name '${spec.name}' from '${stmt.module}'`, stmt.line);
          env.vars.set(spec.as, mod[spec.name]);
        }
        return null;
      }
      case "Function": {
        const scope = collectScope(stmt.body);
        for (const p of stmt.params) scope.locals.add(p);
        for (const g of scope.globals) scope.locals.delete(g);
        const fn: UserFn = {
          __userfn: true,
          __name: stmt.name,
          params: stmt.params,
          defaults: stmt.defaults,
          body: stmt.body,
          env,
          locals: scope.locals,
          globals: scope.globals,
        };
        assignTo(env, stmt.name, fn, globals);
        return null;
      }
      case "Return": {
        if (!inFn) fail("SyntaxError", "'return' outside function", stmt.line);
        const value = stmt.value ? await evalExpr(stmt.value, env, locals) : null;
        return { type: "return", value };
      }
      case "Assign": {
        const value = await evalExpr(stmt.value, env, locals);
        if (stmt.names.length === 1) assignTo(env, stmt.names[0], value, globals);
        else {
          if (!Array.isArray(value) && typeof value !== "string") {
            fail("TypeError", "cannot unpack non-sequence", stmt.line);
          }
          const seq = Array.isArray(value) ? value : [...value];
          if (seq.length !== stmt.names.length) {
            fail("ValueError", `expected ${stmt.names.length} values to unpack, got ${seq.length}`, stmt.line);
          }
          stmt.names.forEach((n, i) => assignTo(env, n, seq[i], globals));
        }
        return null;
      }
      case "AugAssign": {
        const cur = lookup(env, stmt.name, stmt.line, locals);
        const right = await evalExpr(stmt.value, env, locals);
        const op = stmt.op.replace("=", "");
        assignTo(env, stmt.name, binOp(op, cur, right, stmt.line), globals);
        return null;
      }
      case "Expr": {
        const v = await evalExpr(stmt.expr, env, locals);
        if (isPyFunc(v) && stmt.expr.type !== "Call") {
          options.onLog("warn", `${v.__name} was not called — add parentheses.`);
        }
        return null;
      }
      case "For": {
        const iter = await evalExpr(stmt.iter, env, locals);
        let seq: unknown[] = [];
        if (Array.isArray(iter)) seq = iter;
        else if (typeof iter === "string") seq = [...iter];
        else fail("TypeError", `'${pyTypeName(iter)}' object is not iterable`, stmt.line);
        for (const item of seq) {
          stop();
          if (stmt.targets.length === 1) assignTo(env, stmt.targets[0], item, globals);
          else {
            if (!Array.isArray(item)) fail("TypeError", "cannot unpack non-sequence", stmt.line);
            if (item.length !== stmt.targets.length) fail("ValueError", "not enough values to unpack", stmt.line);
            stmt.targets.forEach((n, i) => assignTo(env, n, item[i], globals));
          }
          const sig = await execBlock(stmt.body, env, locals, globals, inFn);
          if (sig?.type === "break") break;
          if (sig?.type === "continue") continue;
          if (sig) return sig;
        }
        return null;
      }
      case "While": {
        let guard = 0;
        while (truthy(await evalExpr(stmt.test, env, locals))) {
          guard++;
          if (guard > 200000) fail("RuntimeError", "while loop ran too long. Add time.sleep() or press Stop.", stmt.line);
          const sig = await execBlock(stmt.body, env, locals, globals, inFn);
          if (sig?.type === "break") break;
          if (sig?.type === "continue") continue;
          if (sig) return sig;
        }
        return null;
      }
      case "If": {
        if (truthy(await evalExpr(stmt.test, env, locals))) return execBlock(stmt.body, env, locals, globals, inFn);
        for (const elif of stmt.elifs) {
          if (truthy(await evalExpr(elif.test, env, locals))) return execBlock(elif.body, env, locals, globals, inFn);
        }
        if (stmt.elseBody) return execBlock(stmt.elseBody, env, locals, globals, inFn);
        return null;
      }
      default:
        return null;
    }
  }

  let ast: Stmt[];
  try {
    ast = new Parser(tokenize(source)).parseModule();
  } catch (e) {
    if (e instanceof PyError) throw e;
    throw e;
  }
  if (!ast.length) {
    options.onLog("system", "Nothing to run.");
    return;
  }
  options.onHardware({ mode: null, drive: {} });
  try {
    await execBlock(ast, globalEnv, undefined, null, false);
    flushPrint(true);
    if (channels.size) {
      options.onLog("system", "Note: GPIO.cleanup() was not called. Pins were left in their last state.");
    }
    options.onClock(simTime);
  } finally {
    alive = false;
    if (pwmTimer) {
      clearInterval(pwmTimer);
      pwmTimer = null;
    }
  }
}

interface UserFn {
  __userfn: true;
  __name: string;
  params: string[];
  defaults: Expr[];
  body: Stmt[];
  env: Env;
  locals: Set<string>;
  globals: Set<string>;
}

function isUserFn(v: unknown): v is UserFn {
  return !!v && typeof v === "object" && (v as UserFn).__userfn === true;
}

function collectScope(stmts: Stmt[]): { locals: Set<string>; globals: Set<string> } {
  const locals = new Set<string>();
  const globals = new Set<string>();
  const walk = (list: Stmt[], nested: boolean) => {
    for (const s of list) {
      if (s.type === "Global") {
        if (!nested) s.names.forEach((n) => globals.add(n));
        continue;
      }
      if (!nested && (s.type === "Assign" || s.type === "AugAssign")) {
        if (s.type === "Assign") s.names.forEach((n) => locals.add(n));
        else locals.add(s.name);
      }
      if (!nested && s.type === "For") s.targets.forEach((n) => locals.add(n));
      if (!nested && s.type === "Function") locals.add(s.name);
      if (s.type === "If") {
        walk(s.body, nested);
        s.elifs.forEach((e) => walk(e.body, nested));
        if (s.elseBody) walk(s.elseBody, nested);
      }
      if (s.type === "While" || s.type === "For") walk(s.body, nested);
      if (s.type === "Function") walk(s.body, true);
    }
  };
  walk(stmts, false);
  globals.forEach((g) => locals.delete(g));
  return { locals, globals };
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (Array.isArray(v)) return "list";
  if (isPyFunc(v) || isUserFn(v)) return "function";
  if (typeof v === "object" && v && "__name" in v) return "module";
  return typeof v;
}

function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => (typeof x === "string" ? `'${x}'` : pyStr(x))).join(", ")}]`;
  if (isUserFn(v)) return `<function ${v.__name}>`;
  if (isPyFunc(v)) return `<built-in function ${v.__name}>`;
  if (typeof v === "object" && v && "__name" in v) return `<module '${String((v as { __name: string }).__name)}'>`;
  return String(v);
}

function pyEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "boolean") return a === (b ? 1 : 0);
  if (typeof b === "number" && typeof a === "boolean") return b === (a ? 1 : 0);
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => pyEq(v, b[i]));
  return false;
}

function pyLess(a: unknown, b: unknown): boolean {
  if ((typeof a === "number" || typeof a === "boolean") && (typeof b === "number" || typeof b === "boolean")) {
    return Number(a) < Number(b);
  }
  if (typeof a === "string" && typeof b === "string") return a < b;
  return false;
}
