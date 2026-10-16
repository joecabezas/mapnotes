import { EVOLVE_DEFAULTS, type EvolveSettings } from '../genetic';
import { Icon } from './Icon';
import { parseSettings, type Slider, SettingsSliders } from './LayoutSettings';

type NumberSetting = Exclude<keyof EvolveSettings, 'planets'>;

const SLIDERS: Slider<NumberSetting>[] = [
  {
    key: 'budgetMs',
    label: 'Time',
    tip: 'How long it evolves',
    min: 500,
    max: 30000,
    step: 500,
    format: (v) => `${v / 1000} s`,
  },
  {
    key: 'explore',
    label: 'Explore',
    tip: 'Share of the time spent exploring: whenever it gets stuck it keeps the best layout of that try and starts over. The rest refines the best ones',
    min: 0,
    max: 0.9,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'populationSize',
    label: 'Population',
    tip: 'Layouts in each generation',
    min: 4,
    max: 100,
    step: 2,
    format: String,
  },
  {
    key: 'crossover',
    label: 'Crossover',
    tip: 'How often a child mixes two parents instead of copying one',
    min: 0,
    max: 1,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'mutations',
    label: 'Mutations',
    tip: 'Random changes per child, on average',
    min: 0,
    max: 5,
    step: 0.5,
    format: String,
  },
  {
    key: 'repair',
    label: 'Repair',
    tip: 'Moves tried on each child to undo its crossings',
    min: 0,
    max: 40,
    step: 1,
    format: String,
  },
  {
    key: 'gap',
    label: 'Spacing',
    tip: 'Room kept free between nodes',
    min: 0,
    max: 150,
    step: 5,
    format: (v) => `${v} px`,
  },
  {
    key: 'clearance',
    label: 'Edge clearance',
    tip: 'Edges passing closer than this to a node they don’t connect get pushed away (the status bar counts them)',
    min: 0,
    max: 80,
    step: 2,
    format: (v) => `${v} px`,
  },
];

/** Reads saved settings, keeping only values of the right type. */
export function parseEvolveSettings(text: string | null): EvolveSettings {
  return parseSettings(text, EVOLVE_DEFAULTS);
}

/** The genetic layout's settings, shown in the Layout panel while it's picked. */
export function EvolveControls({
  settings,
  onChange,
}: {
  settings: EvolveSettings;
  onChange(settings: EvolveSettings): void;
}) {
  return (
    <div className="evolve-controls">
      <SettingsSliders sliders={SLIDERS} settings={settings} onChange={onChange} />
      <div className="evolve-foot">
        <label data-tip="Mutation that puts a busy node's neighbours on a ring around it, and starting layouts built that way">
          <input
            type="checkbox"
            checked={settings.planets}
            onChange={(e) => onChange({ ...settings, planets: e.target.checked })}
          />{' '}
          Sun &amp; planets
        </label>
        <button
          className="btn danger"
          data-tip="Back to the default settings"
          onClick={() => onChange(EVOLVE_DEFAULTS)}
        >
          <Icon name="reset" /> Reset
        </button>
      </div>
    </div>
  );
}
