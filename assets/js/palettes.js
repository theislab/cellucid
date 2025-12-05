// Color utilities and predefined palettes for categorical and continuous fields.
export function rgbToCss(color) {
  const r = Math.round(color[0] * 255);
  const g = Math.round(color[1] * 255);
  const b = Math.round(color[2] * 255);
  return `rgb(${r}, ${g}, ${b})`;
}

function makeColormapSampler(stops) {
  return (t) => {
    const clamped = Math.max(0, Math.min(1, t));
    const n = stops.length - 1;
    const x = clamped * n;
    const i0 = Math.floor(x);
    const i1 = Math.min(n, i0 + 1);
    const f = x - i0;
    const c0 = stops[i0];
    const c1 = stops[i1];
    return [
      c0[0] + (c1[0] - c0[0]) * f,
      c0[1] + (c1[1] - c0[1]) * f,
      c0[2] + (c1[2] - c0[2]) * f
    ];
  };
}

export const VIRIDIS_COLORS = [
  [0.267, 0.004, 0.329],
  [0.283, 0.141, 0.458],
  [0.254, 0.265, 0.530],
  [0.207, 0.372, 0.553],
  [0.164, 0.471, 0.558],
  [0.128, 0.567, 0.551],
  [0.135, 0.659, 0.518],
  [0.267, 0.749, 0.441],
  [0.478, 0.821, 0.318],
  [0.741, 0.873, 0.150]
];

const PLASMA_COLORS = [
  [0.051, 0.031, 0.529],
  [0.357, 0.008, 0.639],
  [0.604, 0.090, 0.608],
  [0.796, 0.275, 0.475],
  [0.882, 0.392, 0.384],
  [0.988, 0.651, 0.212],
  [0.941, 0.976, 0.129]
];

const INFERNO_COLORS = [
  [0.000, 0.000, 0.016],
  [0.122, 0.047, 0.282],
  [0.294, 0.059, 0.420],
  [0.471, 0.110, 0.427],
  [0.647, 0.173, 0.376],
  [0.812, 0.267, 0.275],
  [0.929, 0.412, 0.145],
  [0.984, 0.608, 0.024],
  [0.969, 0.820, 0.239],
  [0.988, 1.000, 0.643]
];

const MAGMA_COLORS = [
  [0.000, 0.000, 0.016],
  [0.106, 0.047, 0.255],
  [0.310, 0.047, 0.420],
  [0.510, 0.149, 0.506],
  [0.710, 0.212, 0.478],
  [0.898, 0.349, 0.392],
  [0.984, 0.529, 0.380],
  [0.996, 0.690, 0.471],
  [0.996, 0.863, 0.549],
  [0.988, 0.992, 0.749]
];

const CIVIDIS_COLORS = [
  [0.000, 0.125, 0.298],
  [0.173, 0.173, 0.486],
  [0.271, 0.306, 0.522],
  [0.400, 0.435, 0.498],
  [0.541, 0.592, 0.459],
  [0.678, 0.780, 0.435],
  [0.847, 0.937, 0.439],
  [0.976, 0.973, 0.443]
];

const COOLWARM_COLORS = [
  [0.231, 0.298, 0.753],
  [0.359, 0.474, 0.898],
  [0.583, 0.684, 0.937],
  [0.817, 0.858, 0.898],
  [0.965, 0.965, 0.965],
  [0.898, 0.767, 0.690],
  [0.844, 0.537, 0.402],
  [0.820, 0.255, 0.239],
  [0.706, 0.016, 0.015]
];

const BLUE_RED_COLORS = [
  [0.000, 0.000, 0.500],
  [0.000, 0.000, 1.000],
  [1.000, 1.000, 1.000],
  [1.000, 0.000, 0.000],
  [0.500, 0.000, 0.000]
];

