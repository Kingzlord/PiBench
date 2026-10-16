import {
  BCM_TO_PHYSICAL,
  PHYSICAL_TO_BCM,
  PIN_BY_PHYS,
  isGpioPin,
} from "../data/pins";

export type LedColor = "red" | "green" | "amber" | "blue";

export interface Wire {
  id: string;
  a: string;
  b: string;
  color: string;
}

export interface LedPart {
  id: string;
  type: "led";
  color: LedColor;
  anode: string;
  cathode: string;
}

export interface ResistorPart {
  id: string;
  type: "resistor";
  ohms: number;
  a: string;
  b: string;
}

export type Part = LedPart | ResistorPart;

export interface PinDrive {
  dir: "IN" | "OUT";
  high: boolean;
  /** PWM duty cycle 0–100. Omitted for a steady digital level. */
  duty?: number;
}

export type DriveMap = Record<number, PinDrive>;

export type PointVisual = "high" | "low" | "gnd" | "v5" | "v33" | "short" | "idle";

export interface LedReport {
  id: string;
  on: boolean;
  brightness: number;
  detail: string;
  fault: string | null;
  severity: "ok" | "warn" | "error" | "off";
}

export interface Fault {
  id: string;
  severity: "error" | "warn";
  message: string;
}

export interface Analysis {
  leds: LedReport[];
  faults: Fault[];
  pointState: Record<string, PointVisual>;
  pinVoltage: Record<number, 0 | 1 | null>;
  outputs: { physical: number; bcm: number; high: boolean; wired: boolean; duty?: number }[];
}

export type PointRef =
  | { kind: "pin"; pin: number }
  | { kind: "hole"; col: number; row: string }
  | { kind: "rail"; side: "top" | "bot"; pol: "pos" | "neg"; index: number };

export const BB_COLS = 20;
export const BB_ROWS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] as const;

export const LED_META: Record<LedColor, { hex: string; label: string; vf: number }> = {
  red: { hex: "#ff3b3b", label: "Red", vf: 1.8 },
  amber: { hex: "#ffbf2a", label: "Amber", vf: 2.0 },
  green: { hex: "#3ddc6e", label: "Green", vf: 2.1 },
  blue: { hex: "#4da3ff", label: "Blue", vf: 2.6 },
};

export function pointId(p: PointRef): string {
  if (p.kind === "pin") return `pin-${p.pin}`;
  if (p.kind === "hole") return `h-${p.col}-${p.row}`;
  return `r-${p.side}-${p.pol}-${p.index}`;
}

export function parsePointId(id: string): PointRef | null {
  if (id.startsWith("pin-")) {
    const pin = Number(id.slice(4));
    if (!Number.isInteger(pin)) return null;
    return { kind: "pin", pin };
  }
  if (id.startsWith("h-")) {
    const [, col, row] = id.split("-");
    return { kind: "hole", col: Number(col), row };
  }
  if (id.startsWith("r-")) {
    const [, side, pol, index] = id.split("-");
    if ((side === "top" || side === "bot") && (pol === "pos" || pol === "neg")) {
      return { kind: "rail", side, pol, index: Number(index) };
    }
  }
  return null;
}

export function electricalNode(p: PointRef): string {
  if (p.kind === "pin") return `pin-${p.pin}`;
  if (p.kind === "rail") return `rail-${p.side}-${p.pol}`;
  if ("abcde".includes(p.row)) return `t-${p.col}`;
  return `b-${p.col}`;
}

export function describePoint(id: string): string {
  const p = parsePointId(id);
  if (!p) return id;
  if (p.kind === "pin") {
    const def = PIN_BY_PHYS[p.pin];
    return def ? `physical pin ${p.pin} (${def.name})` : `physical pin ${p.pin}`;
  }
  if (p.kind === "hole") return `row ${p.row.toUpperCase()}, column ${p.col}`;
  const pol = p.pol === "pos" ? "+" : "−";
  return `${p.side} ${pol} rail`;
}

export function holeNode(id: string): string | null {
  const p = parsePointId(id);
  if (!p || p.kind !== "hole") return null;
  return electricalNode(p);
}

class UnionFind {
  parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x)!;
    if (p !== x) {
      const r = this.find(p);
      this.parent.set(x, r);
      return r;
    }
    return x;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const GND = [6, 9, 14, 20, 25, 30, 34, 39];
const V5 = [2, 4];
const V33 = [1, 17];

