import { ArrowRotateLeft, Colorfilter, Maximize4, Mouse } from 'iconsax-reactjs';
import { defaultSettings, ratios } from '../../shared/composition';
import type { MediaAsset, Settings } from '../../shared/types';
import { Button } from '@/components/ui/button';
import { BackgroundPanel } from '@/components/BackgroundPanel';
import { CameraPlan } from '@/components/CameraPlan';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

function SettingSlider({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  suffix = '%',
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <Label className="font-normal text-foreground/85">{label}</Label>
        <output className="min-w-12 rounded-md bg-background px-2 py-1 text-right text-[11px] text-muted-foreground tabular-nums">
          {value}
          {suffix}
        </output>
      </div>
      <Slider
        aria-label={label}
        value={[value]}
        onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
        min={min}
        max={max}
        step={1}
      />
    </div>
  );
}

function SettingSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <Label className="font-normal text-foreground/85">{label}</Label>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function Inspector({
  settings,
  onChange,
  disabled,
  onBackgroundBusyChange,
  // Cursor and zoom only exist for assets recorded in Frame Studio, so the whole
  // section is hidden rather than shown disabled for imported video.
  asset,
  onPlanned,
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
  disabled: boolean;
  onBackgroundBusyChange: (busy: boolean) => void;
  asset?: MediaAsset;
  onPlanned?: () => void;
}) {
  const hasCursorTrack = !!asset?.cursorTrack;
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onChange({ ...settings, [key]: value });
  return (
    <aside
      aria-label="Canvas settings"
      className="min-w-0 border-t border-border bg-card lg:overflow-y-auto lg:border-t-0 lg:border-l"
    >
      <div className="flex h-16 items-center justify-between border-b border-border px-6">
        <div className="flex items-center gap-2.5 text-sm font-medium">
          <Colorfilter className="size-4 text-primary" /> Canvas
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reset canvas settings"
          title="Reset canvas settings"
          disabled={disabled}
          onClick={() => onChange(defaultSettings)}
        >
          <ArrowRotateLeft />
        </Button>
      </div>
      <fieldset disabled={disabled} className="min-w-0 disabled:opacity-60">
        <BackgroundPanel
          settings={settings}
          onChange={onChange}
          disabled={disabled}
          onBusyChange={onBackgroundBusyChange}
        />
        <section className="space-y-4 border-b border-border p-6">
          <h2 className="text-xs font-medium">Aspect ratio</h2>
          <div className="grid grid-cols-4 gap-2">
            {ratios.map((ratio) => (
              <Button
                key={ratio.value}
                variant="outline"
                aria-label={`${ratio.label} ${ratio.detail}`}
                aria-pressed={settings.ratio === ratio.value}
                onClick={() => set('ratio', ratio.value)}
                className={cn(
                  'h-[66px] flex-col gap-2 rounded-lg px-1 text-[10px] text-muted-foreground',
                  settings.ratio === ratio.value && 'border-primary/70 bg-primary/8 text-primary',
                )}
              >
                <span
                  aria-hidden="true"
                  className="block rounded-[3px] border-[1.5px] border-current"
                  style={{
                    width: ratio.width >= ratio.height ? 23 : 14,
                    height: ratio.height >= ratio.width ? 23 : 14,
                  }}
                />
                {ratio.detail}
              </Button>
            ))}
          </div>
        </section>
        <section className="space-y-5 border-b border-border p-6">
          <h2 className="flex items-center gap-2 text-xs font-medium">
            <Maximize4 className="size-3.5 text-muted-foreground" /> Frame
          </h2>
          <SettingSlider
            label="Padding"
            value={settings.padding}
            max={30}
            onChange={(value) => set('padding', value)}
          />
          <SettingSlider
            label="Corners"
            value={settings.radius}
            max={64}
            suffix=""
            onChange={(value) => set('radius', value)}
          />
          <SettingSlider
            label="Shadow"
            value={settings.shadow}
            max={60}
            onChange={(value) => set('shadow', value)}
          />
        </section>
        <section className="space-y-5 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium">Size & position</h2>
            <Button
              size="xs"
              variant="ghost"
              className="text-[10px] text-muted-foreground"
              onClick={() => onChange({ ...settings, scale: 100, x: 50, y: 50 })}
            >
              Center
            </Button>
          </div>
          <SettingSlider
            label="Video size"
            value={settings.scale}
            min={50}
            onChange={(value) => set('scale', value)}
          />
          <SettingSlider
            label="Horizontal position"
            value={settings.x}
            onChange={(value) => set('x', value)}
          />
          <SettingSlider
            label="Vertical position"
            value={settings.y}
            onChange={(value) => set('y', value)}
          />
        </section>
        {hasCursorTrack && (
          <section className="space-y-5 border-t border-border p-6">
            <div className="flex items-center gap-2.5 text-xs font-medium">
              <Mouse className="size-4 text-primary" /> Cursor & zoom
            </div>
            <SettingSwitch
              label="Enhanced cursor"
              checked={settings.cursorEnabled}
              onChange={(value) => set('cursorEnabled', value)}
            />
            {settings.cursorEnabled && (
              <>
                <SettingSlider
                  label="Cursor size"
                  value={Math.round(settings.cursorSize * 10)}
                  min={10}
                  max={40}
                  suffix=""
                  onChange={(value) => set('cursorSize', value / 10)}
                />
                <SettingSlider
                  label="Smoothing"
                  value={settings.cursorSmoothing}
                  onChange={(value) => set('cursorSmoothing', value)}
                />
                <SettingSlider
                  label="Motion blur"
                  value={settings.cursorBlur}
                  onChange={(value) => set('cursorBlur', value)}
                />
                <SettingSwitch
                  label="Click effects"
                  checked={settings.cursorClicks}
                  onChange={(value) => set('cursorClicks', value)}
                />
              </>
            )}
            <SettingSwitch
              label="Auto zoom"
              checked={settings.zoomEnabled}
              onChange={(value) => set('zoomEnabled', value)}
            />
            {settings.zoomEnabled && (
              <>
                <SettingSlider
                  label="Zoom strength"
                  value={Math.round(settings.zoomStrength * 10)}
                  min={10}
                  max={30}
                  suffix=""
                  onChange={(value) => set('zoomStrength', value / 10)}
                />
                <SettingSlider
                  label="Zoom speed"
                  value={settings.zoomSpeed}
                  onChange={(value) => set('zoomSpeed', value)}
                />
                {asset && onPlanned && (
                  <CameraPlan
                    asset={asset}
                    settings={settings}
                    onChange={onChange}
                    onPlanned={onPlanned}
                    disabled={disabled}
                  />
                )}
              </>
            )}
          </section>
        )}
      </fieldset>
    </aside>
  );
}
