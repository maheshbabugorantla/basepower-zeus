// Artwork geometry for the intro reel's engraved plates (public/intro/*.webp).
// These are pixel boxes measured on the art itself, not data: each window's
// [x, y, w, h] on the street plate, grouped by house, and the battery status
// light on the porch plate.

export type Box = readonly [number, number, number, number];

export const STREET = { w: 1284, h: 676 } as const;
export const PORCH = { w: 1244, h: 637 } as const;

/** windows of each house on the street plate, left to right */
export const STREET_HOUSES: ReadonlyArray<ReadonlyArray<Box>> = [
  [[61, 447, 14, 28], [77, 447, 14, 28], [185, 448, 25, 26], [239, 448, 10, 27]],
  [[331, 446, 16, 28], [420, 446, 15, 29], [436, 446, 15, 29], [478, 447, 7, 26]],
  [[581, 444, 15, 29], [597, 444, 16, 29], [683, 445, 32, 28]],
  [[803, 455, 5, 8], [838, 446, 15, 28], [855, 445, 15, 29], [928, 444, 29, 26]],
  [[1008, 458, 8, 12], [1044, 446, 10, 29], [1083, 446, 16, 28], [1099, 446, 16, 27]],
  [[1201, 445, 14, 29], [1216, 445, 14, 29]],
];

/** the house that keeps its lights */
export const LIT_HOUSE = 2;

/** order in which the other houses go dark: outer houses first, closing in on the lit one */
export const DARK_ORDER: ReadonlyArray<number> = [0, 2, 0, 4, 3, 1];

/** the battery's status light on the porch plate */
export const PORCH_BATTERY_LIGHT: Box = [206, 372, 9, 11];

export const INTRO_ASSETS = {
  streetInk: "/intro/street-ink.webp",
  streetGold: "/intro/street-gold.webp",
  porchInk: "/intro/porch-ink.webp",
  porchGold: "/intro/porch-gold.webp",
} as const;
