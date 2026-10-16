import { useState } from "react";
import { GROUP_COLOR, PIN_BY_PHYS, PIN_ROWS } from "../data/pins";
import type { DriveMap, PointVisual } from "../sim/circuit";

interface PiBoardProps {
  drive: DriveMap;
  pointState: Record<string, PointVisual>;
  selected: string | null;
  running: boolean;
  onPoint: (id: string) => void;
}

export function PiBoard({ drive, pointState, selected, running, onPoint }: PiBoardProps) {
  const [tip, setTip] = useState<{ pin: number; x: number; y: number } | null>(null);
  const tipPin = tip ? PIN_BY_PHYS[tip.pin] : null;
  const tipDrive = tip ? drive[tip.pin] : undefined;

  return (
    <div className="pi-assembly">
      <div className="pi-pcb" aria-hidden>
        <span className="mh" style={{ left: 10, top: 10 }} />
        <span className="mh" style={{ right: 22, top: 10 }} />
        <span className="mh" style={{ left: 10, bottom: 10 }} />
        <span className="mh" style={{ right: 22, bottom: 10 }} />
        <div className="port port-usb-c" title="Micro USB power">
          <b />
          <em>PWR</em>
        </div>
        <div className="port port-hdmi" title="HDMI">
          <b />
          <em>HDMI</em>
        </div>
        <div className="port port-audio" title="3.5 mm audio">
          <b />
          <em>A/V</em>
        </div>
        <div className="flex-conn cam">
          <span>CAMERA</span>
        </div>
        <div className="soc">
          <strong>BROADCOM</strong>
          <span>BCM2837</span>
        </div>
        <div className="wifi">
          <span>Wi‑Fi / BT</span>
        </div>
        <div className="silk-logo">Raspberry Pi</div>
        <div className="board-leds">
          <span className="smd pwr" title="PWR" />
          <span className={`smd act ${running ? "blink" : ""}`} title="ACT" />
        </div>
        <div className="flex-conn dsi">
          <span>DISPLAY</span>
        </div>
        <div className="sd-card">microSD</div>
        <div className="usb-stack" title="USB 2.0">
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="ethernet" title="Ethernet">
          <b />
          <span className={running ? "link on" : "link"} />
        </div>
        <div className="model-silk">3 Model B</div>
      </div>

      <div className="pinhead">
        <div className="pinhead-cap">
          <span>Odd · inner</span>
          <span>Even · outer</span>
        </div>
        {PIN_ROWS.map(({ odd, even }) => (
          <div className="pin-row" key={odd}>
            <PinLabel physical={odd} side="odd" />
            <PinButton
              physical={odd}
              selected={selected}
              visual={pointState[`pin-${odd}`] ?? "idle"}
              duty={drive[odd]?.duty}
              onPoint={onPoint}
              onTip={setTip}
            />
            <PinButton
              physical={even}
              selected={selected}
              visual={pointState[`pin-${even}`] ?? "idle"}
              duty={drive[even]?.duty}
              onPoint={onPoint}
              onTip={setTip}
            />
            <PinLabel physical={even} side="even" />
          </div>
        ))}
      </div>

      {tip && tipPin && (
        <div className="pin-tip" style={{ left: tip.x + 14, top: tip.y + 16 }}>
          <strong>
            Physical pin {tipPin.physical}
            {tipPin.physical === 1 ? " · pin 1" : ""}
          </strong>
          <span>
            {tipPin.bcm !== null ? `BCM GPIO ${tipPin.bcm}` : "Not a GPIO"} · {tipPin.func}
          </span>
          <span>
            {tipDrive
              ? tipDrive.dir === "OUT" && typeof tipDrive.duty === "number"
                ? `Output · PWM ${Math.round(tipDrive.duty)}%`
                : `${tipDrive.dir === "OUT" ? "Output" : "Input"} · ${tipDrive.high ? "HIGH 3.3V" : "LOW 0V"}`
              : tipPin.group === "power5"
                ? "Always 5V while powered"
                : tipPin.group === "power3"
                  ? "Always 3.3V while powered"
                  : tipPin.group === "ground"
                    ? "Ground"
                    : "Not driven"}
          </span>
          {tipPin.warning && <em>{tipPin.warning}</em>}
        </div>
      )}
    </div>
  );
}

function PinLabel({ physical, side }: { physical: number; side: "odd" | "even" }) {
  const pin = PIN_BY_PHYS[physical];
  return (
    <div className={`pin-lab ${side}`} style={{ color: side === "even" ? GROUP_COLOR[pin.group] : undefined }}>
      <i style={{ background: GROUP_COLOR[pin.group] }} />
      {side === "odd" ? (
        <>
          <b>{physical}</b> {pin.name}
        </>
      ) : (
        <>
          {pin.name} <b>{physical}</b>
        </>
      )}
    </div>
  );
}

function PinButton({
  physical,
  selected,
  visual,
  duty,
  onPoint,
  onTip,
}: {
  physical: number;
  selected: string | null;
  visual: PointVisual;
  duty?: number;
  onPoint: (id: string) => void;
  onTip: (tip: { pin: number; x: number; y: number } | null) => void;
}) {
  const id = `pin-${physical}`;
  const pin = PIN_BY_PHYS[physical];
  return (
    <button
      type="button"
      className={`pin vis-${visual} ${selected === id ? "is-selected" : ""} ${physical === 1 ? "is-pin1" : ""}`}
      data-point={id}
      aria-label={`Physical pin ${physical}, ${pin.name}`}
      onClick={() => onPoint(id)}
      onMouseEnter={(e) => onTip({ pin: physical, x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => onTip({ pin: physical, x: e.clientX, y: e.clientY })}
      onMouseLeave={() => onTip(null)}
    >
      <i
        style={{
          background: visual === "idle" || visual === "low" ? undefined : GROUP_COLOR[pin.group],
          opacity: typeof duty === "number" ? Math.max(0.28, duty / 100) : undefined,
        }}
      />
    </button>
  );
}