const HEAT_COLORS = [
  [0.000, 0.000, 0.000],
  [0.500, 0.000, 0.000],
  [0.900, 0.400, 0.000],
  [1.000, 0.800, 0.000],
  [1.000, 1.000, 1.000]
];

const JET_COLORS = [
  [0.000, 0.000, 0.500],
  [0.000, 0.000, 1.000],
  [0.000, 1.000, 1.000],
  [1.000, 1.000, 0.000],
  [1.000, 0.000, 0.000],
  [0.500, 0.000, 0.000]
];

function buildColormap(id, label, colors) {
  return {
    id,
    label,
    colors,
    cssStops: colors.map(rgbToCss),
    sample: makeColormapSampler(colors)
  };
}

export const CONTINUOUS_COLORMAPS = [
  buildColormap('viridis', 'Viridis', VIRIDIS_COLORS),
  buildColormap('plasma', 'Plasma', PLASMA_COLORS),
  buildColormap('inferno', 'Inferno', INFERNO_COLORS),
  buildColormap('magma', 'Magma', MAGMA_COLORS),
  buildColormap('cividis', 'Cividis', CIVIDIS_COLORS),
  buildColormap('coolwarm', 'Coolwarm', COOLWARM_COLORS),
  buildColormap('bluered', 'Blue-Red', BLUE_RED_COLORS),
  buildColormap('heat', 'Heat', HEAT_COLORS),
  buildColormap('jet', 'Jet', JET_COLORS)
];

const COLORMAP_LOOKUP = new Map(CONTINUOUS_COLORMAPS.map((m) => [m.id, m]));
export const DEFAULT_COLORMAP_ID = 'viridis';

export function getColormap(id) {
  return COLORMAP_LOOKUP.get(id) || COLORMAP_LOOKUP.get(DEFAULT_COLORMAP_ID);
}

export function sampleContinuousColormap(id, t) {
  return getColormap(id).sample(t);
}

export function getCssStopsForColormap(id) {
  return getColormap(id).cssStops;
}

export function colormapViridis(t) {
  return sampleContinuousColormap('viridis', t);
}

export const VIRIDIS_CSS_STOPS = getCssStopsForColormap('viridis');

// Color-blind friendly palette mixing Okabe-Ito and Paul Tol tones for academic-looking figures.
export const CATEGORY_PALETTE = [
  [0.000, 0.447, 0.698],
  [0.902, 0.624, 0.000],
  [0.000, 0.620, 0.451],
  [0.835, 0.369, 0.000],
  [0.800, 0.475, 0.655],
  [0.337, 0.706, 0.914],
  [0.941, 0.894, 0.259],
  [0.200, 0.133, 0.533],
  [0.533, 0.800, 0.933],
  [0.067, 0.467, 0.200],
  [0.267, 0.667, 0.600],
  [0.600, 0.600, 0.200],
  [0.867, 0.800, 0.467],
  [0.800, 0.400, 0.467],
  [0.533, 0.133, 0.333],
  [0.667, 0.267, 0.600],
  [0.373, 0.620, 0.627],
  [0.298, 0.298, 0.298],
  [0.702, 0.702, 0.702],
  [0.424, 0.357, 0.482]
];

