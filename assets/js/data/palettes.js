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

// Turbo - Google's improved rainbow colormap
const TURBO_COLORS = [
  [0.190, 0.072, 0.232],
  [0.217, 0.163, 0.486],
  [0.213, 0.290, 0.711],
  [0.153, 0.436, 0.871],
  [0.078, 0.570, 0.925],
  [0.063, 0.693, 0.878],
  [0.141, 0.798, 0.753],
  [0.291, 0.873, 0.596],
  [0.478, 0.922, 0.420],
  [0.679, 0.939, 0.273],
  [0.859, 0.918, 0.220],
  [0.962, 0.843, 0.220],
  [0.988, 0.710, 0.190],
  [0.961, 0.561, 0.155],
  [0.892, 0.404, 0.129],
  [0.789, 0.255, 0.118],
  [0.647, 0.108, 0.090]
];

// Spectral - diverging rainbow
const SPECTRAL_COLORS = [
  [0.620, 0.004, 0.259],
  [0.835, 0.243, 0.310],
  [0.957, 0.427, 0.263],
  [0.992, 0.682, 0.380],
  [0.996, 0.878, 0.545],
  [1.000, 1.000, 0.749],
  [0.902, 0.961, 0.596],
  [0.671, 0.867, 0.643],
  [0.400, 0.761, 0.647],
  [0.196, 0.533, 0.741],
  [0.369, 0.310, 0.635]
];

// RdYlBu - Red-Yellow-Blue diverging
const RDYLBU_COLORS = [
  [0.647, 0.000, 0.149],
  [0.843, 0.188, 0.153],
  [0.957, 0.427, 0.263],
  [0.992, 0.682, 0.380],
  [0.996, 0.878, 0.565],
  [1.000, 1.000, 0.749],
  [0.878, 0.953, 0.973],
  [0.671, 0.851, 0.914],
  [0.455, 0.678, 0.820],
  [0.271, 0.459, 0.706],
  [0.192, 0.212, 0.584]
];

// RdBu - Red-Blue diverging
const RDBU_COLORS = [
  [0.404, 0.000, 0.122],
  [0.698, 0.094, 0.169],
  [0.839, 0.376, 0.302],
  [0.957, 0.647, 0.510],
  [0.992, 0.859, 0.780],
  [0.969, 0.969, 0.969],
  [0.820, 0.898, 0.941],
  [0.573, 0.773, 0.871],
  [0.263, 0.576, 0.765],
  [0.129, 0.400, 0.675],
  [0.020, 0.188, 0.380]
];

// PiYG - Pink-Yellow-Green diverging
const PIYG_COLORS = [
  [0.557, 0.004, 0.322],
  [0.773, 0.106, 0.490],
  [0.871, 0.467, 0.682],
  [0.945, 0.714, 0.855],
  [0.992, 0.878, 0.937],
  [0.969, 0.969, 0.969],
  [0.902, 0.961, 0.816],
  [0.722, 0.882, 0.525],
  [0.498, 0.737, 0.255],
  [0.302, 0.573, 0.129],
  [0.153, 0.392, 0.098]
];

// PRGn - Purple-Green diverging
const PRGN_COLORS = [
  [0.251, 0.000, 0.294],
  [0.463, 0.165, 0.514],
  [0.600, 0.439, 0.671],
  [0.761, 0.647, 0.812],
  [0.906, 0.831, 0.910],
  [0.969, 0.969, 0.969],
  [0.851, 0.941, 0.827],
  [0.651, 0.859, 0.627],
  [0.353, 0.682, 0.380],
  [0.106, 0.471, 0.216],
  [0.000, 0.267, 0.106]
];