type Driver =
  | { kind: "gnd" }
  | { kind: "v5" }
  | { kind: "v33" }
  | { kind: "gpio"; pin: number; high: boolean };

interface Resolved {
  v: number | null;
  short: boolean;
}

function resolveDrivers(list: Driver[] | undefined): Resolved {
  if (!list || list.length === 0) return { v: null, short: false };
  let has0 = false;
  let has33 = false;
  let has5 = false;
  for (const d of list) {
    if (d.kind === "gnd" || (d.kind === "gpio" && !d.high)) has0 = true;
    if (d.kind === "v33" || (d.kind === "gpio" && d.high)) has33 = true;
    if (d.kind === "v5") has5 = true;
  }
  const levels = [has0, has33, has5].filter(Boolean).length;
  if (levels > 1) return { v: null, short: true };
  if (has5) return { v: 5, short: false };
  if (has33) return { v: 3.3, short: false };
  if (has0) return { v: 0, short: false };
  return { v: null, short: false };
}

function visualFrom(res: Resolved, fallback: PointVisual = "idle"): PointVisual {
  if (res.short) return "short";
  if (res.v === 5) return "v5";
  if (res.v === 3.3) return "high";
  if (res.v === 0) return fallback === "gnd" ? "gnd" : "low";
  return fallback;
}

