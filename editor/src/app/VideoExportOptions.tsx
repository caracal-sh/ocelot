import { VIDEO_PRESETS, VIDEO_PRESET_CHOICES, type VideoSettings, type VideoTarget } from '../export/videoExport';

export const VIDEO_TARGETS: Array<{ value: VideoTarget; label: string }> = [
  { value: 'mp4', label: 'Video (MP4)' },
  { value: 'alpha', label: 'Transparent video (MOV)' },
  { value: 'gif', label: 'Animated GIF' },
  { value: 'files', label: 'Scenes as files (PNG, JPG, PDF)' },
];

/** What a video page's Export popover shows instead of the image options: the target, then size and codec for video targets. */
export function VideoExportOptions({ settings, busy, onChange }: { settings: VideoSettings; busy: boolean; onChange(patch: Partial<VideoSettings>): void }) {
  const video = settings.target !== 'files';
  return (
    <>
      <div className="at-export__deck" role="radiogroup" aria-label="Export as" data-testid="export-video-target">
        {VIDEO_TARGETS.map((t) => (
          <label key={t.value} className="at-check">
            <input type="radio" name="export-video-target" checked={settings.target === t.value} disabled={busy} onChange={() => onChange({ target: t.value })} data-value={t.value} />
            {t.label}
          </label>
        ))}
      </div>
      {video && settings.target !== 'gif' && (
        <div className="at-export__row">
          <span className="at-export__label">Size</span>
          <select
            className="at-input"
            aria-label="Video size"
            value={settings.preset}
            disabled={busy}
            onChange={(e) => onChange({ preset: e.currentTarget.value as VideoSettings['preset'] })}
            data-testid="export-video-preset"
          >
            {VIDEO_PRESET_CHOICES.map((id) => (
              <option key={id} value={id}>
                {VIDEO_PRESETS[id].label}
              </option>
            ))}
          </select>
        </div>
      )}
      {(settings.target === 'mp4' || settings.target === 'alpha') && (
        <label
          className="at-check"
          data-tip={settings.target === 'mp4' ? 'HEVC files are about 40% smaller; older players may not open them.' : 'HEVC with alpha is tiny and plays in Apple apps and Safari; ProRes 4444 opens in video editors.'}
        >
          <input type="checkbox" checked={settings.compact} disabled={busy} onChange={(e) => onChange({ compact: e.currentTarget.checked })} data-testid="export-video-compact" />
          {settings.target === 'mp4' ? 'HEVC (smaller file)' : 'HEVC with alpha (smaller file)'}
        </label>
      )}
      {video && <p className="at-hint">{settings.target === 'gif' ? 'GIFs are 960 px wide at 20 fps, up to 30 seconds, without sound.' : 'Scenes in page order with their transitions, without sound. It renders in the background; you can keep working.'}</p>}
    </>
  );
}