// BrBG - Brown-Blue-Green diverging
const BRBG_COLORS = [
  [0.329, 0.188, 0.020],
  [0.549, 0.318, 0.039],
  [0.749, 0.506, 0.176],
  [0.875, 0.761, 0.490],
  [0.965, 0.910, 0.765],
  [0.961, 0.961, 0.961],
  [0.780, 0.918, 0.898],
  [0.502, 0.804, 0.757],
  [0.208, 0.592, 0.561],
  [0.004, 0.400, 0.369],
  [0.000, 0.235, 0.188]
];

// YlGnBu - Yellow-Green-Blue sequential
const YLGNBU_COLORS = [
  [1.000, 1.000, 0.851],
  [0.929, 0.973, 0.694],
  [0.780, 0.914, 0.706],
  [0.498, 0.804, 0.733],
  [0.255, 0.714, 0.769],
  [0.114, 0.569, 0.753],
  [0.133, 0.369, 0.659],
  [0.145, 0.204, 0.580],
  [0.031, 0.114, 0.345]
];

// YlOrRd - Yellow-Orange-Red sequential
const YLORRD_COLORS = [
  [1.000, 1.000, 0.800],
  [1.000, 0.929, 0.627],
  [0.996, 0.851, 0.463],
  [0.996, 0.698, 0.298],
  [0.992, 0.553, 0.235],
  [0.988, 0.306, 0.165],
  [0.890, 0.102, 0.110],
  [0.741, 0.000, 0.149],
  [0.502, 0.000, 0.149]
];

// YlOrBr - Yellow-Orange-Brown sequential
const YLORBR_COLORS = [
  [1.000, 1.000, 0.898],
  [1.000, 0.969, 0.737],
  [0.996, 0.890, 0.569],
  [0.996, 0.769, 0.310],
  [0.996, 0.600, 0.161],
  [0.925, 0.439, 0.078],
  [0.800, 0.298, 0.008],
  [0.600, 0.204, 0.016],
  [0.400, 0.145, 0.024]
];

// Blues - sequential blue
const BLUES_COLORS = [
  [0.969, 0.984, 1.000],
  [0.871, 0.922, 0.969],
  [0.776, 0.859, 0.937],
  [0.620, 0.792, 0.882],
  [0.420, 0.682, 0.839],
  [0.259, 0.573, 0.776],
  [0.129, 0.443, 0.710],
  [0.031, 0.318, 0.612],
  [0.031, 0.188, 0.420]
];

// Greens - sequential green
const GREENS_COLORS = [
  [0.969, 0.988, 0.961],
  [0.898, 0.961, 0.878],
  [0.780, 0.914, 0.753],
  [0.631, 0.851, 0.608],
  [0.455, 0.769, 0.463],
  [0.255, 0.671, 0.365],
  [0.137, 0.545, 0.271],
  [0.000, 0.427, 0.173],
  [0.000, 0.267, 0.106]
];

// Reds - sequential red
const REDS_COLORS = [
  [1.000, 0.961, 0.941],
  [0.996, 0.878, 0.824],
  [0.988, 0.733, 0.631],
  [0.988, 0.573, 0.447],
  [0.984, 0.416, 0.290],
  [0.937, 0.231, 0.173],
  [0.796, 0.094, 0.114],
  [0.647, 0.059, 0.082],
  [0.404, 0.000, 0.051]
];

// Purples - sequential purple
const PURPLES_COLORS = [
  [0.988, 0.984, 0.992],
  [0.937, 0.929, 0.961],
  [0.855, 0.855, 0.922],
  [0.737, 0.741, 0.863],
  [0.620, 0.604, 0.784],
  [0.502, 0.490, 0.730],
  [0.416, 0.318, 0.639],
  [0.329, 0.153, 0.561],
  [0.247, 0.000, 0.490]
];

// Oranges - sequential orange
const ORANGES_COLORS = [
  [1.000, 0.961, 0.922],
  [0.996, 0.902, 0.808],
  [0.992, 0.816, 0.635],
  [0.992, 0.682, 0.420],
  [0.992, 0.553, 0.235],
  [0.945, 0.412, 0.075],
  [0.851, 0.282, 0.004],
  [0.651, 0.212, 0.012],
  [0.498, 0.153, 0.016]
];