export function evaluateCircuit(
  wires: Wire[],
  parts: Part[],
  drive: DriveMap,
  mode: "BOARD" | "BCM" | null = null,
): Analysis {
  const uf = new UnionFind();
  for (let i = 1; i < GND.length; i++) uf.union(`pin-${GND[0]}`, `pin-${GND[i]}`);
  uf.union(`pin-${V5[0]}`, `pin-${V5[1]}`);
  uf.union(`pin-${V33[0]}`, `pin-${V33[1]}`);

  const known: string[] = [`pin-${GND[0]}`, `pin-${V5[0]}`, `pin-${V33[0]}`];

  const link = (a: string, b: string) => {
    const pa = parsePointId(a);
    const pb = parsePointId(b);
    if (!pa || !pb) return;
    const na = electricalNode(pa);
    const nb = electricalNode(pb);
    uf.union(na, nb);
    known.push(na, nb);
  };

  for (const w of wires) link(w.a, w.b);
  for (const part of parts) {
    if (part.type === "resistor") link(part.a, part.b);
    else {
      const na = holeNode(part.anode);
      const nb = holeNode(part.cathode);
      if (na) known.push(na);
      if (nb) known.push(nb);
    }
  }

  const drivers = new Map<string, Driver[]>();
  const add = (node: string, d: Driver) => {
    const r = uf.find(node);
    const list = drivers.get(r) ?? [];
    list.push(d);
    drivers.set(r, list);
  };
  add(`pin-${GND[0]}`, { kind: "gnd" });
  add(`pin-${V5[0]}`, { kind: "v5" });
  add(`pin-${V33[0]}`, { kind: "v33" });
  for (const [key, pin] of Object.entries(drive)) {
    const physical = Number(key);
    if (pin.dir === "OUT") add(`pin-${physical}`, { kind: "gpio", pin: physical, high: pin.high });
  }

  const voltageOf = (node: string): Resolved => resolveDrivers(drivers.get(uf.find(node)));

  const members = (root: string) => known.filter((n) => uf.find(n) === root);
  const gpioOnNet = (root: string) => {
    const pins: number[] = [];
    for (let n = 1; n <= 40; n++) {
      if (!isGpioPin(n)) continue;
      if (uf.find(`pin-${n}`) === root && members(root).includes(`pin-${n}`)) pins.push(n);
    }
    return pins;
  };

  const netWiredBeyond = (node: string) => {
    const root = uf.find(node);
    return known.some((n) => n !== node && uf.find(n) === root);
  };

  const faults: Fault[] = [];
  const seenFault = new Set<string>();
  const pushFault = (f: Fault) => {
    if (seenFault.has(f.id)) return;
    seenFault.add(f.id);
    faults.push(f);
  };

  // Shorts and 5V-on-GPIO
  const seenRoots = new Set<string>();
  for (const node of known) {
    const root = uf.find(node);
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const res = resolveDrivers(drivers.get(root));
    if (!res.short) continue;
    const list = drivers.get(root) ?? [];
    const gpios = list.filter((d): d is Extract<Driver, { kind: "gpio" }> => d.kind === "gpio");
    const has5 = list.some((d) => d.kind === "v5");
    const hasGnd = list.some((d) => d.kind === "gnd" || (d.kind === "gpio" && !d.high));
    const highPins = gpios.filter((g) => g.high).map((g) => g.pin);
    const idBase = [...gpios.map((g) => g.pin), has5 ? "5v" : "", hasGnd ? "gnd" : ""].join("-");
    if (has5 && (gpios.length || gpioOnNet(root).length)) {
      const victim = gpios[0]?.pin ?? gpioOnNet(root)[0];
      pushFault({
        id: `5v-${idBase}-${victim}`,
        severity: "error",
        message: `Danger: a 5V pin (physical 2 or 4) is tied to GPIO physical pin ${victim}. A real Raspberry Pi would be damaged — GPIO pins are 3.3V only. Remove that jumper.`,
      });
    } else if (highPins.length && hasGnd) {
      pushFault({
        id: `short-${idBase}`,
        severity: "error",
        message: `Short circuit: physical pin ${highPins.join(", ")} is driven HIGH (3.3V) and connected to ground. This simulator will not sink destructive current, but a real pin can be damaged.`,
      });
    } else {
      pushFault({
        id: `conflict-${idBase}`,
        severity: "error",
        message: "Conflicting voltages on one breadboard net. Check for a jumper between power and ground, or between a HIGH pin and a LOW pin.",
      });
    }
  }

  const pointState: Record<string, PointVisual> = {};
  for (let n = 1; n <= 40; n++) {
    const def = PIN_BY_PHYS[n];
    const res = voltageOf(`pin-${n}`);
    if (res.short) pointState[`pin-${n}`] = "short";
    else if (def.group === "power5") pointState[`pin-${n}`] = "v5";
    else if (def.group === "power3") pointState[`pin-${n}`] = "v33";
    else if (def.group === "ground") pointState[`pin-${n}`] = "gnd";
    else if (drive[n]?.dir === "OUT" && drive[n].high) pointState[`pin-${n}`] = "high";
    else if (drive[n]?.dir === "OUT") pointState[`pin-${n}`] = "low";
    else if (res.v === 3.3) pointState[`pin-${n}`] = "high";
    else if (res.v === 0 && netWiredBeyond(`pin-${n}`)) pointState[`pin-${n}`] = "low";
    else pointState[`pin-${n}`] = "idle";
  }

  for (let col = 1; col <= BB_COLS; col++) {
    for (const row of BB_ROWS) {
      const id = `h-${col}-${row}`;
      const node = electricalNode({ kind: "hole", col, row });
      if (!known.includes(node) && !known.some((n) => n === node)) {
        // strip node is known only if something referenced it
      }
      if (!known.includes(node)) continue;
      const res = voltageOf(node);
      const vis = visualFrom(res, res.v === 0 ? "gnd" : "idle");
      if (vis !== "idle") pointState[id] = vis === "low" && res.v === 0 ? "gnd" : vis;
      if (res.v === 3.3) pointState[id] = "high";
      if (res.v === 5) pointState[id] = "v5";
      if (res.short) pointState[id] = "short";
    }
    for (const side of ["top", "bot"] as const) {
      for (const pol of ["pos", "neg"] as const) {
        const node = `rail-${side}-${pol}`;
        if (!known.includes(node)) continue;
        const res = voltageOf(node);
        const vis: PointVisual = res.short
          ? "short"
          : res.v === 5
            ? "v5"
            : res.v === 3.3
              ? "high"
              : res.v === 0
                ? "gnd"
                : "idle";
        if (vis === "idle") continue;
        for (let i = 0; i < BB_COLS; i++) pointState[`r-${side}-${pol}-${i}`] = vis;
      }
    }
  }

  const pinVoltage: Record<number, 0 | 1 | null> = {};
  for (let n = 1; n <= 40; n++) {
    const res = voltageOf(`pin-${n}`);
    if (res.short || res.v === null) pinVoltage[n] = null;
    else pinVoltage[n] = res.v >= 2 ? 1 : 0;
  }

  const outputs = Object.entries(drive)
    .filter(([, d]) => d.dir === "OUT")
    .map(([k, d]) => {
      const physical = Number(k);
      return {
        physical,
        bcm: PHYSICAL_TO_BCM[physical] ?? -1,
        high: d.high || (typeof d.duty === "number" && d.duty > 0),
        wired: netWiredBeyond(`pin-${physical}`),
        duty: typeof d.duty === "number" ? d.duty : undefined,
      };
    });

  const leds: LedReport[] = parts.filter((p): p is LedPart => p.type === "led").map((led) => {
    const anodeNode = holeNode(led.anode);
    const cathodeNode = holeNode(led.cathode);
    if (!anodeNode || !cathodeNode) {
      return {
        id: led.id,
        on: false,
        brightness: 0,
        detail: "LED is not seated on the breadboard.",
        fault: "LED is not seated on the breadboard.",
        severity: "error" as const,
      };
    }
    if (uf.find(anodeNode) === uf.find(cathodeNode)) {
      const msg = "LED legs share the same breadboard strip, so the LED is shorted. Move one leg across the center gap or to another column.";
      pushFault({ id: `led-short-${led.id}`, severity: "error", message: msg });
      return { id: led.id, on: false, brightness: 0, detail: msg, fault: msg, severity: "error" as const };
    }
    const va = voltageOf(anodeNode);
    const vc = voltageOf(cathodeNode);
    const anodePins = gpioOnNet(uf.find(anodeNode));
    const cathodePins = gpioOnNet(uf.find(cathodeNode));
    const anodeSrc = describeSources(drivers.get(uf.find(anodeNode)) ?? [], anodePins);
    const cathodeSrc = describeSources(drivers.get(uf.find(cathodeNode)) ?? [], cathodePins);

    if (va.short || vc.short) {
      const msg = "This LED is on a shorted net, so it stays off.";
      return { id: led.id, on: false, brightness: 0, detail: msg, fault: msg, severity: "error" as const };
    }

    const vf = LED_META[led.color].vf;
    if (typeof vc.v === "number" && typeof va.v === "number" && vc.v - va.v > vf - 0.2) {
      const msg = `${LED_META[led.color].label} LED is wired backwards. The anode (+) must face the GPIO or 3.3V pin and the cathode (−) must face GND.`;
      pushFault({ id: `backwards-${led.id}`, severity: "error", message: msg });
      return { id: led.id, on: false, brightness: 0, detail: msg, fault: msg, severity: "error" as const };
    }

    const forward =
      typeof va.v === "number" && typeof vc.v === "number" && va.v - vc.v >= Math.min(vf, 2.4);
    if (forward) {
      const hasRes = parts.some(
        (p) => p.type === "resistor" && uf.find(holeNode(p.a) ?? "") === uf.find(anodeNode),
      );
      let detail = `ON · anode ${anodeSrc}, cathode ${cathodeSrc}.`;
      let severity: LedReport["severity"] = "ok";
      let fault: string | null = null;
      if (!hasRes) {
        fault = `${LED_META[led.color].label} LED is lit with no series resistor. On real hardware add 220–330Ω so the GPIO pin stays under about 16mA.`;
        detail += " No series resistor.";
        severity = "warn";
        pushFault({ id: `no-resistor-${led.id}`, severity: "warn", message: fault });
      }
      let dutyScale = 1;
      let pwmNote = "";
      for (const pin of anodePins) {
        const driven = drive[pin];
        if (driven?.dir === "OUT" && typeof driven.duty === "number") {
          dutyScale = driven.duty / 100;
          pwmNote = `PWM ${Math.round(driven.duty)}% on physical pin ${pin}`;
        }
      }
      if (pwmNote && dutyScale <= 0.01) {
        return {
          id: led.id,
          on: false,
          brightness: 0,
          detail: `OFF · ${pwmNote}. Duty cycle is 0%.`,
          fault: null,
          severity: "off" as const,
        };
      }
      const brightness = (va.v === 5 ? 1 : 0.85) * dutyScale;
      if (pwmNote) detail += ` ${pwmNote}.`;
      return { id: led.id, on: brightness > 0.02, brightness, detail, fault, severity };
    }

    let detail = "OFF";
    let severity: LedReport["severity"] = "off";
    let fault: string | null = null;
    if (va.v === null) {
      detail = "OFF · anode is floating. Jumper a GPIO pin or 3.3V to the anode's row.";
    } else if (vc.v === null) {
      detail = "OFF · cathode is not connected to ground. Jumper the cathode row to a GND pin or the − rail.";
      fault = `${LED_META[led.color].label} LED cathode is not grounded, so it cannot light.`;
      severity = "warn";
      pushFault({ id: `nocath-${led.id}`, severity: "warn", message: fault });
    } else if (va.v === 0) {
      detail = `OFF · anode is at 0V (${anodeSrc}). Drive that pin HIGH.`;
    } else {
      detail = `OFF · not enough voltage (${String(va.v)}V → ${String(vc.v)}V).`;
    }
    if (anodePins.length) detail += ` Anode row touches pin ${anodePins.join(", ")}.`;
    return { id: led.id, on: false, brightness: 0, detail, fault, severity };
  });

  for (const out of outputs) {
    if (!out.high) continue;
    const ledOnPin = leds.some((report) => {
      const led = parts.find((p) => p.id === report.id) as LedPart | undefined;
      if (!led) return false;
      const node = holeNode(led.anode);
      return node ? uf.find(node) === uf.find(`pin-${out.physical}`) : false;
    });
    if (ledOnPin) continue;
    if (!out.wired) {
      const elsewhere = new Set<number>();
      for (const part of parts) {
        if (part.type !== "led") continue;
        const node = holeNode(part.anode);
        if (!node) continue;
        for (const pin of gpioOnNet(uf.find(node))) elsewhere.add(pin);
      }
      const others = [...elsewhere].filter((p) => p !== out.physical);
      let message = `Physical pin ${out.physical} (BCM ${out.bcm}) is HIGH, but nothing is wired to it.`;
      if (others.length) {
        message += ` An LED is wired to physical pin ${others.join(", ")} instead — move that jumper to pin ${out.physical}.`;
      }
      pushFault({ id: `noload-${out.physical}`, severity: "warn", message });
      continue;
    }
    const other = parts.find((p): p is LedPart => {
      if (p.type !== "led") return false;
      const node = holeNode(p.anode);
      return !!node && uf.find(node) !== uf.find(`pin-${out.physical}`);
    });
    let message = `Physical pin ${out.physical} (BCM ${out.bcm}) is HIGH, but no LED anode is on that net.`;
    if (other) {
      const node = holeNode(other.anode);
      const pins = node ? gpioOnNet(uf.find(node)) : [];
      if (pins.length) message += ` Your LED anode is wired to physical pin ${pins.join(", ")} instead.`;
    }
    if (mode === "BCM") {
      const maybeBoard = out.bcm;
      if (maybeBoard >= 1 && maybeBoard <= 40 && maybeBoard !== out.physical) {
        message += ` Hint: channel ${out.bcm} in BCM mode is physical pin ${out.physical}, not physical pin ${out.bcm}.`;
      }
    }
    if (mode === "BOARD") {
      const asIfBcm = BCM_TO_PHYSICAL[out.physical];
      if (asIfBcm && asIfBcm !== out.physical) {
        const ledOnBcmPin = parts.some((p) => {
          if (p.type !== "led") return false;
          const node = holeNode(p.anode);
          return !!node && uf.find(node) === uf.find(`pin-${asIfBcm}`);
        });
        if (ledOnBcmPin) {
          message += ` Hint: GPIO.BOARD pin ${out.physical} is the physical pin, not BCM ${out.physical} (that would be physical pin ${asIfBcm}).`;
        }
      }
    }
    pushFault({ id: `miswire-${out.physical}`, severity: "warn", message });
  }

  return { leds, faults, pointState, pinVoltage, outputs };
}

function describeSources(list: Driver[], gpioPins: number[]): string {
  const bits: string[] = [];
  if (list.some((d) => d.kind === "v5")) bits.push("5V");
  if (list.some((d) => d.kind === "v33")) bits.push("3.3V");
  if (list.some((d) => d.kind === "gnd")) bits.push("GND");
  for (const d of list) {
    if (d.kind === "gpio") bits.push(`pin ${d.pin} ${d.high ? "HIGH" : "LOW"}`);
  }
  for (const p of gpioPins) {
    if (!bits.some((b) => b.includes(`pin ${p}`))) bits.push(`pin ${p}`);
  }
  return bits.length ? bits.join(", ") : "floating";
}

export function resistorBands(ohms: number): string[] {
  if (ohms === 220) return ["#e23b3b", "#e23b3b", "#8d5a32", "#d4af37"];
  if (ohms === 330) return ["#f08a24", "#f08a24", "#8d5a32", "#d4af37"];
  if (ohms === 1000) return ["#8d5a32", "#1a1a1a", "#e23b3b", "#d4af37"];
  return ["#1a1a1a", "#1a1a1a", "#1a1a1a", "#d4af37"];
}
