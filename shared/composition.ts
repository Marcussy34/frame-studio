import { z } from 'zod';
import type { Settings } from './types';

export const canvasStorageKey = 'frame-studio:canvas:v1';

export const backgrounds = [
  { id: 'apricot', name: 'Apricot', colors: ['#f4bd99', '#e58c82', '#b76b91'] },
  { id: 'dusk', name: 'Dusk', colors: ['#c4b4e8', '#819ac6', '#475f91'] },
  { id: 'sage', name: 'Sage', colors: ['#d7dfbd', '#9cb5a2', '#557e75'] },
  { id: 'ocean', name: 'Ocean', colors: ['#b6e5e5', '#6cbdcf', '#436fac'] },
  { id: 'sand', name: 'Sand', colors: ['#f0e6d8', '#dac6af', '#b8a18b'] },
  { id: 'rose', name: 'Rose', colors: ['#f3d1da', '#d599ae', '#925d89'] },
  { id: 'slate', name: 'Slate', colors: ['#b2bac8', '#7a879c', '#475367'] },
  { id: 'midnight', name: 'Midnight', colors: ['#414956', '#262f3c', '#151c26'] },
  { id: 'sunset', name: 'Sunset', colors: ['#ffd49c', '#ff8c82', '#b56baf'] },
  { id: 'lagoon', name: 'Lagoon', colors: ['#d0f4de', '#62c7bf', '#318ba1'] },
  { id: 'lavender', name: 'Lavender', colors: ['#eee3ff', '#c5a5e8', '#8d7dc5'] },
  { id: 'citrus', name: 'Citrus', colors: ['#fff5ad', '#d8e27f', '#8bb681'] },
  { id: 'peach', name: 'Peach', colors: ['#fff0dd', '#ffd1b5', '#ee9c8a'] },
  { id: 'coral', name: 'Coral', colors: ['#ffc6a0', '#f47d78', '#c25271'] },
  { id: 'aurora', name: 'Aurora', colors: ['#c9c6fa', '#8cc9e0', '#a3e3c2'] },
  { id: 'indigo', name: 'Indigo', colors: ['#a1b6f0', '#6477c5', '#343c78'] },
  { id: 'mint', name: 'Mint', colors: ['#e3f7e7', '#aedbc9', '#7ab2a9'] },
  { id: 'steel', name: 'Steel', colors: ['#e3e8ef', '#aebbc9', '#687d92'] },
  { id: 'plum', name: 'Plum', colors: ['#d5aac5', '#9873a2', '#5c476e'] },
  { id: 'copper', name: 'Copper', colors: ['#e3c1a6', '#b9896c', '#785744'] },
  { id: 'forest', name: 'Forest', colors: ['#a6bc96', '#638678', '#2f5754'] },
  { id: 'ice', name: 'Ice', colors: ['#f1fafc', '#c1e1f0', '#8daed0'] },
  { id: 'ember', name: 'Ember', colors: ['#e7a575', '#a8544c', '#493d55'] },
  { id: 'charcoal', name: 'Charcoal', colors: ['#747680', '#424650', '#22252e'] },
] as const;

export const patterns = [
  { id: 'grid', name: 'Grid', color: '#233044' },
  { id: 'dots', name: 'Dots', color: '#28514c' },
  { id: 'diagonal', name: 'Diagonal', color: '#e3d1b8' },
  { id: 'paper', name: 'Linen', color: '#eee9df' },
] as const;

export const solidColors = [
  '#151618',
  '#343d4b',
  '#e8d9c8',
  '#f4f0e8',
  '#cce3d6',
  '#acc4d9',
  '#cdbde5',
  '#e5bbcb',
  '#e9b09a',
  '#e8d586',
  '#537b72',
  '#66799c',
];

export const ratios = [
  { value: '16:9', label: 'Widescreen', detail: '16:9', width: 16, height: 9 },
  { value: '1:1', label: 'Square', detail: '1:1', width: 1, height: 1 },
  { value: '9:16', label: 'Portrait', detail: '9:16', width: 9, height: 16 },
  { value: '4:3', label: 'Classic', detail: '4:3', width: 4, height: 3 },
] as const;