// Greys - sequential grey
const GREYS_COLORS = [
  [1.000, 1.000, 1.000],
  [0.941, 0.941, 0.941],
  [0.851, 0.851, 0.851],
  [0.741, 0.741, 0.741],
  [0.588, 0.588, 0.588],
  [0.451, 0.451, 0.451],
  [0.322, 0.322, 0.322],
  [0.145, 0.145, 0.145],
  [0.000, 0.000, 0.000]
];

// Twilight - cyclic colormap
const TWILIGHT_COLORS = [
  [0.886, 0.851, 0.886],
  [0.788, 0.714, 0.851],
  [0.620, 0.541, 0.773],
  [0.424, 0.376, 0.659],
  [0.259, 0.255, 0.514],
  [0.176, 0.196, 0.373],
  [0.176, 0.176, 0.255],
  [0.176, 0.196, 0.373],
  [0.259, 0.255, 0.514],
  [0.424, 0.376, 0.659],
  [0.620, 0.541, 0.773],
  [0.788, 0.714, 0.851],
  [0.886, 0.851, 0.886]
];

// Ocean - sequential ocean-inspired
const OCEAN_COLORS = [
  [0.000, 0.498, 0.000],
  [0.000, 0.400, 0.200],
  [0.000, 0.302, 0.400],
  [0.000, 0.200, 0.600],
  [0.000, 0.100, 0.800],
  [0.000, 0.000, 0.502],
  [0.502, 0.502, 1.000],
  [1.000, 1.000, 1.000]
];

// Hot - black-red-yellow-white
const HOT_COLORS = [
  [0.042, 0.000, 0.000],
  [0.375, 0.000, 0.000],
  [0.708, 0.000, 0.000],
  [1.000, 0.042, 0.000],
  [1.000, 0.375, 0.000],
  [1.000, 0.708, 0.000],
  [1.000, 1.000, 0.042],
  [1.000, 1.000, 0.542],
  [1.000, 1.000, 1.000]
];

// Cool - cyan-magenta
const COOL_COLORS = [
  [0.000, 1.000, 1.000],
  [0.125, 0.875, 1.000],
  [0.250, 0.750, 1.000],
  [0.375, 0.625, 1.000],
  [0.500, 0.500, 1.000],
  [0.625, 0.375, 1.000],
  [0.750, 0.250, 1.000],
  [0.875, 0.125, 1.000],
  [1.000, 0.000, 1.000]
];

// Spring - magenta-yellow
const SPRING_COLORS = [
  [1.000, 0.000, 1.000],
  [1.000, 0.250, 0.750],
  [1.000, 0.500, 0.500],
  [1.000, 0.750, 0.250],
  [1.000, 1.000, 0.000]
];

// Summer - green-yellow
const SUMMER_COLORS = [
  [0.000, 0.502, 0.400],
  [0.250, 0.627, 0.400],
  [0.500, 0.753, 0.400],
  [0.750, 0.878, 0.400],
  [1.000, 1.000, 0.400]
];

// Autumn - red-yellow
const AUTUMN_COLORS = [
  [1.000, 0.000, 0.000],
  [1.000, 0.250, 0.000],
  [1.000, 0.500, 0.000],
  [1.000, 0.750, 0.000],
  [1.000, 1.000, 0.000]
];

// Winter - blue-green
const WINTER_COLORS = [
  [0.000, 0.000, 1.000],
  [0.000, 0.250, 0.875],
  [0.000, 0.500, 0.750],
  [0.000, 0.750, 0.625],
  [0.000, 1.000, 0.500]
];