export const COLOR_PICKER_PALETTE = [
  // Blues
  [0.121, 0.466, 0.705],  // Blue
  [0.255, 0.412, 0.882],  // Royal Blue
  [0.000, 0.749, 1.000],  // Deep Sky Blue
  [0.529, 0.808, 0.922],  // Sky Blue
  [0.000, 0.000, 0.804],  // Medium Blue
  [0.098, 0.098, 0.439],  // Midnight Blue
  // Greens
  [0.172, 0.627, 0.172],  // Forest Green
  [0.000, 0.502, 0.000],  // Green
  [0.196, 0.804, 0.196],  // Lime Green
  [0.565, 0.933, 0.565],  // Light Green
  [0.000, 0.392, 0.000],  // Dark Green
  [0.180, 0.545, 0.341],  // Sea Green
  // Reds/Oranges
  [0.839, 0.152, 0.156],  // Crimson
  [1.000, 0.000, 0.000],  // Red
  [1.000, 0.388, 0.278],  // Tomato
  [1.000, 0.498, 0.314],  // Coral
  [0.863, 0.078, 0.235],  // Crimson
  [0.698, 0.133, 0.133],  // Fire Brick
  // Oranges/Yellows
  [1.000, 0.498, 0.054],  // Orange
  [1.000, 0.647, 0.000],  // Orange
  [1.000, 0.843, 0.000],  // Gold
  [1.000, 1.000, 0.000],  // Yellow
  [0.741, 0.718, 0.420],  // Dark Khaki
  [1.000, 0.894, 0.710],  // Moccasin
  // Purples/Pinks
  [0.580, 0.404, 0.741],  // Medium Purple
  [0.502, 0.000, 0.502],  // Purple
  [0.541, 0.169, 0.886],  // Blue Violet
  [0.933, 0.510, 0.933],  // Violet
  [0.890, 0.467, 0.761],  // Orchid
  [1.000, 0.412, 0.706],  // Hot Pink
  // Browns
  [0.549, 0.337, 0.294],  // Sienna
  [0.824, 0.412, 0.118],  // Chocolate
  [0.627, 0.322, 0.176],  // Sienna
  [0.545, 0.271, 0.075],  // Saddle Brown
  [0.871, 0.722, 0.529],  // Burly Wood
  [0.961, 0.871, 0.702],  // Wheat
  // Grays
  [0.498, 0.498, 0.498],  // Gray
  [0.663, 0.663, 0.663],  // Dark Gray
  [0.827, 0.827, 0.827],  // Light Gray
  [0.412, 0.412, 0.412],  // Dim Gray
  [0.184, 0.310, 0.310],  // Dark Slate Gray
  [0.000, 0.000, 0.000],  // Black
  // Cyans/Teals
  [0.090, 0.745, 0.811],  // Dark Turquoise
  [0.000, 0.808, 0.820],  // Dark Cyan
  [0.251, 0.878, 0.816],  // Turquoise
  [0.000, 1.000, 1.000],  // Cyan
  [0.282, 0.820, 0.800],  // Medium Turquoise
  [0.373, 0.620, 0.627]   // Cadet Blue
];

const GOLDEN_ANGLE_DEGREES = 137.50776405003785;
const EXTENDED_CATEGORY_SEEDS = [...CATEGORY_PALETTE, ...COLOR_PICKER_PALETTE];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hslToRgb01(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h % 1) * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hp < 1) {
    r1 = c; g1 = x; b1 = 0;
  } else if (hp < 2) {
    r1 = x; g1 = c; b1 = 0;
  } else if (hp < 3) {
    r1 = 0; g1 = c; b1 = x;
  } else if (hp < 4) {
    r1 = 0; g1 = x; b1 = c;
  } else if (hp < 5) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  const m = l - c / 2;
  return [r1 + m, g1 + m, b1 + m];
}

// Returns a distinct-looking color for the provided category index. Uses the base
// palette first, then fans out around the color wheel using the golden angle to
// avoid obvious repeats when there are many categories.
export function getCategoryColor(idx) {
  if (idx < EXTENDED_CATEGORY_SEEDS.length) {
    return EXTENDED_CATEGORY_SEEDS[idx];
  }
  const offset = idx - EXTENDED_CATEGORY_SEEDS.length;
  const hue = ((offset * GOLDEN_ANGLE_DEGREES) % 360) / 360;
  const sat = clamp(0.62 + 0.1 * Math.sin(offset * 0.8), 0.45, 0.82);
  const light = clamp(0.54 + 0.12 * Math.cos(offset * 0.6), 0.38, 0.72);
  return hslToRgb01(hue, sat, light);
}
