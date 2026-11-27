import { ArrowUpRight, Copy, Download, ExternalLink, Link2, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface DialogData {
  url: string;
  title: string;
  media: boolean;
  sourceTabId: string | null;
}

/**
 * The double-click link options. Rendered in its own small frameless window
 * (loaded in "dialog mode" — see main.tsx), positioned at the double-click
 * point by the main process. Same design language as the chrome popovers;
 * keyboard accessible (Tab/Enter/Space) and dismissed with Escape or an
 * outside click (the window closes on blur).
 */
export function LinkDialog() {
  const [data, setData] = useState<DialogData | null>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const bridge = window.chromiumCore;
    if (!bridge) return;
    const offData = bridge.onDialogData(setData);
    const dismiss = () => { bridge.dialogAction('close'); };
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } };
    document.addEventListener('keydown', keyboard);
    // Focus the first action once the data (and the buttons) exist.
    requestAnimationFrame(() => firstActionRef.current?.focus());
    return () => { offData(); document.removeEventListener('keydown', keyboard); };
  }, []);

  useEffect(() => {
    if (data) requestAnimationFrame(() => firstActionRef.current?.focus());
  }, [data]);

  if (!data) return null;

  let host = '';
  try { host = new URL(data.url).hostname.replace(/^www\./, ''); } catch { host = data.url; }
  const act = (action: Parameters<NonNullable<typeof window.chromiumCore>['dialogAction']>[0]) => {
    window.chromiumCore?.dialogAction(action, { url: data.url, sourceTabId: data.sourceTabId });
  };

  const actions: { id: Parameters<NonNullable<typeof window.chromiumCore>['dialogAction']>[0]; label: string; icon: typeof Plus; kbd?: string }[] = [
    { id: 'open-link', label: 'Open link', icon: ArrowUpRight },
    { id: 'open-tab', label: 'Open in new tab', icon: Plus },
    { id: 'open-window', label: 'Open in new window', icon: ExternalLink },
    { id: 'copy', label: 'Copy link address', icon: Copy },
    // Only shown for links that actually point at media or carry a
    // `download` attribute (the page script reports this in the payload).
    ...(data.media ? [{ id: 'download' as const, label: 'Download attached media', icon: Download }] : []),
  ];

  return (
    <div className="link-dialog-backdrop">
      <div className="link-dialog" role="dialog" aria-modal="true" aria-label="Link options">
        <div className="link-dialog-heading">
          <span className="link-dialog-mark"><Link2 size={13} /></span>
          <div className="link-dialog-heading-text">
            <strong>{data.title || host}</strong>
            <p>Double-clicked link</p>
          </div>
          <button className="icon-button small" aria-label="Close link options" onClick={() => act('close')}><X size={15} /></button>
        </div>
        <p className="link-dialog-url" title={data.url}>{data.url}</p>
        <div className="link-dialog-actions" role="menu" aria-label="Link actions">
          {actions.map(({ id, label, icon: Icon }, index) => (
            <button
              key={id}
              ref={index === 0 ? firstActionRef : undefined}
              role="menuitem"
              className="menu-item link-dialog-item"
              onClick={() => act(id)}
            >
              <Icon size={15} />
              <span>{label}</span>
              {id === 'open-link' && <kbd>↵</kbd>}
            </button>
          ))}
        </div>
        <p className="link-dialog-hint">Double-click any link to open these options. <kbd>Esc</kbd> to dismiss.</p>
      </div>
    </div>
  );
}