// Bone - grayscale with blue tint
const BONE_COLORS = [
  [0.000, 0.000, 0.000],
  [0.161, 0.161, 0.225],
  [0.323, 0.323, 0.449],
  [0.484, 0.545, 0.612],
  [0.645, 0.768, 0.776],
  [0.839, 0.902, 0.902],
  [1.000, 1.000, 1.000]
];

// Copper - black-copper
const COPPER_COLORS = [
  [0.000, 0.000, 0.000],
  [0.196, 0.122, 0.078],
  [0.392, 0.245, 0.157],
  [0.588, 0.367, 0.235],
  [0.784, 0.490, 0.314],
  [0.980, 0.612, 0.392],
  [1.000, 0.784, 0.498]
];

// Pink - pastel pink-white
const PINK_COLORS = [
  [0.118, 0.000, 0.000],
  [0.471, 0.294, 0.294],
  [0.667, 0.471, 0.471],
  [0.784, 0.608, 0.608],
  [0.902, 0.745, 0.745],
  [0.961, 0.882, 0.882],
  [1.000, 1.000, 1.000]
];

// Terrain - globe terrain
const TERRAIN_COLORS = [
  [0.200, 0.200, 0.600],
  [0.000, 0.600, 1.000],
  [0.000, 0.800, 0.400],
  [1.000, 1.000, 0.600],
  [0.500, 0.360, 0.330],
  [1.000, 1.000, 1.000]
];

// Rainbow - classic rainbow
const RAINBOW_COLORS = [
  [0.500, 0.000, 1.000],
  [0.000, 0.000, 1.000],
  [0.000, 1.000, 1.000],
  [0.000, 1.000, 0.000],
  [1.000, 1.000, 0.000],
  [1.000, 0.500, 0.000],
  [1.000, 0.000, 0.000]
];

// Seismic - blue-white-red diverging
const SEISMIC_COLORS = [
  [0.000, 0.000, 0.300],
  [0.000, 0.000, 1.000],
  [1.000, 1.000, 1.000],
  [1.000, 0.000, 0.000],
  [0.500, 0.000, 0.000]
];

// GnBu - Green-Blue sequential
const GNBU_COLORS = [
  [0.969, 0.988, 0.941],
  [0.878, 0.953, 0.859],
  [0.800, 0.922, 0.773],
  [0.659, 0.867, 0.710],
  [0.482, 0.800, 0.769],
  [0.306, 0.702, 0.827],
  [0.169, 0.549, 0.745],
  [0.031, 0.408, 0.675],
  [0.031, 0.251, 0.506]
];

// BuPu - Blue-Purple sequential
const BUPU_COLORS = [
  [0.969, 0.988, 0.992],
  [0.878, 0.925, 0.957],
  [0.749, 0.827, 0.902],
  [0.620, 0.737, 0.855],
  [0.549, 0.588, 0.776],
  [0.549, 0.420, 0.694],
  [0.533, 0.255, 0.616],
  [0.506, 0.059, 0.486],
  [0.302, 0.000, 0.294]
];

// RdPu - Red-Purple sequential
const RDPU_COLORS = [
  [1.000, 0.969, 0.953],
  [0.992, 0.878, 0.867],
  [0.988, 0.773, 0.753],
  [0.980, 0.624, 0.710],
  [0.969, 0.408, 0.631],
  [0.867, 0.204, 0.592],
  [0.682, 0.004, 0.494],
  [0.478, 0.004, 0.467],
  [0.286, 0.000, 0.416]
];

// PuRd - Purple-Red sequential
const PURD_COLORS = [
  [0.969, 0.957, 0.976],
  [0.906, 0.882, 0.937],
  [0.831, 0.725, 0.855],
  [0.788, 0.580, 0.780],
  [0.875, 0.396, 0.690],
  [0.906, 0.161, 0.541],
  [0.808, 0.071, 0.337],
  [0.596, 0.000, 0.263],
  [0.404, 0.000, 0.122]
];

