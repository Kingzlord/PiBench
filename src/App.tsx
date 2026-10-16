import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { CodeEditor } from "./components/CodeEditor";
import { Bench } from "./components/Bench";
import { PinoutModal } from "./components/PinoutModal";
import { NodeRedPanel } from "./components/NodeRedPanel";
import { BCM_TO_PHYSICAL } from "./data/pins";
import { TEMPLATES, templateById, type TemplateId } from "./data/templates";
import {
  LED_META,
  describePoint,
  evaluateCircuit,
  holeNode,
  type DriveMap,
  type LedColor,
  type Part,
  type Wire,
} from "./sim/circuit";
import {
  StopError,
  executePython,
  formatPyError,
  PyError,
  type LogLevel,
  type TraceSnap,
} from "./sim/python";

type Tool =
  | { kind: "wire" }
  | { kind: "erase" }
  | { kind: "led"; color: LedColor }
  | { kind: "resistor"; ohms: number };

interface LogEntry {
  id: number;
  level: LogLevel;
  text: string;
}

const WIRE_COLORS = ["#f5c542", "#f08a24", "#ef4444", "#3dbe6e", "#3b82f6", "#a855f7", "#f4f1ea", "#2a2f38"];

const initial = TEMPLATES[0];

export default function App() {
  const [templateId, setTemplateId] = useState<TemplateId>("single");
  const [code, setCode] = useState(initial.code);
  const [wires, setWires] = useState<Wire[]>(initial.wires);
  const [parts, setParts] = useState<Part[]>(initial.parts);
  const [tool, setTool] = useState<Tool>({ kind: "wire" });
  const [wireColor, setWireColor] = useState(WIRE_COLORS[0]);
  const [pending, setPending] = useState<string | null>(null);
  const [drive, setDrive] = useState<DriveMap>({});
  const [ghost, setGhost] = useState<DriveMap | null>(null);
  const [mode, setMode] = useState<"BOARD" | "BCM" | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [wait, setWait] = useState<{ total: number; remaining: number } | null>(null);
  const [errorLine, setErrorLine] = useState<number | null>(null);
  const [snaps, setSnaps] = useState<TraceSnap[]>([]);
  const [simTime, setSimTime] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [pinout, setPinout] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [replayDrive, setReplayDrive] = useState<DriveMap | null>(null);
  const [hint, setHint] = useState("Click a GPIO pin, then a breadboard hole, to drop a jumper.");
  const [nodeRedOpen, setNodeRedOpen] = useState(false);
  const [nodeRedLive, setNodeRedLive] = useState(false);

  const idRef = useRef(20);
  const stopRef = useRef(false);
  const replayStop = useRef(false);
  const wiringRef = useRef({ wires, parts });
  wiringRef.current = { wires, parts };
  const logId = useRef(1);
  const consoleRef = useRef<HTMLDivElement>(null);
  const loggedFaults = useRef(new Set<string>());
  const runningRef = useRef(false);
  const nodeRedLiveRef = useRef(false);
  const flowPins = useRef<Set<number>>(new Set());

  const displayDrive = replayDrive ?? ghost ?? drive;
  const analysis = useMemo(
    () => evaluateCircuit(wires, parts, displayDrive, mode),
    [wires, parts, displayDrive, mode],
  );
  const template = templateById(templateId);
  const ledLevel = Object.fromEntries(
    analysis.leds.map((l) => [l.id, l.on ? Math.min(1, l.brightness / 0.85) : 0]),
  );

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
  }, [logs]);

  useEffect(() => {
    if (!running) return;
    for (const fault of analysis.faults) {
      if (loggedFaults.current.has(fault.id)) continue;
      loggedFaults.current.add(fault.id);
      pushLog(fault.severity === "error" ? "error" : "warn", fault.message);
    }
  }, [analysis, running]);

  useEffect(() => {
    if (snaps.length < 2) return;
    const last = snaps[snaps.length - 1];
    const prev = snaps[snaps.length - 2];
    if (!/cleanup/i.test(last.note)) return;
    if (last.t - prev.t > 0.08) return;
    const pulse: DriveMap = {};
    for (const [k, v] of Object.entries(prev.drive)) {
      if (v.dir === "OUT" && v.high) pulse[Number(k)] = v;
    }
    if (!Object.keys(pulse).length) return;
    setGhost(pulse);
    const pins = Object.keys(pulse).join(", ");
    setNote(`Pulse on physical pin ${pins} — GPIO.cleanup() released it immediately. Replay to watch it again.`);
    const t = window.setTimeout(() => setGhost(null), 1100);
    return () => window.clearTimeout(t);
  }, [snaps]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (runningRef.current || replaying) {
          stopRef.current = true;
          replayStop.current = true;
        }
        setPending(null);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function pushLog(level: LogLevel, text: string) {
    setLogs((prev) => {
      const next = [...prev, { id: logId.current++, level, text }];
      return next.length > 400 ? next.slice(-400) : next;
    });
  }

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 2800);
  }

  function occupied(id: string) {
    return parts.some((p) =>
      p.type === "led" ? p.anode === id || p.cathode === id : p.a === id || p.b === id,
    );
  }

  function loadTemplate(id: TemplateId) {
    if (runningRef.current) return;
    const t = templateById(id);
    setTemplateId(id);
    setCode(t.code);
    setWires(t.wires);
    setParts(t.parts);
    setPending(null);
    setErrorLine(null);
    setDrive({});
    setGhost(null);
    setReplayDrive(null);
    setSnaps([]);
    setNote(null);
    setHint(
      t.wires.length
        ? "Suggested wiring is on the bench. Rewire by clicking a pin, then a hole."
        : "Empty bench. Place an LED, then jumper its anode to a GPIO pin and its cathode to GND.",
    );
  }

  function handlePoint(id: string) {
    if (tool.kind === "erase") {
      setWires((w) => w.filter((wire) => wire.a !== id && wire.b !== id));
      setParts((p) => p.filter((part) => (part.type === "led" ? part.anode !== id && part.cathode !== id : part.a !== id && part.b !== id)));
      setHint(`Cleared connections at ${describePoint(id)}.`);
      return;
    }
    if (tool.kind === "led" || tool.kind === "resistor") {
      if (!id.startsWith("h-")) {
        setHint("Component leads sit in breadboard holes. Click a hole, not a header pin.");
        return;
      }
      if (occupied(id)) {
        setHint("That hole already has a lead. Pick an empty hole in the same strip if you only need the connection.");
        return;
      }
      if (!pending) {
        setPending(id);
        setHint(tool.kind === "led" ? "Anode (+) set. Click the cathode (−) hole on a different strip." : "First lead set. Click the other end of the resistor.");
        return;
      }
      if (pending === id) {
        setPending(null);
        return;
      }
      if (tool.kind === "led" && holeNode(pending) && holeNode(pending) === holeNode(id)) {
        setHint("Those holes are already connected. Cross the center gap or move to another column so the LED is not shorted.");
        return;
      }
      const part: Part =
        tool.kind === "led"
          ? { id: `led-${++idRef.current}`, type: "led", color: tool.color, anode: pending, cathode: id }
          : { id: `res-${++idRef.current}`, type: "resistor", ohms: tool.ohms, a: pending, b: id };
      setParts((p) => [...p, part]);
      setPending(null);
      setTool({ kind: "wire" });
      setHint("Placed. Switch stays on the wire tool — connect the anode row to a GPIO pin and the cathode row to GND.");
      return;
    }
    if (!pending) {
      setPending(id);
      setHint(`Jumper started at ${describePoint(id)}. Click the other end, or Esc to cancel.`);
      return;
    }
    if (pending === id) {
      setPending(null);
      setHint("Cancelled that jumper.");
      return;
    }
    setWires((w) => [...w, { id: `w-${++idRef.current}`, a: pending, b: id, color: wireColor }]);
    setPending(null);
    setHint(`Connected ${describePoint(pending)} to ${describePoint(id)}.`);
  }

  function stop() {
    stopRef.current = true;
    replayStop.current = true;
  }

  function releaseNodeRedPins() {
    nodeRedLiveRef.current = false;
    setNodeRedLive(false);
    setDrive((prev) => {
      const next = { ...prev };
      for (const pin of flowPins.current) delete next[pin];
      return next;
    });
    flowPins.current.clear();
  }

  function deployNodeRed() {
    if (runningRef.current) return false;
    nodeRedLiveRef.current = true;
    setNodeRedLive(true);
    pushLog("system", "Node-RED deployed. It now owns the GPIO pins until Stop.");
    return true;
  }

  function stopNodeRed() {
    if (!nodeRedLiveRef.current && flowPins.current.size === 0) return;
    releaseNodeRedPins();
    setNote("Node-RED stopped. Flow pins released.");
    pushLog("system", "Node-RED stopped. GPIO pins driven by the flow were released.");
  }

  function injectNodeRed(writes: { bcm: number; high: boolean }[], summary: string) {
    if (runningRef.current) {
      return "Python is running and owns the GPIO pins. Press Stop on the script before a Node-RED inject.";
    }
    const next: DriveMap = {};
    for (const write of writes) {
      const physical = BCM_TO_PHYSICAL[write.bcm];
      if (!physical) return `BCM GPIO ${write.bcm} is not on the Raspberry Pi 3 header. GPIO was not changed.`;
      next[physical] = { dir: "OUT", high: write.high };
      flowPins.current.add(physical);
    }
    flushSync(() => {
      setGhost(null);
      setReplayDrive(null);
      setDrive((prev) => ({ ...prev, ...next }));
      setNote(`Node-RED · ${summary}`);
    });
    pushLog("gpio", `Node-RED ${summary}`);
    return null;
  }

  async function run() {
    if (runningRef.current) return;
    if (nodeRedLiveRef.current) {
      pushLog("error", "Node-RED is deployed and owns the GPIO pins. Press Stop in Node-RED before running Python, so the two do not overwrite each other.");
      showToast("Stop Node-RED before running Python.");
      return;
    }
    stopRef.current = false;
    replayStop.current = true;
    runningRef.current = true;
    setReplaying(false);
    setReplayDrive(null);
    setGhost(null);
    setRunning(true);
    setErrorLine(null);
    setSnaps([]);
    setNote(null);
    setWait(null);
    setSimTime(0);
    setDrive({});
    loggedFaults.current.clear();
    pushLog("system", "—— running main.py ——");
    const collected: TraceSnap[] = [];
    try {
      await executePython(code, {
        onLog: (level, message) => pushLog(level, message),
        onHardware: (hw) => {
          flushSync(() => {
            setMode(hw.mode);
            setDrive(hw.drive);
          });
        },
        onSnapshot: (snap) => {
          collected.push(snap);
          setSnaps(collected.slice());
          setSimTime(snap.t);
          setNote(snap.note);
        },
        onClock: (t) => setSimTime(t),
        onWait: (w) => setWait(w),
        shouldStop: () => stopRef.current,
        getWiring: () => wiringRef.current,
        timeScale: slow ? 0.45 : 1,
      });
      pushLog("system", "Program finished.");
    } catch (err) {
      if (err instanceof StopError) pushLog("system", "Stopped. Pins were left in their last driven state.");
      else if (err instanceof PyError) {
        setErrorLine(err.line);
        pushLog("error", formatPyError(err));
      } else {
        pushLog("error", err instanceof Error ? err.message : String(err));
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
      setWait(null);
    }
  }

  async function replay() {
    if (!snaps.length || runningRef.current) return;
    if (nodeRedLiveRef.current) {
      showToast("Stop Node-RED before replaying a Python trace.");
      return;
    }
    replayStop.current = false;
    setReplaying(true);
    for (let i = 0; i < snaps.length; i++) {
      if (replayStop.current) break;
      setReplayDrive(snaps[i].drive);
      setNote(`Replay · t=${snaps[i].t.toFixed(2)}s · ${snaps[i].note}`);
      const gap = i + 1 < snaps.length ? snaps[i + 1].t - snaps[i].t : 0.45;
      const visual = gap > 0.4 ? 380 : Math.max(260, gap * 1000);
      await new Promise((r) => setTimeout(r, visual));
    }
    setReplayDrive(null);
    setReplaying(false);
    setNote(snaps.at(-1)?.note ?? null);
  }

  function powerCycle() {
    if (runningRef.current) return;
    if (nodeRedLiveRef.current) releaseNodeRedPins();
    setDrive({});
    setGhost(null);
    setReplayDrive(null);
    setMode(null);
    setNote("Power cycled. GPIO pins released. Wiring is unchanged.");
    pushLog("system", "Power cycle — GPIO outputs released.");
  }

  const highCount = Object.values(displayDrive).filter((p) => p.dir === "OUT" && p.high).length;
  const errors = analysis.faults.filter((f) => f.severity === "error");

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <RaspberryMark />
          </span>
          <div className="brand-copy">
            <strong>PiBench</strong>
            <span>Raspberry Pi 3 Model B · GPIO laboratory</span>
          </div>
        </div>
        <div className="top-meta">
          <span className="chip">
            <i className="pwr-dot" /> powered
          </span>
          <span className="chip">{nodeRedLive ? "Node-RED live" : mode ? `${mode} numbering` : "mode not set"}</span>
          <span className="chip mono">{running || replaying ? `t ${simTime.toFixed(2)}s` : highCount ? `${highCount} pin${highCount > 1 ? "s" : ""} high` : "idle"}</span>
          <button
            className={`ghost nodered-toggle ${nodeRedOpen ? "active" : ""}`}
            type="button"
            aria-pressed={nodeRedOpen}
            onClick={() => setNodeRedOpen((open) => !open)}
          >
            Node-RED
          </button>
          <button className="ghost" type="button" onClick={() => setPinout(true)}>
            Pinout
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="editor-pane">
          <div className="template-row">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`template-btn ${templateId === t.id ? "active" : ""}`}
                onClick={() => loadTemplate(t.id)}
                disabled={running}
              >
                <small>{t.practical}</small>
                {t.name}
              </button>
            ))}
          </div>
          <div className="editor-shell">
            <div className="editor-top">
              <span className="file-name">main.py</span>
              <span className="py-badge">Python 3 · RPi.GPIO</span>
            </div>
            <CodeEditor code={code} onChange={setCode} errorLine={errorLine} readOnly={running} onRun={() => void run()} />
          </div>
          <div className="runbar">
            <button className="run" type="button" onClick={() => void run()} disabled={running}>
              <PlayIcon /> Run
            </button>
            <button className="stop" type="button" onClick={stop} disabled={!running && !replaying}>
              <StopIcon /> Stop
            </button>
            <button className="ghost" type="button" onClick={() => void replay()} disabled={running || snaps.length === 0}>
              Replay
            </button>
            <label className="slow">
              <input type="checkbox" checked={slow} onChange={(e) => setSlow(e.target.checked)} />
              Slow motion
            </label>
            <span className="kbd">Ctrl+Enter</span>
          </div>
          {wait && (
            <div className="wait-bar">
              <div style={{ width: `${Math.max(4, (1 - wait.remaining / wait.total) * 100)}%` }} />
              <span>time.sleep · {wait.remaining.toFixed(1)}s left</span>
            </div>
          )}
          <div className="console" ref={consoleRef} role="log" aria-live="polite">
            {logs.length === 0 && (
              <p className="console-empty">Output, GPIO traces, and errors appear here. Press Run.</p>
            )}
            {logs.map((line) => (
              <pre key={line.id} className={`log-line log-${line.level}`}>
                {line.text}
              </pre>
            ))}
          </div>
        </section>

        <section className="bench-pane">
          <div className="bench-toolbar">
            <div className="tool-group">
              <button type="button" className={`tool-btn ${tool.kind === "wire" ? "active" : ""}`} onClick={() => { setTool({ kind: "wire" }); setPending(null); }}>
                Wire
              </button>
              <button type="button" className={`tool-btn ${tool.kind === "erase" ? "active" : ""}`} onClick={() => { setTool({ kind: "erase" }); setPending(null); setHint("Erase mode: click a jumper, LED, resistor, or hole to remove that connection."); }}>
                Erase
              </button>
              {(["red", "green", "amber", "blue"] as LedColor[]).map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`tool-btn led-tool ${tool.kind === "led" && tool.color === color ? "active" : ""}`}
                  onClick={() => { setTool({ kind: "led", color }); setPending(null); setHint(`Click the anode hole, then the cathode hole, for a ${color} LED.`); }}
                >
                  <i style={{ background: LED_META[color].hex }} />
                  {LED_META[color].label}
                </button>
              ))}
              {[330, 1000].map((ohms) => (
                <button
                  key={ohms}
                  type="button"
                  className={`tool-btn ${tool.kind === "resistor" && tool.ohms === ohms ? "active" : ""}`}
                  onClick={() => { setTool({ kind: "resistor", ohms }); setPending(null); }}
                >
                  {ohms >= 1000 ? "1kΩ" : `${ohms}Ω`}
                </button>
              ))}
            </div>
            <div className="tool-group colors">
              {WIRE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`color-dot ${wireColor === c ? "active" : ""}`}
                  style={{ background: c }}
                  aria-label={`Jumper color ${c}`}
                  onClick={() => { setWireColor(c); setTool({ kind: "wire" }); }}
                />
              ))}
            </div>
            <div className="tool-group">
              <button type="button" className="ghost" onClick={() => loadTemplate(templateId)} disabled={running}>
                Suggested circuit
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setWires([]);
                  setParts([]);
                  setPending(null);
                  showToast("Bench cleared.");
                }}
              >
                Clear bench
              </button>
              <button type="button" className="ghost" onClick={powerCycle} disabled={running}>
                Power cycle
              </button>
            </div>
          </div>

          <p className="lab-note">
            <strong>{template.practical}.</strong> {template.blurb}
          </p>
          <p className="hint-bar">{hint}</p>

          <div className="bench-scroll">
            <Bench
              drive={displayDrive}
              pointState={analysis.pointState}
              wires={wires}
              parts={parts}
              selected={pending}
              running={running}
              eraseMode={tool.kind === "erase"}
              mouseWire={tool.kind === "wire" && !!pending}
              onPoint={handlePoint}
              onEraseWire={(id) => setWires((w) => w.filter((wire) => wire.id !== id))}
              onErasePart={(id) => setParts((p) => p.filter((part) => part.id !== id))}
              ledLevel={ledLevel}
            />
          </div>

          <div className="inspector">
            {errors.map((f) => (
              <div key={f.id} className="fault error">
                {f.message}
              </div>
            ))}
            {analysis.leds.length === 0 && (
              <div className="led-card empty">No LEDs on the breadboard yet. Place one, or load the suggested circuit.</div>
            )}
            {analysis.leds.map((led) => {
              const part = parts.find((p) => p.id === led.id);
              const color = part && part.type === "led" ? part.color : "red";
              return (
                <article key={led.id} className={`led-card sev-${led.severity} ${led.on ? "lit" : ""}`}>
                  <span className="led-swatch" style={{ background: LED_META[color].hex, boxShadow: led.on ? `0 0 12px ${LED_META[color].hex}` : undefined }} />
                  <div>
                    <strong>{LED_META[color].label} LED · {led.on ? "ON" : "OFF"}</strong>
                    <p>{led.detail}</p>
                  </div>
                </article>
              );
            })}
            {analysis.outputs.map((out) => (
              <article key={out.physical} className="led-card pin-card">
                <span className={`pin-state ${out.high ? "hot" : ""}`}>{out.high ? "H" : "L"}</span>
                <div>
                  <strong>Pin {out.physical} · BCM {out.bcm}</strong>
                  <p>
                    {typeof out.duty === "number" ? `PWM ${Math.round(out.duty)}%` : out.high ? "Driving HIGH" : "Driving LOW"}
                    {" · "}
                    {out.wired ? "wired into the breadboard" : "no jumper attached"}
                  </p>
                </div>
              </article>
            ))}
          </div>

          <Trace snaps={snaps} now={simTime} note={note} />
        </section>
      </main>
      {toast && <div className="toast">{toast}</div>}
      <NodeRedPanel
        open={nodeRedOpen}
        pythonBusy={running}
        deployed={nodeRedLive}
        onDeploy={deployNodeRed}
        onStop={stopNodeRed}
        onInject={injectNodeRed}
      />
      {pinout && <PinoutModal onClose={() => setPinout(false)} />}
    </div>
  );
}

