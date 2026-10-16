import { useLayoutEffect, useRef, useState } from "react";
import { Breadboard } from "./Breadboard";
import { PiBoard } from "./PiBoard";
import {
  LED_META,
  resistorBands,
  type DriveMap,
  type LedPart,
  type Part,
  type PointVisual,
  type Wire,
} from "../sim/circuit";

interface Pt {
  x: number;
  y: number;
}

interface BenchProps {
  drive: DriveMap;
  pointState: Record<string, PointVisual>;
  wires: Wire[];
  parts: Part[];
  selected: string | null;
  running: boolean;
  eraseMode: boolean;
  mouseWire: boolean;
  onPoint: (id: string) => void;
  onEraseWire: (id: string) => void;
  onErasePart: (id: string) => void;
  ledLevel: Record<string, number>;
}

function curve(a: Pt, b: Pt) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const sag = Math.min(54, 12 + len * 0.12);
  const cx = mx - (dy / len) * 8;
  const cy = my + sag;
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

export function Bench({
  drive,
  pointState,
  wires,
  parts,
  selected,
  running,
  eraseMode,
  mouseWire,
  onPoint,
  onEraseWire,
  onErasePart,
  ledLevel,
}: BenchProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [pts, setPts] = useState<Record<string, Pt>>({});
  const [mouse, setMouse] = useState<Pt | null>(null);

  useLayoutEffect(() => {
    const root = canvasRef.current;
    if (!root) return;
    const measure = () => {
      const base = root.getBoundingClientRect();
      const next: Record<string, Pt> = {};
      root.querySelectorAll<HTMLElement>("[data-point]").forEach((el) => {
        const id = el.dataset.point;
        if (!id) return;
        const r = el.getBoundingClientRect();
        next[id] = { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2 };
      });
      setPts(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [wires, parts, selected]);

  const start = selected ? pts[selected] : null;

  return (
    <div
      className="bench-canvas"
      ref={canvasRef}
      onMouseMove={(e) => {
        if (!mouseWire || !canvasRef.current) return;
        const base = canvasRef.current.getBoundingClientRect();
        setMouse({ x: e.clientX - base.left, y: e.clientY - base.top });
      }}
      onMouseLeave={() => setMouse(null)}
    >
      <div className="hw-row">
        <PiBoard
          drive={drive}
          pointState={pointState}
          selected={selected}
          running={running}
          onPoint={onPoint}
        />
        <Breadboard pointState={pointState} selected={selected} onPoint={onPoint} />
      </div>
      <svg className={`wire-svg ${eraseMode ? "can-hit" : ""}`}>
        {parts.map((part) => {
          if (part.type !== "led") return null;
          const a = pts[part.anode];
          const b = pts[part.cathode];
          if (!a || !b) return null;
          const level = ledLevel[part.id] ?? 0;
          const on = level > 0.02;
          return (
            <g key={`leg-${part.id}`}>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={LED_META[part.color].hex}
                strokeWidth={on ? 3 : 2}
                strokeLinecap="round"
                opacity={on ? 0.95 : 0.7}
              />
              <text x={a.x + 7} y={a.y - 4} fill="#1c1915" fontSize="12" fontWeight="700">+</text>
            </g>
          );
        })}
        {wires.map((w) => {
          const a = pts[w.a];
          const b = pts[w.b];
          if (!a || !b) return null;
          const d = curve(a, b);
          return (
            <g key={w.id} className="jumper" onClick={() => eraseMode && onEraseWire(w.id)}>
              <path d={d} className="jumper-shadow" />
              <path d={d} stroke={w.color} className="jumper-core" />
              <circle cx={a.x} cy={a.y} r={3.2} fill={w.color} />
              <circle cx={b.x} cy={b.y} r={3.2} fill={w.color} />
            </g>
          );
        })}
        {start && mouse && mouseWire && (
          <path d={curve(start, mouse)} className="jumper-preview" />
        )}
      </svg>
      {parts.map((part) => {
        if (part.type === "led") return (
          <LedWidget key={part.id} part={part} pts={pts} level={ledLevel[part.id] ?? 0} eraseMode={eraseMode} onErase={onErasePart} />
        );
        const a = pts[part.a];
        const b = pts[part.b];
        if (!a || !b) return null;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
        const bands = resistorBands(part.ohms);
        return (
          <button
            key={part.id}
            type="button"
            className="resistor-widget"
            style={{ left: (a.x + b.x) / 2, top: (a.y + b.y) / 2, width: Math.max(36, len), transform: `translate(-50%, -50%) rotate(${ang}deg)` }}
            onClick={() => eraseMode && onErasePart(part.id)}
            title={`${part.ohms}Ω resistor${eraseMode ? " · click to remove" : ""}`}
          >
            <span className="res-body">
              {bands.map((c, i) => (
                <i key={i} style={{ background: c }} />
              ))}
            </span>
            <em>{part.ohms >= 1000 ? `${part.ohms / 1000}k` : part.ohms}</em>
          </button>
        );
      })}
    </div>
  );
}

function LedWidget({
  part,
  pts,
  level,
  eraseMode,
  onErase,
}: {
  part: LedPart;
  pts: Record<string, Pt>;
  level: number;
  eraseMode: boolean;
  onErase: (id: string) => void;
}) {
  const a = pts[part.anode];
  const b = pts[part.cathode];
  if (!a || !b) return null;
  const hex = LED_META[part.color].hex;
  const on = level > 0.02;
  return (
    <button
      type="button"
      className={`led-widget ${on ? "on" : ""}`}
      style={{
        left: (a.x + b.x) / 2,
        top: (a.y + b.y) / 2 - 6,
        ["--led" as string]: hex,
        ["--glow" as string]: String(Math.max(0, Math.min(1, level))),
      }}
      onClick={() => eraseMode && onErase(part.id)}
      title={`${LED_META[part.color].label} LED · ${on ? `${Math.round(level * 100)}%` : "off"}`}
    >
      {on && <span className="led-bloom" />}
      <span className="led-dome" />
      <span className="led-pol">+</span>
    </button>
  );
}
