export type PinGroup =
  | "power5"
  | "power3"
  | "ground"
  | "i2c"
  | "uart"
  | "spi"
  | "pwm"
  | "gpio"
  | "eeprom";

export interface PinDef {
  physical: number;
  bcm: number | null;
  name: string;
  func: string;
  group: PinGroup;
  warning?: string;
}

export const GROUP_COLOR: Record<PinGroup, string> = {
  power5: "#ff4d4d",
  power3: "#ffb020",
  ground: "#a8b0bd",
  i2c: "#6aa2ff",
  uart: "#e2b340",
  spi: "#c084fc",
  pwm: "#3ddc97",
  gpio: "#7dcca8",
  eeprom: "#94a3b8",
};

export const GROUP_LABEL: Record<PinGroup, string> = {
  power5: "5V power",
  power3: "3.3V power",
  ground: "Ground",
  i2c: "I2C",
  uart: "UART",
  spi: "SPI",
  pwm: "PWM / GPIO",
  gpio: "GPIO",
  eeprom: "HAT EEPROM",
};

/** Physical header, pin 1 at the top of the inner (left) column. */
export const PINS: PinDef[] = [
  { physical: 1, bcm: null, name: "3V3", func: "3.3V power", group: "power3" },
  { physical: 2, bcm: null, name: "5V", func: "5V power", group: "power5" },
  { physical: 3, bcm: 2, name: "SDA", func: "I2C1 SDA · GPIO2", group: "i2c" },
  { physical: 4, bcm: null, name: "5V", func: "5V power", group: "power5" },
  { physical: 5, bcm: 3, name: "SCL", func: "I2C1 SCL · GPIO3", group: "i2c" },
  { physical: 6, bcm: null, name: "GND", func: "Ground", group: "ground" },
  { physical: 7, bcm: 4, name: "GPIO4", func: "GPIO4 · GPCLK0", group: "gpio" },
  { physical: 8, bcm: 14, name: "TXD", func: "UART TXD · GPIO14", group: "uart" },
  { physical: 9, bcm: null, name: "GND", func: "Ground", group: "ground" },
  { physical: 10, bcm: 15, name: "RXD", func: "UART RXD · GPIO15", group: "uart" },
  { physical: 11, bcm: 17, name: "GPIO17", func: "GPIO17", group: "gpio" },
  { physical: 12, bcm: 18, name: "GPIO18", func: "GPIO18 · hardware PWM0", group: "pwm" },
  { physical: 13, bcm: 27, name: "GPIO27", func: "GPIO27", group: "gpio" },
  { physical: 14, bcm: null, name: "GND", func: "Ground", group: "ground" },
  { physical: 15, bcm: 22, name: "GPIO22", func: "GPIO22", group: "gpio" },
  { physical: 16, bcm: 23, name: "GPIO23", func: "GPIO23", group: "gpio" },
  { physical: 17, bcm: null, name: "3V3", func: "3.3V power", group: "power3" },
  { physical: 18, bcm: 24, name: "GPIO24", func: "GPIO24", group: "gpio" },
  { physical: 19, bcm: 10, name: "MOSI", func: "SPI0 MOSI · GPIO10", group: "spi" },
  { physical: 20, bcm: null, name: "GND", func: "Ground", group: "ground" },
  { physical: 21, bcm: 9, name: "MISO", func: "SPI0 MISO · GPIO9", group: "spi" },
  { physical: 22, bcm: 25, name: "GPIO25", func: "GPIO25", group: "gpio" },
  { physical: 23, bcm: 11, name: "SCLK", func: "SPI0 SCLK · GPIO11", group: "spi" },
  { physical: 24, bcm: 8, name: "CE0", func: "SPI0 CE0 · GPIO8", group: "spi" },
  { physical: 25, bcm: null, name: "GND", func: "Ground", group: "ground" },
  { physical: 26, bcm: 7, name: "CE1", func: "SPI0 CE1 · GPIO7", group: "spi" },
  {
    physical: 27,
    bcm: 0,
    name: "ID_SD",
    func: "I2C ID EEPROM SDA · GPIO0",
    group: "eeprom",
    warning: "Reserved for HAT EEPROM. Usable as GPIO0, but a HAT may depend on it.",
  },
  {
    physical: 28,
    bcm: 1,
    name: "ID_SC",
    func: "I2C ID EEPROM SCL · GPIO1",
    group: "eeprom",
    warning: "Reserved for HAT EEPROM. Usable as GPIO1, but a HAT may depend on it.",
  },
  { physical: 29, bcm: 5, name: "GPIO5", func: "GPIO5", group: "gpio" },
  { physical: 30, bcm: null, name: "GND", func: "Ground", group: "ground" },
  { physical: 31, bcm: 6, name: "GPIO6", func: "GPIO6", group: "gpio" },
  { physical: 32, bcm: 12, name: "GPIO12", func: "GPIO12 · hardware PWM0", group: "pwm" },
  { physical: 33, bcm: 13, name: "GPIO13", func: "GPIO13 · hardware PWM1", group: "pwm" },
  { physical: 34, bcm: null, name: "GND", func: "Ground", group: "ground" },
  { physical: 35, bcm: 19, name: "GPIO19", func: "GPIO19 · PWM1 / SPI1 MISO", group: "pwm" },
  { physical: 36, bcm: 16, name: "GPIO16", func: "GPIO16", group: "gpio" },
  { physical: 37, bcm: 26, name: "GPIO26", func: "GPIO26", group: "gpio" },
  { physical: 38, bcm: 20, name: "GPIO20", func: "GPIO20", group: "gpio" },
  { physical: 39, bcm: null, name: "GND", func: "Ground", group: "ground" },
  { physical: 40, bcm: 21, name: "GPIO21", func: "GPIO21", group: "gpio" },
];

export const PIN_BY_PHYS: Record<number, PinDef> = Object.fromEntries(
  PINS.map((p) => [p.physical, p]),
);

export const BCM_TO_PHYSICAL: Record<number, number> = {};
export const PHYSICAL_TO_BCM: Record<number, number> = {};
for (const pin of PINS) {
  if (pin.bcm !== null) {
    BCM_TO_PHYSICAL[pin.bcm] = pin.physical;
    PHYSICAL_TO_BCM[pin.physical] = pin.bcm;
  }
}

export const PIN_ROWS = Array.from({ length: 20 }, (_, i) => ({
  odd: i * 2 + 1,
  even: i * 2 + 2,
}));

export function isGpioPin(physical: number): boolean {
  return PIN_BY_PHYS[physical]?.bcm !== null && PIN_BY_PHYS[physical]?.bcm !== undefined;
}
