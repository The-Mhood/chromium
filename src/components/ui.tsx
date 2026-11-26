import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpRight, Check, CheckCircle2, CircleHelp, Info, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useBrowser } from '../store/browser';

export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`toggle ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}><span /></button>;
}

export function PageHeading({ eyebrow, title, description, children }: { eyebrow?: string; title: string; description: string; children?: ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1><p>{description}</p></div>{children && <div className="heading-actions">{children}</div>}</div>;
}

export function Modal({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const focusable = container.current?.querySelectorAll<HTMLElement>('button, input, select, a[href], textarea');
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    const timer = setTimeout(() => container.current?.querySelector<HTMLElement>('input, button')?.focus(), 70);
    return () => { document.removeEventListener('keydown', key); clearTimeout(timer); previous?.focus(); };
  }, [onClose]);
  return createPortal(<motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><motion.div ref={container} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" initial={{ opacity: 0, y: 15, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }}><button className="icon-button modal-close" aria-label="Close dialog" onClick={onClose}><X size={18} /></button><div className="modal-symbol"><CircleHelp size={23} /></div><h2 id="modal-title">{title}</h2>{description && <p className="modal-description">{description}</p>}{children}</motion.div></motion.div>, document.body);
}

export function Toast() {
  const toast = useBrowser(state => state.toast);
  const dismiss = useBrowser(state => state.dismissToast);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(dismiss, 4800);
    return () => clearTimeout(timer);
  }, [toast, dismiss]);
  return createPortal(<AnimatePresence>{toast && <motion.div key={toast.key} role="status" className={`toast toast-${toast.tone}`} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}>{toast.tone === 'success' ? <CheckCircle2 size={19} /> : <Info size={19} />}<span>{toast.text}</span><button aria-label="Dismiss notification" onClick={dismiss}><X size={16} /></button></motion.div>}</AnimatePresence>, document.body);
}

export function EmptyState({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{description}</p>{children}</div>;
}

export function PreviewNote() {
  const notify = useBrowser(state => state.notify);
  if (window.chromiumCore) return null;
  return <button className="preview-note" onClick={() => notify('This web preview uses sample activity. Download the desktop app for real network-level protection.', 'info')}><span className="tiny-dot" />Preview data<ArrowUpRight size={12} /></button>;
}

export function SavedIndicator() {
  return <span className="saved-indicator"><Check size={13} /> Saved on this device</span>;
}