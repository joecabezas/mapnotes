import { INSERT_DEFAULTS, type InsertSettings } from '../insertion';
import { Icon } from './Icon';
import { parseSettings, type Slider, SettingsSliders } from './LayoutSettings';

type NumberSetting = Exclude<keyof InsertSettings, 'makeRoom'>;

const SLIDERS: Slider<NumberSetting>[] = [
  {
    key: 'budgetMs',
    label: 'Time',
    tip: 'How long it works on the layout (it stops sooner when nothing is left to fix)',
    min: 500,
    max: 30000,
    step: 500,
    format: (v) => `${v / 1000} s`,
  },
  {
    key: 'patch',
    label: 'Patch size',
    tip: 'Once every node is in, it keeps taking out a patch of the layout around a crossing and inserting it again: at most this share of the nodes at a time',
    min: 0.05,
    max: 0.9,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'lookahead',
    label: 'Lookahead',
    tip: 'How much a spot counts the crossings that edges to neighbours not placed yet look set to make',
    min: 0,
    max: 3,
    step: 0.25,
    format: String,
  },
  {
    key: 'crowd',
    label: 'Crowding',
    tip: 'How much a node with neighbours still to place avoids crowded spots, keeping room for them',
    min: 0,
    max: 4,
    step: 0.25,
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
    tip: 'Edges passing closer than this to a node they don’t connect count against a spot (the status bar counts them)',
    min: 0,
    max: 80,
    step: 2,
    format: (v) => `${v} px`,
  },
];

/** Reads saved settings, keeping only values of the right type. */
export function parseInsertSettings(text: string | null): InsertSettings {
  return parseSettings(text, INSERT_DEFAULTS);
}

/** The insertion layout's settings, shown in the Layout panel while it's picked. */
export function InsertControls({
  settings,
  onChange,
}: {
  settings: InsertSettings;
  onChange(settings: InsertSettings): void;
}) {
  return (
    <div className="evolve-controls">
      <SettingsSliders sliders={SLIDERS} settings={settings} onChange={onChange} />
      <div className="evolve-foot">
        <label data-tip="Where a node doesn't fit, push the nodes around the spot outwards to make room for it">
          <input
            type="checkbox"
            checked={settings.makeRoom}
            onChange={(e) => onChange({ ...settings, makeRoom: e.target.checked })}
          />{' '}
          Make room
        </label>
        <button className="btn danger" data-tip="Back to the default settings" onClick={() => onChange(INSERT_DEFAULTS)}>
          <Icon name="reset" /> Reset
        </button>
      </div>
    </div>
  );
}