function Trace({ snaps, now, note }: { snaps: TraceSnap[]; now: number; note: string | null }) {
  const pins = new Set<number>();
  snaps.forEach((s) => Object.keys(s.drive).forEach((k) => pins.add(Number(k))));
  const list = [...pins].slice(0, 4);
  const end = Math.max(now, snaps.at(-1)?.t ?? 0, 0.8);
  return (
    <div className="trace">
      <div className="trace-head">
        <strong>Logic trace</strong>
        <span>{note ?? "Run a program to record pin transitions."}</span>
      </div>
      {list.length === 0 ? (
        <div className="trace-empty">Physical pin levels will draw here while the script runs.</div>
      ) : (
        list.map((pin) => (
          <div className="lane" key={pin}>
            <em>P{pin}</em>
            <div className="lane-track">
              {snaps.map((snap, i) => {
                const d = snap.drive[pin];
                if (!d || d.dir !== "OUT") return null;
                const t1 = i + 1 < snaps.length ? snaps[i + 1].t : end;
                const left = (snap.t / end) * 100;
                const width = Math.max(0.8, ((t1 - snap.t) / end) * 100);
                return <i key={`${pin}-${i}`} className={d.high ? "hi" : "lo"} style={{ left: `${left}%`, width: `${width}%` }} />;
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function RaspberryMark() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden>
      <path d="M16 6c2 0 3 2 3 2s2-1 3 1-1 3-1 3 3 1 2 3-3 1-3 1 1 3-1 4-3-1-3-1-1 3-3 2-2-3-2-3-3 1-4-1 2-3 2-3-3-1-2-3 3-1 3-1-1-3 1-4 3 2 3 2 0-2 2-2z" fill="#e2185b" />
      <circle cx="13" cy="14" r="1.2" fill="#ff8aaa" />
      <circle cx="17.5" cy="13" r="1.2" fill="#ff8aaa" />
      <circle cx="15" cy="17.5" r="1.2" fill="#ff8aaa" />
      <path d="M18 7c2-3 5-3 6-2" stroke="#8fce4a" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <path d="M4 2.5v11l10-5.5L4 2.5z" fill="currentColor" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden>
      <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}
