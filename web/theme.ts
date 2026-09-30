import type { StylesheetJson } from 'cytoscape';
import type { ArrowShape, CurveStyle, LineStyle, NodeShape, Style } from '../shared/model';
import { iconKey } from './icons';

export type ThemeName = 'dark' | 'light';

interface CanvasColors {
  node: string;
  nodeBorder: string;
  nodeText: string;
  edge: string;
  edgeText: string;
  labelBg: string;
  accent: string;
  connect: string;
}

export const CANVAS_COLORS: Record<ThemeName, CanvasColors> = {
  dark: {
    node: '#c0caf5',
    nodeBorder: '#e6ebff',
    nodeText: '#e6e9f5',
    edge: '#8b93b8',
    edgeText: '#b8bfdc',
    labelBg: '#12141c',
    accent: '#ff9e64',
    connect: '#9ece6a',
  },
  light: {
    node: '#4c5a8a',
    nodeBorder: '#2b3559',
    nodeText: '#1f2433',
    edge: '#7b8299',
    edgeText: '#4a5068',
    labelBg: '#f6f7fb',
    accent: '#e8590c',
    connect: '#2f9e44',
  },
};

export const DEFAULT_NODE_SIZE = 36;
export const DEFAULT_EDGE_WIDTH = 2;
export const DEFAULT_NODE_SHAPE: NodeShape = 'ellipse';
export const DEFAULT_LINE_STYLE: LineStyle = 'solid';
export const DEFAULT_ARROW: ArrowShape = 'triangle';
export const DEFAULT_CURVE: CurveStyle = 'bezier';
/** Default icon size, as a percentage of the node; styles can override it with `iconSize`. */
export const DEFAULT_ICON_SIZE = 70;

export const iconSizeCss = (s: { iconSize?: number }) => `${s.iconSize ?? DEFAULT_ICON_SIZE}%`;

/** Suggested colours for new styles; they read well on both themes. */
export const PALETTE = [
  '#7aa2f7', '#7dcfff', '#9ece6a', '#e0af68', '#ff9e64',
  '#f7768e', '#bb9af7', '#2ac3de', '#c0caf5', '#73daca',
];

type Css = Record<string, string | number>;

function styleRules(s: Style, icons: Record<string, string>, defaultFill: string): Css {
  const css: Css = {};
  if (s.target === 'node') {
    if (s.color) css['background-color'] = s.color;
    if (s.borderColor) css['border-color'] = s.borderColor;
    if (s.textColor) css.color = s.textColor;
    if (s.shape) css.shape = s.shape;
    if (s.size) {
      css.width = s.size;
      css.height = s.size;
    }
    const icon = s.icon && icons[iconKey(s, defaultFill)];
    if (icon) {
      css['background-image'] = icon;
      css['background-fit'] = 'none';
      css['background-width'] = iconSizeCss(s);
      css['background-height'] = iconSizeCss(s);
      css['background-clip'] = 'none';
    }
  } else {
    if (s.color) {
      css['line-color'] = s.color;
      css['target-arrow-color'] = s.color;
    }
    if (s.textColor) css.color = s.textColor;
    if (s.width) css.width = s.width;
    if (s.lineStyle) css['line-style'] = s.lineStyle;
    if (s.arrow) css['target-arrow-shape'] = s.arrow;
    if (s.curve) css['curve-style'] = s.curve;
  }
  return css;
}

/** `icons` holds loaded icon data URIs (see `useIcons`); missing ones are just not drawn yet. */
export function buildStylesheet(styles: Style[], theme: ThemeName, icons: Record<string, string> = {}): StylesheetJson {
  const c = CANVAS_COLORS[theme];
  const labelBox = {
    'text-background-color': c.labelBg,
    'text-background-opacity': 0.75,
    'text-background-padding': '2px',
    'text-background-shape': 'roundrectangle',
  };
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'background-color': c.node,
        'border-color': c.nodeBorder,
        'border-width': 2,
        color: c.nodeText,
        shape: DEFAULT_NODE_SHAPE,
        width: DEFAULT_NODE_SIZE,
        height: DEFAULT_NODE_SIZE,
        'font-size': 12,
        'font-family': 'Inter, system-ui, sans-serif',
        'text-valign': 'bottom',
        'text-margin-y': 6,
        'text-wrap': 'wrap',
        'text-max-width': '160px',
        ...labelBox,
      },
    },
    {
      selector: 'edge',
      style: {
        label: 'data(label)',
        width: DEFAULT_EDGE_WIDTH,
        'line-color': c.edge,
        'target-arrow-color': c.edge,
        'line-style': DEFAULT_LINE_STYLE,
        'target-arrow-shape': DEFAULT_ARROW,
        'arrow-scale': 1.1,
        'curve-style': DEFAULT_CURVE,
        color: c.edgeText,
        'font-size': 10,
        'font-family': 'Inter, system-ui, sans-serif',
        'text-rotation': 'autorotate',
        ...labelBox,
      },
    },
    {
      // Long edges within one row bend above it (the `arc` is set in GraphCanvas).
      // Listed before the user styles so a style's own curve setting still wins.
      selector: 'edge[arc]',
      style: {
        'curve-style': 'unbundled-bezier',
        'control-point-distances': 'data(arc)',
        'control-point-weights': 0.5,
      },
    },
    ...styles.map((s) => ({
      selector: `${s.target}[styleId = ${JSON.stringify(s.id)}]`,
      style: styleRules(s, icons, c.node),
    })),
    {
      selector: 'node:selected',
      style: {
        'border-color': c.accent,
        'border-width': 4,
        'underlay-color': c.accent,
        'underlay-opacity': 0.25,
        'underlay-padding': 6,
      },
    },
    {
      selector: 'edge:selected',
      style: {
        'line-color': c.accent,
        'target-arrow-color': c.accent,
        'underlay-color': c.accent,
        'underlay-opacity': 0.25,
        'underlay-padding': 4,
      },
    },
    {
      selector: 'node.connect-source',
      style: {
        'border-color': c.connect,
        'border-width': 4,
        'border-style': 'dashed',
        'underlay-color': c.connect,
        'underlay-opacity': 0.3,
        'underlay-padding': 8,
      },
    },
    { selector: '.dimmed', style: { opacity: 0.18 } },
    {
      selector: 'node.match',
      style: { 'underlay-color': c.connect, 'underlay-opacity': 0.35, 'underlay-padding': 8 },
    },
  ] as StylesheetJson;
}
