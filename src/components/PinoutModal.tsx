import { GROUP_COLOR, GROUP_LABEL, PINS, type PinGroup } from "../data/pins";

export function PinoutModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-back" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-labelledby="pinout-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <p className="eyebrow">Raspberry Pi 3 Model B</p>
            <h2 id="pinout-title">40-pin header</h2>
          </div>
          <button className="ghost" onClick={onClose} type="button">
            Close
          </button>
        </header>
        <p className="modal-lead">
          Viewed from above with the header on the right, pin 1 is the top inner pin. Odd pins are the
          left column. Even pins are the right, outer column. <code>GPIO.BOARD</code> uses these physical
          numbers. <code>GPIO.BCM</code> uses the Broadcom GPIO number.
        </p>
        <div className="legend-row">
          {(Object.keys(GROUP_LABEL) as PinGroup[]).map((g) => (
            <span key={g}>
              <i style={{ background: GROUP_COLOR[g] }} />
              {GROUP_LABEL[g]}
            </span>
          ))}
        </div>
        <div className="pin-table-wrap">
          <table className="pin-table">
            <thead>
              <tr>
                <th>Pin</th>
                <th>Name</th>
                <th>BCM</th>
                <th>Function</th>
                <th>Pin</th>
                <th>Name</th>
                <th>BCM</th>
                <th>Function</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 20 }, (_, i) => {
                const left = PINS[i * 2];
                const right = PINS[i * 2 + 1];
                return (
                  <tr key={left.physical}>
                    <PinCells pin={left} />
                    <PinCells pin={right} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function PinCells({ pin }: { pin: (typeof PINS)[number] }) {
  return (
    <>
      <td className="num">
        <i style={{ background: GROUP_COLOR[pin.group] }} />
        {pin.physical}
      </td>
      <td>{pin.name}</td>
      <td className="mono">{pin.bcm ?? "—"}</td>
      <td>{pin.func}</td>
    </>
  );
}
