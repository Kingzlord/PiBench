import type { Part, Wire } from "../sim/circuit";

export type TemplateId = "single" | "two" | "empty";

export interface Template {
  id: TemplateId;
  name: string;
  practical: string;
  blurb: string;
  code: string;
  wires: Wire[];
  parts: Part[];
}

const PRACTICAL_2 = `import RPi.GPIO as GPIO
import time

GPIO.setwarnings(False)
GPIO.setmode(GPIO.BOARD)
GPIO.setup(7, GPIO.OUT)
time.sleep(5)
GPIO.output(7, True)
GPIO.cleanup()
`;

const PRACTICAL_3 = `import RPi.GPIO as GPIO
import time

GPIO.setwarnings(False)

def blink(pin):
    GPIO.output(pin, True)
    time.sleep(0.1)
    GPIO.output(pin, False)
    time.sleep(0.1)
    return

GPIO.setmode(GPIO.BOARD)
GPIO.setup(18, GPIO.OUT)
GPIO.setup(16, GPIO.OUT)

for i in range(0, 10):
    blink(18)
    blink(16)

GPIO.cleanup()
`;

export const TEMPLATES: Template[] = [
  {
    id: "single",
    name: "Single LED",
    practical: "Practical 2",
    blurb:
      "Drives physical pin 7 (BCM 4) HIGH after 5 seconds, then GPIO.cleanup() releases it. Wire pin 7 to the LED anode and the cathode to GND.",
    code: PRACTICAL_2,
    wires: [
      { id: "s-sig", a: "pin-7", b: "h-3-a", color: "#f5c542" },
      { id: "s-gnd", a: "pin-9", b: "r-bot-neg-1", color: "#2b3038" },
      { id: "s-ret", a: "h-5-j", b: "r-bot-neg-6", color: "#2b3038" },
    ],
    parts: [
      { id: "s-r", type: "resistor", ohms: 330, a: "h-3-c", b: "h-5-c" },
      { id: "s-led", type: "led", color: "red", anode: "h-5-e", cathode: "h-5-f" },
    ],
  },
  {
    id: "two",
    name: "Two LEDs",
    practical: "Practical 3",
    blurb:
      "Blinks physical pin 18 (BCM 24), then physical pin 16 (BCM 23), ten times. The LEDs alternate — the practical does not turn them on together.",
    code: PRACTICAL_3,
    wires: [
      { id: "t-gnd", a: "pin-6", b: "r-bot-neg-0", color: "#2b3038" },
      { id: "t-18", a: "pin-18", b: "h-3-a", color: "#f5c542" },
      { id: "t-18r", a: "h-5-j", b: "r-bot-neg-5", color: "#2b3038" },
      { id: "t-16", a: "pin-16", b: "h-12-a", color: "#f08a24" },
      { id: "t-16r", a: "h-14-j", b: "r-bot-neg-14", color: "#2b3038" },
    ],
    parts: [
      { id: "t-r1", type: "resistor", ohms: 330, a: "h-3-c", b: "h-5-c" },
      { id: "t-led1", type: "led", color: "green", anode: "h-5-e", cathode: "h-5-f" },
      { id: "t-r2", type: "resistor", ohms: 330, a: "h-12-c", b: "h-14-c" },
      { id: "t-led2", type: "led", color: "amber", anode: "h-14-e", cathode: "h-14-f" },
    ],
  },
  {
    id: "empty",
    name: "Empty",
    practical: "Sandbox",
    blurb: "Blank editor. Import RPi.GPIO, choose BOARD or BCM numbering, then wire any GPIO pin to an LED.",
    code: "",
    wires: [],
    parts: [],
  },
];

export function templateById(id: TemplateId): Template {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}
