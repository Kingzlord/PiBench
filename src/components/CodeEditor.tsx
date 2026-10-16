import { useRef } from "react";

const KEYWORDS = new Set([
  "import", "as", "from", "def", "return", "for", "in", "if", "elif", "else", "while",
  "break", "continue", "pass", "and", "or", "not", "True", "False", "None", "global",
  "is", "lambda", "class", "try", "except", "with", "assert",
]);

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function highlightPython(code: string) {
  let i = 0;
  let out = "";
  const len = code.length;
  while (i < len) {
    const ch = code[i];
    if (ch === "#") {
      const start = i;
      while (i < len && code[i] !== "\n") i++;
      out += `<span class="tok-c">${esc(code.slice(start, i))}</span>`;
      continue;
    }
    if (ch === '"' || ch === "'" || ((ch === "f" || ch === "r" || ch === "b" || ch === "F") && (code[i + 1] === '"' || code[i + 1] === "'"))) {
      let q = ch;
      if (ch !== '"' && ch !== "'") {
        i++;
        q = code[i];
      }
      const triple = code.slice(i, i + 3) === q.repeat(3);
      const end = triple ? q.repeat(3) : q;
      const start = ch !== q ? i - 1 : i;
      i += triple ? 3 : 1;
      while (i < len && !code.startsWith(end, i)) {
        if (code[i] === "\\") i += 2;
        else i++;
      }
      i += Math.min(end.length, len - i);
      out += `<span class="tok-s">${esc(code.slice(start, i))}</span>`;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(code[i + 1] ?? ""))) {
      const start = i;
      i++;
      while (i < len && /[0-9.eE_]/.test(code[i])) i++;
      out += `<span class="tok-n">${esc(code.slice(start, i))}</span>`;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i++;
      while (i < len && /[A-Za-z0-9_]/.test(code[i])) i++;
      const word = code.slice(start, i);
      let cls = "";
      if (KEYWORDS.has(word)) cls = "tok-k";
      else if (code[i] === "(") cls = "tok-f";
      else if (["GPIO", "time", "print", "range", "len", "int", "str"].includes(word)) cls = "tok-b";
      out += cls ? `<span class="${cls}">${esc(word)}</span>` : esc(word);
      continue;
    }
    out += esc(ch);
    i++;
  }
  return out;
}

interface CodeEditorProps {
  code: string;
  onChange: (code: string) => void;
  errorLine: number | null;
  readOnly?: boolean;
  onRun: () => void;
}

export function CodeEditor({ code, onChange, errorLine, readOnly, onRun }: CodeEditorProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const lines = code.split("\n");

  const sync = (el: HTMLTextAreaElement) => {
    if (preRef.current) {
      preRef.current.scrollTop = el.scrollTop;
      preRef.current.scrollLeft = el.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = el.scrollTop;
  };

  return (
    <div className="code-wrap">
      <div className="gutter" ref={gutterRef} aria-hidden>
        {lines.map((_, idx) => (
          <span key={idx} className={errorLine === idx + 1 ? "bad" : ""}>
            {idx + 1}
          </span>
        ))}
      </div>
      <div className="code-scroll">
        <pre
          ref={preRef}
          className="code-highlight"
          aria-hidden
          dangerouslySetInnerHTML={{ __html: highlightPython(code) + "\n" }}
        />
        <textarea
          className="code-input"
          value={code}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Python editor"
          onScroll={(e) => sync(e.currentTarget)}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              onRun();
              return;
            }
            if (e.key === "Tab") {
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart;
              const end = el.selectionEnd;
              const next = code.slice(0, start) + "    " + code.slice(end);
              onChange(next);
              requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = start + 4;
              });
            }
          }}
        />
      </div>
    </div>
  );
}
