import { BB_COLS, BB_ROWS, type PointVisual } from "../sim/circuit";

interface BreadboardProps {
  pointState: Record<string, PointVisual>;
  selected: string | null;
  onPoint: (id: string) => void;
}

export function Breadboard({ pointState, selected, onPoint }: BreadboardProps) {
  return (
    <div className="bb">
      <div className="bb-title">
        <span>Solderless breadboard</span>
        <em>a–e share a column · center gap · f–j share a column</em>
      </div>
      <Rail side="top" pol="pos" pointState={pointState} selected={selected} onPoint={onPoint} />
      <Rail side="top" pol="neg" pointState={pointState} selected={selected} onPoint={onPoint} />
      <div className="bb-nums">
        <span />
        {Array.from({ length: BB_COLS }, (_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <div className="bb-block">
        {BB_ROWS.slice(0, 5).map((row) => (
          <HoleRow key={row} row={row} pointState={pointState} selected={selected} onPoint={onPoint} />
        ))}
      </div>
      <div className="bb-groove">
        <span>not connected</span>
      </div>
      <div className="bb-block">
        {BB_ROWS.slice(5).map((row) => (
          <HoleRow key={row} row={row} pointState={pointState} selected={selected} onPoint={onPoint} />
        ))}
      </div>
      <Rail side="bot" pol="neg" pointState={pointState} selected={selected} onPoint={onPoint} />
      <Rail side="bot" pol="pos" pointState={pointState} selected={selected} onPoint={onPoint} />
    </div>
  );
}

function Rail({
  side,
  pol,
  pointState,
  selected,
  onPoint,
}: {
  side: "top" | "bot";
  pol: "pos" | "neg";
  pointState: Record<string, PointVisual>;
  selected: string | null;
  onPoint: (id: string) => void;
}) {
  return (
    <div className={`rail rail-${pol}`}>
      <span className="rail-mark">{pol === "pos" ? "+" : "−"}</span>
      {Array.from({ length: BB_COLS }, (_, i) => {
        const id = `r-${side}-${pol}-${i}`;
        const vis = pointState[id] ?? "idle";
        return (
          <button
            key={id}
            type="button"
            data-point={id}
            className={`hole rail-hole vis-${vis} ${selected === id ? "is-selected" : ""}`}
            aria-label={`${side} ${pol === "pos" ? "positive" : "negative"} rail hole ${i + 1}`}
            onClick={() => onPoint(id)}
          >
            <i />
          </button>
        );
      })}
    </div>
  );
}

function HoleRow({
  row,
  pointState,
  selected,
  onPoint,
}: {
  row: string;
  pointState: Record<string, PointVisual>;
  selected: string | null;
  onPoint: (id: string) => void;
}) {
  return (
    <div className="hole-row">
      <span className="row-letter">{row}</span>
      {Array.from({ length: BB_COLS }, (_, i) => {
        const col = i + 1;
        const id = `h-${col}-${row}`;
        const vis = pointState[id] ?? "idle";
        return (
          <button
            key={id}
            type="button"
            data-point={id}
            className={`hole vis-${vis} ${selected === id ? "is-selected" : ""}`}
            aria-label={`Breadboard ${row}${col}`}
            title={`${row.toUpperCase()}${col}`}
            onClick={() => onPoint(id)}
          >
            <i />
          </button>
        );
      })}
    </div>
  );
}