export const settingsSchema = z.object({
  ratio: z.enum(['16:9', '1:1', '9:16', '4:3']),
  background: z.enum([
    ...backgrounds.map((item) => item.id),
    ...patterns.map((item) => item.id),
    'solid',
    'custom-gradient',
    'image',
  ] as const),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  gradientColors: z
    .tuple([
      z.string().regex(/^#[0-9a-fA-F]{6}$/),
      z.string().regex(/^#[0-9a-fA-F]{6}$/),
      z.string().regex(/^#[0-9a-fA-F]{6}$/),
    ])
    .default(['#f4bd99', '#e58c82', '#b76b91']),
  gradientAngle: z.number().finite().min(0).max(360).default(135),
  gradientType: z.enum(['linear', 'radial']).default('linear'),
  backgroundImage: z
    .string()
    .max(2_000_000)
    .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/)
    .nullable()
    .default(null),
  backgroundImageName: z.string().max(180).default(''),
  padding: z.number().finite().min(0).max(30),
  radius: z.number().finite().min(0).max(64),
  shadow: z.number().finite().min(0).max(60),
  scale: z.number().finite().min(50).max(100),
  x: z.number().finite().min(0).max(100),
  y: z.number().finite().min(0).max(100),
});

export const exportSchema = z.object({
  settings: settingsSchema,
  resolution: z.union([z.literal(720), z.literal(1080), z.literal(2160)]),
  includeAudio: z.boolean(),
});

export const defaultSettings: Settings = {
  ratio: '16:9',
  background: 'apricot',
  color: '#e8d9c8',
  gradientColors: ['#f4bd99', '#e58c82', '#b76b91'],
  gradientAngle: 135,
  gradientType: 'linear',
  backgroundImage: null,
  backgroundImageName: '',
  padding: 10,
  radius: 24,
  shadow: 35,
  scale: 100,
  x: 50,
  y: 50,
};

export interface Layout {
  width: number;
  height: number;
  video: { width: number; height: number; x: number; y: number; radius: number };
}

// Even video dimensions keep the H.264 export compatible with common players.
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export function getLayout(
  settings: Settings,
  source: { width: number; height: number },
  shortEdge = 1080,
): Layout {
  if (
    ![source.width, source.height, shortEdge].every((value) => Number.isFinite(value) && value > 0)
  ) {
    throw new Error('Video dimensions must be positive finite numbers.');
  }
  const ratio = ratios.find((item) => item.value === settings.ratio)!;
  const aspect = ratio.width / ratio.height;
  const width = even(shortEdge * Math.max(1, aspect));
  const height = even(shortEdge * Math.max(1, 1 / aspect));
  const padding = (Math.min(width, height) * settings.padding) / 100;
  const fit =
    (Math.min((width - 2 * padding) / source.width, (height - 2 * padding) / source.height) *
      settings.scale) /
    100;
  // Round the fitted video down so it never exceeds the available canvas space.
  const videoWidth = Math.max(2, Math.floor((source.width * fit) / 2) * 2);
  const videoHeight = Math.max(2, Math.floor((source.height * fit) / 2) * 2);
  return {
    width,
    height,
    video: {
      width: videoWidth,
      height: videoHeight,
      x: Math.round(padding + ((width - 2 * padding - videoWidth) * settings.x) / 100),
      y: Math.round(padding + ((height - 2 * padding - videoHeight) * settings.y) / 100),
      radius: Math.min((settings.radius * shortEdge) / 1080, videoWidth / 2, videoHeight / 2),
    },
  };
}

// Both browser preview and FFmpeg export use this exact static artwork.
export function backgroundSvg(settings: Settings, layout: Layout): string {
  const palette = backgrounds.find((item) => item.id === settings.background) ?? backgrounds[0];
  const { width, height, video } = layout;
  const unit = Math.min(width, height) / 1080;
  const shadow = settings.shadow / 100;
  const colors =
    settings.background === 'custom-gradient' ? settings.gradientColors : palette.colors;
  const angle = (settings.gradientAngle * Math.PI) / 180;
  const dx = Math.sin(angle);
  const dy = -Math.cos(angle);
  const reach = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  const stops = colors
    .map((color, index) => `<stop offset="${index / 2}" stop-color="${color}"/>`)
    .join('');
  const gradient =
    settings.gradientType === 'radial'
      ? `<radialGradient id="background" cx=".3" cy=".25" r="1">${stops}</radialGradient>`
      : `<linearGradient id="background" gradientUnits="userSpaceOnUse" x1="${width / 2 - dx * reach}" y1="${height / 2 - dy * reach}" x2="${width / 2 + dx * reach}" y2="${height / 2 + dy * reach}">${stops}</linearGradient>`;
  const pattern = patterns.find((item) => item.id === settings.background);
  const spacing = 48 * unit;
  const brightness =
    [1, 3, 5].reduce(
      (sum, offset) => sum + parseInt(settings.color.slice(offset, offset + 2), 16),
      0,
    ) / 3;
  const ink = brightness > 150 ? '#302820' : '#ffffff';
  const patternShape =
    settings.background === 'dots'
      ? `<circle cx="${spacing / 2}" cy="${spacing / 2}" r="${spacing / 9}" fill="${ink}" opacity=".22"/>`
      : settings.background === 'diagonal'
        ? `<path d="M0 ${spacing} L${spacing} 0 M${-spacing / 2} ${spacing / 2} L${spacing / 2} ${-spacing / 2} M${spacing / 2} ${spacing * 1.5} L${spacing * 1.5} ${spacing / 2}" stroke="${ink}" stroke-width="${2 * unit}" opacity=".15"/>`
        : `<path d="M${spacing} 0 H0 V${spacing}" fill="none" stroke="${ink}" stroke-width="${settings.background === 'paper' ? 7 * unit : 2 * unit}" opacity="${settings.background === 'paper' ? '.05' : '.18'}"/>`;
  const plain = settings.background === 'solid' || settings.background === 'image' || !!pattern;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      ${gradient}
      <pattern id="texture" patternUnits="userSpaceOnUse" width="${spacing}" height="${spacing}">${patternShape}</pattern>
      <filter id="shadow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="${24 * unit}"/></filter>
    </defs>
    <rect width="100%" height="100%" fill="${plain ? settings.color : 'url(#background)'}"/>
    ${pattern ? '<rect width="100%" height="100%" fill="url(#texture)"/>' : ''}
    ${settings.background === 'image' && settings.backgroundImage ? `<image href="${settings.backgroundImage}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>` : ''}
    ${shadow ? `<rect x="${video.x}" y="${video.y + 18 * unit}" width="${video.width}" height="${video.height}" rx="${video.radius}" fill="#000" opacity="${shadow}" filter="url(#shadow)"/>` : ''}
  </svg>`;
}

export function maskSvg(layout: Layout): string {
  const { width, height, radius } = layout.video;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/><rect width="${width}" height="${height}" rx="${radius}" fill="white"/></svg>`;
}
