import { useRef, useState } from 'react';
import { DocumentUpload, TickCircle } from 'iconsax-reactjs';
import { backgrounds, patterns, solidColors } from '../../shared/composition';
import type { Settings } from '../../shared/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export function BackgroundPanel({
  settings,
  onChange,
  disabled,
  onBusyChange,
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(settings);
  latest.current = settings;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pattern = patterns.find((item) => item.id === settings.background);
  const mode =
    settings.background === 'solid'
      ? 'solid'
      : settings.background === 'image'
        ? 'image'
        : pattern
          ? 'pattern'
          : 'gradient';
  const preset = backgrounds.find((item) => item.id === settings.background) ?? backgrounds[0];
  const change = (patch: Partial<Settings>) => onChange({ ...latest.current, ...patch });
  const uploadImage = async (file: File) => {
    if (file.size > 20 * 1024 ** 2) {
      setError('Choose an image smaller than 20 MB.');
      return;
    }
    setLoading(true);
    onBusyChange(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('image', file);
      const result = await api<{ dataUrl: string; name: string }>('/api/background', {
        method: 'POST',
        body,
      });
      if (latest.current.background === 'image')
        change({ backgroundImage: result.dataUrl, backgroundImageName: result.name });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This image could not be opened.');
    } finally {
      setLoading(false);
      onBusyChange(false);
    }
  };

  return (
    <section className="space-y-4 border-b border-border p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium">Background</h2>
        <span className="text-[10px] tracking-wide text-muted-foreground">
          {mode === 'gradient' ? `${backgrounds.length} PRESETS` : 'MAKE IT YOURS'}
        </span>
      </div>
      <div className="flex rounded-lg bg-background p-1">
        {(
          [
            { key: 'gradient', label: 'Gradient', background: 'apricot' },
            { key: 'solid', label: 'Solid color', background: 'solid' },
            { key: 'pattern', label: 'Pattern', background: 'grid' },
            { key: 'image', label: 'Image', background: 'image' },
          ] as const
        ).map((tab) => (
          <Button
            key={tab.key}
            variant="ghost"
            className={cn(
              'h-7 min-w-0 flex-1 rounded-md px-1 text-[10px]',
              mode === tab.key && 'bg-secondary text-foreground',
            )}
            aria-pressed={mode === tab.key}
            disabled={disabled || loading}
            onClick={() =>
              change({
                background: tab.background,
                ...(tab.key === 'pattern' ? { color: patterns[0].color } : {}),
              })
            }
          >
            {tab.label}
          </Button>
        ))}
      </div>
      {mode === 'gradient' && (
        <>
          <div className="grid grid-cols-4 gap-2.5">
            {backgrounds.map((background) => (
              <Button
                key={background.id}
                variant="ghost"
                aria-label={`${background.name} background`}
                aria-pressed={settings.background === background.id}
                title={background.name}
                disabled={disabled}
                onClick={() =>
                  change({ background: background.id, gradientColors: [...background.colors] })
                }
                className={cn(
                  'relative h-10 w-full rounded-lg p-0 ring-offset-2 ring-offset-card',
                  settings.background === background.id && 'ring-2 ring-primary',
                )}
                style={{
                  background: `linear-gradient(${settings.gradientAngle}deg, ${background.colors.join(',')})`,
                }}
              >
                {settings.background === background.id && (
                  <TickCircle
                    variant="Bold"
                    className="absolute right-1 bottom-1 size-3.5 text-white drop-shadow-sm"
                  />
                )}
              </Button>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              {settings.background === 'custom-gradient' ? 'Custom gradient' : preset.name}
            </span>
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={() =>
                change({
                  background: 'custom-gradient',
                  gradientColors:
                    settings.background === 'custom-gradient'
                      ? settings.gradientColors
                      : [...preset.colors],
                })
              }
            >
              Customize colors
            </Button>
          </div>
          {settings.background === 'custom-gradient' && (
            <div className="grid grid-cols-3 gap-2">
              {settings.gradientColors.map((color, index) => (
                <div key={index} className="space-y-1.5">
                  <Label
                    htmlFor={`gradient-color-${index}`}
                    className="text-[10px] text-muted-foreground"
                  >
                    {['Start', 'Middle', 'End'][index]}
                  </Label>
                  <Input
                    id={`gradient-color-${index}`}
                    aria-label={`Gradient ${['start', 'middle', 'end'][index]} color`}
                    type="color"
                    value={color}
                    disabled={disabled}
                    className="h-9 cursor-pointer p-1"
                    onChange={(event) => {
                      const colors: [string, string, string] = [...settings.gradientColors];
                      colors[index] = event.target.value;
                      change({ gradientColors: colors });
                    }}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            {(['linear', 'radial'] as const).map((type) => (
              <Button
                key={type}
                size="sm"
                variant="outline"
                disabled={disabled}
                aria-pressed={settings.gradientType === type}
                className={cn(
                  'flex-1 text-[11px] capitalize',
                  settings.gradientType === type && 'border-primary/60 text-primary',
                )}
                onClick={() => change({ gradientType: type })}
              >
                {type}
              </Button>
            ))}
          </div>
          {settings.gradientType === 'linear' && (
            <div className="space-y-3">
              <div className="flex justify-between text-[11px]">
                <span>Direction</span>
                <output className="text-muted-foreground tabular-nums">
                  {settings.gradientAngle}°
                </output>
              </div>
              <Slider
                aria-label="Gradient direction"
                min={0}
                max={360}
                step={15}
                value={[settings.gradientAngle]}
                disabled={disabled}
                onValueChange={(value) =>
                  change({ gradientAngle: Array.isArray(value) ? value[0] : value })
                }
              />
            </div>
          )}
        </>
      )}
      {mode === 'solid' && (
        <div className="grid grid-cols-6 gap-2">
          {solidColors.map((color) => (
            <Button
              key={color}
              variant="ghost"
              aria-label={`Solid ${color}`}
              title={color}
              disabled={disabled}
              aria-pressed={settings.color === color}
              onClick={() => change({ color })}
              className={cn(
                'h-8 rounded-md p-0 ring-offset-2 ring-offset-card',
                settings.color === color && 'ring-2 ring-primary',
              )}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      )}
      {mode === 'pattern' && (
        <div className="grid grid-cols-2 gap-2">
          {patterns.map((item) => (
            <Button
              key={item.id}
              variant="outline"
              aria-label={`${item.name} pattern`}
              aria-pressed={settings.background === item.id}
              disabled={disabled}
              onClick={() => change({ background: item.id, color: item.color })}
              className={cn(
                'h-14 flex-col gap-1 text-[11px]',
                settings.background === item.id && 'border-primary text-primary',
              )}
              style={{
                backgroundColor: item.color,
                backgroundImage:
                  item.id === 'dots'
                    ? 'radial-gradient(#ffffff55 1px, transparent 1px)'
                    : item.id === 'diagonal'
                      ? 'repeating-linear-gradient(135deg, transparent, transparent 6px, #00000014 6px, #00000014 7px)'
                      : 'linear-gradient(#ffffff22 1px, transparent 1px), linear-gradient(90deg,#ffffff22 1px,transparent 1px)',
                backgroundSize: item.id === 'diagonal' ? 'auto' : '10px 10px',
              }}
            >
              <span className="rounded bg-background/85 px-2 py-1 text-foreground">
                {item.name}
              </span>
            </Button>
          ))}
        </div>
      )}
      {(mode === 'solid' || mode === 'pattern') && (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-background p-2">
          <Input
            aria-label="Background color"
            type="color"
            value={settings.color}
            onChange={(event) => change({ color: event.target.value })}
            disabled={disabled}
            className="h-9 w-12 cursor-pointer border-0 p-0.5"
          />
          <span className="text-xs text-muted-foreground uppercase">{settings.color}</span>
        </div>
      )}
      {mode === 'image' && (
        <div className="space-y-3">
          <Input
            ref={input}
            type="file"
            data-testid="background-image-input"
            aria-label="Background image file"
            accept="image/jpeg,image/png,image/webp"
            disabled={disabled || loading}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadImage(file);
              event.target.value = '';
            }}
          />
          {settings.backgroundImage && (
            <>
              <img
                src={settings.backgroundImage}
                alt="Selected background"
                className="aspect-video w-full rounded-lg object-cover"
              />
              <p className="truncate text-[10px] text-muted-foreground">
                {settings.backgroundImageName}
              </p>
            </>
          )}
          <Button
            variant="outline"
            className="h-10 w-full text-xs"
            disabled={disabled || loading}
            onClick={() => input.current?.click()}
          >
            <DocumentUpload />
            {loading
              ? 'Preparing image…'
              : settings.backgroundImage
                ? 'Change image'
                : 'Choose background image'}
          </Button>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            JPG, PNG, or WebP. Your image fills the canvas and stays on your Mac.
          </p>
          {settings.backgroundImage && (
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled || loading}
              onClick={() => change({ backgroundImage: null, backgroundImageName: '' })}
            >
              Remove image
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
