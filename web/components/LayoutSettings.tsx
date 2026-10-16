/** A slider for one numeric setting of a layout. */
export interface Slider<K extends string> {
  key: K;
  label: string;
  tip: string;
  min: number;
  max: number;
  step: number;
  format(v: number): string;
}

/** Reads saved settings, keeping only values of the right type. */
export function parseSettings<T extends object>(text: string | null, defaults: T): T {
  const settings = { ...defaults };
  try {
    const saved = JSON.parse(text ?? '{}') as Record<string, unknown>;
    for (const key of Object.keys(settings) as (keyof T & string)[]) {
      if (typeof saved[key] === typeof settings[key]) Object.assign(settings, { [key]: saved[key] });
    }
  } catch {
    /* not JSON: defaults */
  }
  return settings;
}

/** A row per slider: its label, the slider and its value. */
export function SettingsSliders<K extends string, T extends Record<K, number>>({
  sliders,
  settings,
  onChange,
}: {
  sliders: Slider<K>[];
  settings: T;
  onChange(settings: T): void;
}) {
  return sliders.map((s) => (
    <label key={s.key} className="evolve-field" data-tip={s.tip}>
      <span>{s.label}</span>
      <input
        type="range"
        min={s.min}
        max={s.max}
        step={s.step}
        value={settings[s.key]}
        onChange={(e) => onChange({ ...settings, [s.key]: Number(e.target.value) })}
      />
      <output>{s.format(settings[s.key])}</output>
    </label>
  ));
}
