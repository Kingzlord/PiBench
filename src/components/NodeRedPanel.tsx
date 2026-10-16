import { useMemo, useRef, useState } from "react";
import {
  PRELOAD_NODES,
  PRELOAD_WIRES,
  connectError,
  physicalForBcm,
  runInject,
  type FlowKind,
  type FlowNode,
  type FlowWire,
} from "../sim/nodered";

interface NodeRedPanelProps {
  open: boolean;
  pythonBusy: boolean;
  deployed: boolean;
  onDeploy: () => boolean;
  onStop: () => void;
  onInject: (writes: { bcm: number; high: boolean }[], summary: string) => string | null;
}

const NODE_W = 176;
const NODE_H = 58;

export function NodeRedPanel({ open, pythonBusy, deployed, onDeploy, onStop, onInject }: NodeRedPanelProps) {
  const [nodes, setNodes] = useState<FlowNode[]>(PRELOAD_NODES);
  const [wires, setWires] = useState<FlowWire[]>(PRELOAD_WIRES);
  const [selected, setSelected] = useState<string>("led-out");
  const [linking, setLinking] = useState<string | null>(null);
  const [status, setStatus] = useState("Practical loaded: Input HIGH and Input LOW both drive BCM GPIO 4 through LED Output.");
  const [statusKind, setStatusKind] = useState<"ok" | "warn" | "error" | "idle">("idle");
  const [seq, setSeq] = useState(3);
  const canvasRef = useRef<HTMLDivElement>(null);

  const selectedNode = nodes.find((n) => n.id === selected) ?? null;

  const positions = useMemo(() => {
    const map: Record<string, { x: number; y: number }> = {};
    for (const node of nodes) {
      map[node.id] = { x: node.x, y: node.y };
    }
    return map;
  }, [nodes]);

  function report(kind: "ok" | "warn" | "error" | "idle", text: string) {
    setStatusKind(kind);
    setStatus(text);
  }

  function addNode(kind: FlowKind) {
    const id = `n${seq}`;
    setSeq((n) => n + 1);
    const node: FlowNode = {
      id,
      kind,
      x: 48 + (seq % 4) * 18,
      y: 40 + (seq % 5) * 28,
      name: kind === "inject-high" ? "Input HIGH" : kind === "inject-low" ? "Input LOW" : "LED Output",
      payload: kind === "inject-low" ? 0 : 1,
      bcm: 4,
    };
    setNodes((list) => [...list, node]);
    setSelected(id);
    report("idle", `Added ${node.name}. Connect it, then Deploy and click an input to drive the pin.`);
  }

  function moveNode(id: string, x: number, y: number) {
    setNodes((list) => list.map((n) => (n.id === id ? { ...n, x: Math.max(8, x), y: Math.max(8, y) } : n)));
  }

  function updateSelected(patch: Partial<FlowNode>) {
    if (!selectedNode) return;
    setNodes((list) => list.map((n) => (n.id === selectedNode.id ? { ...n, ...patch } : n)));
  }

  function removeSelected() {
    if (!selectedNode) return;
    setWires((list) => list.filter((w) => w.from !== selectedNode.id && w.to !== selectedNode.id));
    setNodes((list) => list.filter((n) => n.id !== selectedNode.id));
    setSelected("");
    setLinking(null);
    report("warn", `Removed ${selectedNode.name}. Redeploy is not required, but the next inject uses the edited flow.`);
  }

  function startLink(id: string) {
    setLinking(id);
    setSelected(id);
    report("idle", "Click the input port on an LED Output to finish the wire.");
  }

  function finishLink(targetId: string) {
    const from = nodes.find((n) => n.id === linking);
    const to = nodes.find((n) => n.id === targetId);
    if (!from || !to) {
      setLinking(null);
      return;
    }
    const err = connectError(from, to, wires);
    if (err) {
      report("error", err);
      setLinking(null);
      return;
    }
    setWires((list) => [...list, { id: `wire-${seq}`, from: from.id, to: to.id }]);
    setSeq((n) => n + 1);
    setLinking(null);
    report("ok", `Connected ${from.name} to ${to.name}.`);
  }

  function execute(id: string) {
    if (pythonBusy) {
      report("error", "Python is running and owns the GPIO pins. Press Stop on the script before injecting from Node-RED.");
      return;
    }
    if (!deployed) {
      const started = onDeploy();
      if (!started) {
        report("error", "Could not deploy. Stop the other execution first.");
        return;
      }
    }
    const result = runInject(nodes, wires, id);
    if (!result.ok) {
      report("error", result.error ?? "Inject failed. GPIO was not changed.");
      return;
    }
    const blocked = onInject(
      result.writes.map((w) => ({ bcm: w.bcm, high: w.high })),
      result.summary,
    );
    if (blocked) {
      report("error", blocked);
      return;
    }
    const warn = result.warnings.length ? ` ${result.warnings[0]}` : "";
    report("ok", `${result.summary}.${warn}`);
    setNodes((list) =>
      list.map((n) => {
        const hit = result.writes.find((w) => w.ledId === n.id);
        return hit ? { ...n, payload: hit.high ? 1 : 0 } : n;
      }),
    );
  }

  function deploy() {
    if (pythonBusy) {
      report("error", "Python is running. Stop it before deploying a Node-RED flow.");
      return;
    }
    if (!onDeploy()) {
      report("error", "Deploy blocked so it does not overwrite the running Python program.");
      return;
    }
    report("ok", "Deployed. Click Input HIGH or Input LOW — BCM GPIO 4 updates only when the flow runs.");
  }

  return (
    <aside className={`nodered-panel ${open ? "open" : ""}`} aria-hidden={!open}>
      <header className="nr-head">
        <div>
          <p className="eyebrow">Flow editor</p>
          <h2>Node-RED</h2>
        </div>
        <div className="nr-actions">
          <button type="button" className="nr-deploy" onClick={deploy} disabled={!open}>
            Run / Deploy
          </button>
          <button type="button" className="nr-stop" onClick={onStop} disabled={!open || !deployed}>
            Stop
          </button>
        </div>
      </header>
      <p className="nr-help">
        Preloaded practical: both inputs target BCM GPIO 4 (physical pin 7, the Practical 2 LED). Deploy, then click an input node to drive that pin. Editing a node does not change the LED until you inject.
      </p>
      <div className="nr-palette">
        <button type="button" onClick={() => addNode("inject-high")}>+ Input HIGH</button>
        <button type="button" onClick={() => addNode("inject-low")}>+ Input LOW</button>
        <button type="button" onClick={() => addNode("led")}>+ LED Output</button>
      </div>
      <div className="nr-workspace">
        <div
          className="nr-canvas"
          ref={canvasRef}
          onClick={() => setLinking(null)}
        >
          <svg className="nr-wires" aria-hidden>
            {wires.map((wire) => {
              const from = positions[wire.from];
              const to = positions[wire.to];
              if (!from || !to) return null;
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_H / 2;
              const c = Math.max(40, Math.abs(x2 - x1) * 0.45);
              return (
                <path
                  key={wire.id}
                  d={`M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`}
                  className={linking === wire.from ? "hot" : ""}
                />
              );
            })}
          </svg>
          {nodes.map((node) => (
            <FlowNodeView
              key={node.id}
              node={node}
              selected={selected === node.id}
              linking={linking === node.id}
              deployed={deployed}
              onSelect={() => setSelected(node.id)}
              onMove={(x, y) => moveNode(node.id, x, y)}
              onInject={() => execute(node.id)}
              onPortOut={() => startLink(node.id)}
              onPortIn={() => (linking ? finishLink(node.id) : setSelected(node.id))}
            />
          ))}
        </div>
        <div className="nr-props">
          <h3>Node</h3>
          {!selectedNode && <p>Select a node to edit its name, value, or BCM pin.</p>}
          {selectedNode && (
            <>
              <label>
                Name
                <input value={selectedNode.name} onChange={(e) => updateSelected({ name: e.target.value })} />
              </label>
              {selectedNode.kind !== "led" && (
                <label>
                  Payload
                  <select
                    value={selectedNode.payload}
                    onChange={(e) => updateSelected({ payload: Number(e.target.value) === 1 ? 1 : 0 })}
                  >
                    <option value={1}>HIGH / 1</option>
                    <option value={0}>LOW / 0</option>
                  </select>
                </label>
              )}
              <label>
                BCM GPIO
                <input
                  type="number"
                  min={0}
                  max={27}
                  value={selectedNode.bcm}
                  onChange={(e) => updateSelected({ bcm: Number(e.target.value) })}
                />
              </label>
              <p className="nr-pin-note">
                {physicalForBcm(selectedNode.bcm) != null
                  ? `BCM ${selectedNode.bcm} is physical pin ${physicalForBcm(selectedNode.bcm)}.`
                  : `BCM ${selectedNode.bcm} is not on the 40-pin header.`}
              </p>
              <button type="button" className="nr-remove" onClick={removeSelected}>
                Remove node
              </button>
            </>
          )}
        </div>
      </div>
      <div className={`nr-status kind-${statusKind}`} role="status">
        <strong>{deployed ? "Deployed" : "Not deployed"}</strong>
        <span>{pythonBusy ? "Python is running — Node-RED injects are blocked." : status}</span>
      </div>
    </aside>
  );
}

