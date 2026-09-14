import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundlePaths, parseCursorTrack, parseRecordingMeta } from '../shared/recording';

describe('parseCursorTrack', () => {
  it('parses newline delimited events and keeps them time ordered', () => {
    const jsonl = [
      '{"t":0.5,"x":10,"y":20,"e":"m","b":-1}',
      '{"t":0.1,"x":1,"y":2,"e":"d","b":0}',
      '',
    ].join('\n');
    const events = parseCursorTrack(jsonl);
    expect(events).toHaveLength(2);
    expect(events[0].t).toBe(0.1);
    expect(events[0].e).toBe('d');
    expect(events[1].t).toBe(0.5);
  });

  it('skips malformed lines rather than throwing, so one bad line cannot lose a recording', () => {
    const jsonl = [
      '{"t":0,"x":1,"y":2,"e":"m","b":-1}',
      'not json at all',
      '{"t":1,"x":3,"y":4,"e":"u","b":0}',
    ].join('\n');
    expect(parseCursorTrack(jsonl)).toHaveLength(2);
  });
});

describe('parseRecordingMeta', () => {
  const valid = {
    version: 1,
    displayScale: 2,
    displayPoints: { w: 1920, h: 1080 },
    videoStartOffset: 0.031,
    duration: 7.93,
    createdAt: '2026-09-14T13:02:00.000Z',
  };

  it('accepts a well formed meta', () => {
    expect(parseRecordingMeta(valid).displayScale).toBe(2);
  });

  it('rejects a non positive display scale, which would break coordinate mapping', () => {
    expect(() => parseRecordingMeta({ ...valid, displayScale: 0 })).toThrow();
  });

  it('rejects a missing videoStartOffset rather than defaulting it to zero', () => {
    const { videoStartOffset: _omitted, ...without } = valid;
    expect(() => parseRecordingMeta(without)).toThrow();
  });
});

describe('bundlePaths', () => {
  it('resolves the three bundle members under the given directory', () => {
    const paths = bundlePaths('/tmp/rec');
    expect(paths.video).toBe(join('/tmp/rec', 'video.mov'));
    expect(paths.track).toBe(join('/tmp/rec', 'cursor.jsonl'));
    expect(paths.meta).toBe(join('/tmp/rec', 'meta.json'));
  });
});
