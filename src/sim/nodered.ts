import { BCM_TO_PHYSICAL, PIN_BY_PHYS } from "../data/pins";

export type FlowKind = "inject-high" | "inject-low" | "led";

export interface FlowNode {
  id: string;
  kind: FlowKind;
  x: number;
  y: number;
  name: string;
  /** Payload sent by an inject node, or ignored on an LED node. */
  payload: 0 | 1;
  /** BCM GPIO number this node targets. */
  bcm: number;
}

export interface FlowWire {
  id: string;
  from: string;
  to: string;
}

export interface FlowWrite {
  bcm: number;
  physical: number;
  high: boolean;
  ledId: string;
  ledName: string;
}

export interface FlowRun {
  ok: boolean;
  error?: string;
  warnings: string[];
  writes: FlowWrite[];
  summary: string;
}

export const PRELOAD_NODES: FlowNode[] = [
  { id: "inj-high", kind: "inject-high", x: 36, y: 78, name: "Input HIGH", payload: 1, bcm: 4 },
  { id: "inj-low", kind: "inject-low", x: 36, y: 198, name: "Input LOW", payload: 0, bcm: 4 },
  { id: "led-out", kind: "led", x: 292, y: 128, name: "LED Output", payload: 0, bcm: 4 },
];

export const PRELOAD_WIRES: FlowWire[] = [
  { id: "wire-high", from: "inj-high", to: "led-out" },
  { id: "wire-low", from: "inj-low", to: "led-out" },
];

export function physicalForBcm(bcm: number): number | null {
  const physical = BCM_TO_PHYSICAL[bcm];
  if (!physical || PIN_BY_PHYS[physical]?.bcm !== bcm) return null;
  return physical;
}

export function connectError(from: FlowNode, to: FlowNode, wires: FlowWire[]): string | null {
  if (from.id === to.id) return "A node cannot connect to itself.";
  if (from.kind === "led") return "LED Output has no output port. Connect an input node to it.";
  if (to.kind !== "led") return "Input nodes only send. Connect them to an LED Output.";
  if (wires.some((w) => w.from === from.id && w.to === to.id)) return "Those nodes are already connected.";
  return null;
}

/** Execute one inject node through its wires. Does not touch hardware itself. */
export function runInject(nodes: FlowNode[], wires: FlowWire[], injectId: string): FlowRun {
  const src = nodes.find((n) => n.id === injectId);
  if (!src) return { ok: false, error: "That node is not on the flow.", warnings: [], writes: [], summary: "" };
  if (src.kind === "led") {
    return {
      ok: false,
      error: "LED Output receives values. Click Input HIGH or Input LOW to send a level.",
      warnings: [],
      writes: [],
      summary: "",
    };
  }
  const links = wires.filter((w) => w.from === src.id);
  if (!links.length) {
    return {
      ok: false,
      error: `${src.name} is not connected. Draw a wire to LED Output — the GPIO pin was not changed.`,
      warnings: [],
      writes: [],
      summary: "",
    };
  }
  const warnings: string[] = [];
  const writes: FlowWrite[] = [];
  for (const link of links) {
    const led = nodes.find((n) => n.id === link.to);
    if (!led || led.kind !== "led") {
      warnings.push("A wire does not end at an LED Output and was ignored.");
      continue;
    }
    const bcm = led.bcm;
    const physical = physicalForBcm(bcm);
    if (physical == null) {
      warnings.push(`${led.name} is set to BCM ${bcm}, which is not a GPIO on this header.`);
      continue;
    }
    if (src.bcm !== led.bcm) {
      warnings.push(
        `${src.name} targets BCM ${src.bcm}, but ${led.name} drives BCM ${led.bcm} (physical pin ${physical}). The LED node pin is the one written.`,
      );
    }
    writes.push({
      bcm,
      physical,
      high: src.payload === 1,
      ledId: led.id,
      ledName: led.name,
    });
  }
  if (!writes.length) {
    return {
      ok: false,
      error: warnings[0] ?? "The message did not reach a valid LED Output. GPIO was not changed.",
      warnings,
      writes: [],
      summary: "",
    };
  }
  const first = writes[0];
  const summary = `${src.name} sent ${src.payload === 1 ? "HIGH" : "LOW"} → ${writes
    .map((w) => `BCM ${w.bcm} / physical pin ${w.physical} ${w.high ? "HIGH" : "LOW"}`)
    .join(", ")}`;
  return { ok: true, warnings, writes, summary, error: first ? undefined : "No write" };
}