function FlowNodeView({
  node,
  selected,
  linking,
  deployed,
  onSelect,
  onMove,
  onInject,
  onPortOut,
  onPortIn,
}: {
  node: FlowNode;
  selected: boolean;
  linking: boolean;
  deployed: boolean;
  onSelect: () => void;
  onMove: (x: number, y: number) => void;
  onInject: () => void;
  onPortOut: () => void;
  onPortIn: () => void;
}) {
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const isLed = node.kind === "led";
  return (
    <div
      className={`nr-node kind-${node.kind} ${selected ? "selected" : ""} ${linking ? "linking" : ""}`}
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).dataset.port) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, ox: node.x, oy: node.y, moved: false };
        onSelect();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (Math.hypot(dx, dy) > 4) d.moved = true;
        if (d.moved) onMove(d.ox + dx, d.oy + dy);
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved && !isLed) onInject();
      }}
    >
      {!isLed && (
        <button
          type="button"
          className="nr-inject"
          data-port="inject"
          title={deployed ? "Inject now" : "Deploy and inject"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onInject();
          }}
        />
      )}
      {isLed && <button type="button" className="nr-port in" data-port="in" aria-label="Input port" onClick={(e) => { e.stopPropagation(); onPortIn(); }} />}
      <div className="nr-body">
        <strong>{node.name}</strong>
        <span>{isLed ? `BCM ${node.bcm}` : `${node.payload ? "HIGH" : "LOW"} · BCM ${node.bcm}`}</span>
      </div>
      {!isLed && (
        <button type="button" className="nr-port out" data-port="out" aria-label="Output port" onClick={(e) => { e.stopPropagation(); onPortOut(); }} />
      )}
    </div>
  );
}
