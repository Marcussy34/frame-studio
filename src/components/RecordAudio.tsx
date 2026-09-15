import { useEffect, useRef, useState } from 'react';
import { InfoCircle, Microphone2, VolumeHigh } from 'iconsax-reactjs';
import {
  describeLevel,
  QUIET_DBFS,
  SILENT_DBFS,
  type AudioInput,
  type AudioOptions,
  type MicrophoneAccess,
} from '../../shared/recording';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

interface Props {
  value: AudioOptions;
  onChange: (next: AudioOptions) => void;
  // Listening stops while a countdown runs or the dialog is closed, so nothing holds
  // the microphone open in the background.
  listen: boolean;
  // Undefined while the permission report is still being fetched, which is different
  // from knowing the microphone is denied.
  access: MicrophoneAccess | undefined;
  onRequestAccess: () => void;
}

// How often the level is fetched. Fast enough to look live, slow enough that a dialog
// left open is not making twenty requests a second.
const LEVEL_POLL_MS = 120;
// A level bar covers this much range. Below it there is nothing to show.
const METER_FLOOR = SILENT_DBFS - 20;
// The select's stand-in for "whatever macOS has set". Never an empty string: base-ui
// reads that as no value at all and greys the trigger out as an unfilled placeholder.
const DEFAULT_DEVICE = 'default';