// OrRd - Orange-Red sequential
const ORRD_COLORS = [
  [1.000, 0.969, 0.925],
  [0.996, 0.910, 0.784],
  [0.992, 0.831, 0.620],
  [0.992, 0.733, 0.518],
  [0.988, 0.553, 0.349],
  [0.937, 0.396, 0.282],
  [0.843, 0.188, 0.122],
  [0.702, 0.086, 0.090],
  [0.498, 0.000, 0.000]
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
  // Perceptually uniform (scientific)
  buildColormap('viridis', 'Viridis', VIRIDIS_COLORS),
  buildColormap('plasma', 'Plasma', PLASMA_COLORS),
  buildColormap('inferno', 'Inferno', INFERNO_COLORS),
  buildColormap('magma', 'Magma', MAGMA_COLORS),
  buildColormap('cividis', 'Cividis', CIVIDIS_COLORS),
  buildColormap('turbo', 'Turbo', TURBO_COLORS),
  buildColormap('twilight', 'Twilight', TWILIGHT_COLORS),
  // Diverging
  buildColormap('coolwarm', 'Coolwarm', COOLWARM_COLORS),
  buildColormap('bluered', 'Blue-Red', BLUE_RED_COLORS),
  buildColormap('spectral', 'Spectral', SPECTRAL_COLORS),
  buildColormap('rdylbu', 'RdYlBu', RDYLBU_COLORS),
  buildColormap('rdbu', 'RdBu', RDBU_COLORS),
  buildColormap('piyg', 'PiYG', PIYG_COLORS),
  buildColormap('prgn', 'PRGn', PRGN_COLORS),
  buildColormap('brbg', 'BrBG', BRBG_COLORS),
  buildColormap('seismic', 'Seismic', SEISMIC_COLORS),
  // Sequential (multi-hue)
  buildColormap('ylgnbu', 'YlGnBu', YLGNBU_COLORS),
  buildColormap('ylorrd', 'YlOrRd', YLORRD_COLORS),
  buildColormap('ylorbr', 'YlOrBr', YLORBR_COLORS),
  buildColormap('gnbu', 'GnBu', GNBU_COLORS),
  buildColormap('bupu', 'BuPu', BUPU_COLORS),
  buildColormap('rdpu', 'RdPu', RDPU_COLORS),
  buildColormap('purd', 'PuRd', PURD_COLORS),
  buildColormap('orrd', 'OrRd', ORRD_COLORS),
  // Sequential (single-hue)
  buildColormap('blues', 'Blues', BLUES_COLORS),
  buildColormap('greens', 'Greens', GREENS_COLORS),
  buildColormap('reds', 'Reds', REDS_COLORS),
  buildColormap('purples', 'Purples', PURPLES_COLORS),
  buildColormap('oranges', 'Oranges', ORANGES_COLORS),
  buildColormap('greys', 'Greys', GREYS_COLORS),
  // Classic/Misc
  buildColormap('heat', 'Heat', HEAT_COLORS),
  buildColormap('hot', 'Hot', HOT_COLORS),
  buildColormap('cool', 'Cool', COOL_COLORS),
  buildColormap('jet', 'Jet', JET_COLORS),
  buildColormap('rainbow', 'Rainbow', RAINBOW_COLORS),
  buildColormap('ocean', 'Ocean', OCEAN_COLORS),
  buildColormap('terrain', 'Terrain', TERRAIN_COLORS),
  // Seasonal
  buildColormap('spring', 'Spring', SPRING_COLORS),
  buildColormap('summer', 'Summer', SUMMER_COLORS),
  buildColormap('autumn', 'Autumn', AUTUMN_COLORS),
  buildColormap('winter', 'Winter', WINTER_COLORS),
  // Special
  buildColormap('bone', 'Bone', BONE_COLORS),
  buildColormap('copper', 'Copper', COPPER_COLORS),
  buildColormap('pink', 'Pink', PINK_COLORS)
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