export function RecordAudio({ value, onChange, listen, access, onRequestAccess }: Props) {
  const [inputs, setInputs] = useState<AudioInput[]>([]);
  const [peak, setPeak] = useState(METER_FLOOR);
  const [error, setError] = useState<string | null>(null);
  // Held across renders so the meter can say "nothing yet" rather than "silent" in the
  // second before the first buffer arrives.
  const loudest = useRef(METER_FLOOR);
  // Starting and stopping the check must never overtake one another. Changing the input
  // device tears down one effect and sets up the next, and a stop that landed after the
  // following start would leave a meter polling a stream nobody is feeding.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = (run: () => Promise<unknown>) => {
    queue.current = queue.current.then(run, run);
    return queue.current;
  };
  // Nothing to stop until something has been started, so an unopened dialog makes no
  // requests at all.
  const opened = useRef(false);

  useEffect(() => {
    if (!listen) return;
    api<{ inputs: AudioInput[] }>('/api/audio-inputs')
      .then((body) => setInputs(body.inputs))
      .catch(() => setInputs([]));
  }, [listen]);

  // Opening the chosen input and watching it. ScreenCaptureKit mixes the microphone into
  // a single track with system audio, so a muted or wrongly chosen input cannot be
  // rescued afterwards, and the system default is often a pair of speakers.
  //
  // Only once macOS has actually allowed it. Asking ScreenCaptureKit for an input that
  // has not been granted does not fail, it blocks: measured, a pending microphone
  // decision left replayd's kTCCServiceMicrophone queue stuck and every later capture,
  // in every process, queued behind it.
  const wanted = listen && value.microphone && access === 'granted';
  useEffect(() => {
    const stop = () => {
      if (!opened.current) return;
      opened.current = false;
      void enqueue(() => api('/api/recording/mic-check', { method: 'DELETE' }).catch(() => {}));
    };
    if (!wanted) {
      stop();
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    loudest.current = METER_FLOOR;
    setPeak(METER_FLOOR);
    setError(null);

    const poll = async () => {
      try {
        const level = await api<{ listening: boolean; peak: number }>('/api/recording/mic-level');
        if (cancelled) return;
        setPeak(level.peak);
        loudest.current = Math.max(loudest.current, level.peak);
      } catch {
        // A single missed poll is not worth an error message. The next one will say so.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), LEVEL_POLL_MS);
    };

    opened.current = true;
    void enqueue(() =>
      api('/api/recording/mic-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: value.device }),
      })
        .then(() => {
          if (!cancelled) void poll();
        })
        .catch((cause: Error) => {
          if (!cancelled) setError(cause.message);
        }),
    );

    return () => {
      cancelled = true;
      clearTimeout(timer);
      stop();
    };
    // access is a dependency on purpose. A stream opened before the grant existed keeps
    // delivering silence afterwards, so granting the microphone in System Settings while
    // this panel is open has to start a fresh one.
  }, [wanted, value.device, access]);

  const level = describeLevel(wanted ? loudest.current : undefined);
  const scale = (dbfs: number) => Math.max(0, Math.min(1, (dbfs - METER_FLOOR) / -METER_FLOOR));
  const filled = scale(peak);
  const loudestFill = wanted ? scale(loudest.current) : 0;
  // Where speech should be reaching, so the bar has something to aim at rather than
  // just being long or short.
  const targetFill = scale(QUIET_DBFS);

  // "System default" is what macOS hands over when no device is named, but which device
  // that actually is matters: on this machine it is a pair of speakers. Naming it turns
  // a vague setting into an obvious one.
  const defaultInput = inputs.find((input) => input.isDefault);
  const defaultLabel = defaultInput ? `System default (${defaultInput.name})` : 'System default';
  const chosenName = value.device
    ? (inputs.find((input) => input.id === value.device)?.name ?? 'Selected input')
    : defaultLabel;

  return (
    <div className="space-y-2">
      <Label>Sound</Label>

      {/* The label sits beside the switch rather than wrapping it, matching the export
          dialog. A label that wraps its own control can forward a second activation to
          it, which on a switch cancels the first one out. */}
      <div className="space-y-1">
        <div className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-card/45 px-3 py-2.5">
          <VolumeHigh className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <Label htmlFor="record-system-audio" className="text-xs font-medium">
              System audio
            </Label>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Whatever is playing on this Mac, minus Frame Studio itself.
            </p>
          </div>
          <Switch
            id="record-system-audio"
            checked={value.system}
            onCheckedChange={(next) => onChange({ ...value, system: next })}
          />
        </div>

        <div className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-card/45 px-3 py-2.5">
          <Microphone2 className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <Label htmlFor="record-microphone" className="text-xs font-medium">
              Microphone
            </Label>
            <p className="mt-0.5 text-[10px] text-muted-foreground">Narrate while you record.</p>
          </div>
          <Switch
            id="record-microphone"
            checked={value.microphone}
            onCheckedChange={(next) => onChange({ ...value, microphone: next })}
          />
        </div>
      </div>

      {/* Asked for only once the microphone is actually wanted, so nobody is prompted
          for a grant they were never going to use. */}
      {value.microphone && access !== undefined && access !== 'granted' && (
        <div className="space-y-2 rounded-lg border border-primary/70 bg-primary/8 p-3">
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <InfoCircle className="mt-px size-4 shrink-0 text-primary" />
            <span>
              {access === 'not-determined'
                ? 'macOS has not been asked for the microphone yet. Recording will be silent until it is allowed.'
                : 'macOS is blocking the microphone, so a recording would be silent. Allow Frame Studio in System Settings, Privacy and Security, Microphone.'}
            </span>
          </p>
          {access === 'not-determined' && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 w-full text-xs"
              onClick={onRequestAccess}
            >
              Allow microphone
            </Button>
          )}
        </div>
      )}

      {value.microphone && (
        <div className="space-y-2.5 rounded-lg border border-border/70 bg-card/45 p-3">
          <div className="space-y-1.5">
            <Label htmlFor="record-mic-device" className="text-[10px] text-muted-foreground">
              Input
            </Label>
            <Select
              value={value.device || DEFAULT_DEVICE}
              onValueChange={(next) => {
                if (typeof next !== 'string') return;
                onChange({ ...value, device: next === DEFAULT_DEVICE ? '' : next });
              }}
            >
              <SelectTrigger id="record-mic-device" aria-label="Input" className="h-9 w-full">
                <SelectValue>{chosenName}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {/* Never an empty string: base-ui reads that as no value at all and
                    styles the trigger as an unfilled placeholder. */}
                <SelectItem value={DEFAULT_DEVICE}>{defaultLabel}</SelectItem>
                {inputs.map((input) => (
                  <SelectItem key={input.id} value={input.id}>
                    {input.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* The level is the point of this panel. Both sources land on one track that
              cannot be unmixed, so this is the only chance to notice silence. The number
              matters as much as the bar: at a noise floor near -74 dBFS the bar is a
              sliver, which reads as broken rather than as nothing arriving. */}
          <div className="flex items-center gap-2">
            <div
              role="meter"
              aria-label="Microphone level"
              aria-valuemin={METER_FLOOR}
              aria-valuemax={0}
              aria-valuenow={Math.round(peak)}
              className="relative h-2 flex-1 overflow-hidden rounded-full bg-secondary"
            >
              <div
                className={cn(
                  'h-full rounded-full transition-[width] duration-100',
                  level === 'good'
                    ? 'bg-primary'
                    : level === 'quiet'
                      ? 'bg-amber-500'
                      : 'bg-muted-foreground/40',
                )}
                style={{ width: `${filled * 100}%` }}
              />
              {/* Holds the loudest moment so a single word still leaves a mark, and
                  where speech should be reaching, so there is something to aim at. */}
              {loudestFill > 0.02 && (
                <span
                  aria-hidden
                  className="absolute inset-y-0 w-0.5 rounded-full bg-foreground/70"
                  style={{ left: `calc(${Math.min(loudestFill, 1) * 100}% - 1px)` }}
                />
              )}
              <span
                aria-hidden
                className="absolute inset-y-0 w-px bg-foreground/20"
                style={{ left: `${targetFill * 100}%` }}
              />
            </div>
            <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
              {peak <= METER_FLOOR ? 'no signal' : `${Math.round(peak)} dB`}
            </span>
          </div>

          <p className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
            <InfoCircle className="mt-px size-3 shrink-0" />
            <span>
              {error
                ? error
                : access !== 'granted'
                  ? 'Waiting for macOS to allow the microphone. Nothing is being recorded from it yet.'
                  : level === 'good'
                    ? 'Sounds good. Speak at this level while you record.'
                    : level === 'quiet'
                      ? 'Audible but faint. Move closer, or choose a different input.'
                      : 'Say something. If nothing moves, this input cannot hear you: the system default is often speakers or a webcam rather than your microphone.'}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
