import { ArrowLeft, ArrowRight, Bookmark, Check, ChevronDown, CircleHelp, Download, Ellipsis, ExternalLink, Globe2, LockKeyhole, Plus, RotateCw, Settings2, ShieldCheck, ShieldOff, Star, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useBrowser } from '../store/browser';
import { getPage } from '../lib/data';
import { YouTubeMark } from './Brand';
import { Toggle } from './ui';

export function Chrome() {
  const { tabs, activeTabId, newTab, focusTab, closeTab, navigate, moveHistory, navigatePage, protection, setProtection, bookmarks, addBookmark, removeBookmark, notify, fullscreenState } = useBrowser();
  // The purple active state follows the REAL native window fullscreen state
  // (verified in the main process), not media fullscreen and not the last
  // click: window:false while a video is in media fullscreen must keep the
  // dot in its normal colour.
  const fullscreenActive = fullscreenState.window;
  const active = tabs.find(tab => tab.id === activeTabId) || tabs[0];
  const [address, setAddress] = useState(active.url);
  const [popover, setPopover] = useState<'shield' | 'menu' | 'tabs' | null>(null);
  const [reloading, setReloading] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const chromeRef = useRef<HTMLElement>(null);
  const bookmarked = bookmarks.find(item => item.url === active.url);

  useEffect(() => setAddress(active.url === 'core://newtab' ? '' : active.url), [active.url, active.id]);
  useEffect(() => {
    if (window.chromiumCore && getPage(active.url) === 'external') window.chromiumCore.focusTab(active.id, !popover);
  }, [popover, active.id, active.url]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key === 'l') { event.preventDefault(); addressRef.current?.focus(); addressRef.current?.select(); }
      if (event.key === 't') { event.preventDefault(); newTab(); }
      if (event.key === 'w') { event.preventDefault(); closeTab(activeTabId); }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, [activeTabId, closeTab, newTab]);
  useEffect(() => {
    const dismiss = (event: MouseEvent) => { if (!chromeRef.current?.contains(event.target as Node)) setPopover(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPopover(null); };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', dismiss); document.removeEventListener('keydown', escape); };
  }, []);

  const submit = (event: FormEvent) => { event.preventDefault(); if (address.trim()) { navigate(address); addressRef.current?.blur(); } };
  const reload = () => {
    setReloading(true);
    window.chromiumCore?.tabAction(active.id, 'reload');
    setTimeout(() => { setReloading(false); if (!window.chromiumCore) notify('Workspace refreshed. Your protection settings are up to date.'); }, 600);
  };
  const favorite = () => {
    if (bookmarked) { removeBookmark(bookmarked.id); notify('Bookmark removed.'); }
    else { addBookmark(active.title, active.url); notify('Added to your bookmarks.'); }
  };
  const go = (page: Parameters<typeof navigatePage>[0]) => { navigatePage(page); setPopover(null); };

  return <header className="browser-chrome" ref={chromeRef}>
    <div className="tab-strip"><div className="window-controls"><button className="window-dot close" aria-label="Close window" onClick={() => window.chromiumCore ? window.chromiumCore.windowAction('close') : notify('Window controls are available in the desktop app.', 'info')} /><button className="window-dot minimize" aria-label="Minimize window" onClick={() => window.chromiumCore ? window.chromiumCore.windowAction('minimize') : notify('Window controls are available in the desktop app.', 'info')} /><button className="window-dot maximize" aria-label="Maximize window" onClick={() => window.chromiumCore ? window.chromiumCore.windowAction('maximize') : notify('Window controls are available in the desktop app.', 'info')} /><button className={`window-dot fullscreen ${fullscreenActive ? 'active' : ''}`} aria-pressed={fullscreenActive} aria-label={fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'} title={fullscreenActive ? 'Exit fullscreen (F11)' : 'Fullscreen: use the entire display (F11)'} onClick={() => window.chromiumCore ? window.chromiumCore.windowAction('fullscreen') : notify('Browser fullscreen is available in the desktop app.', 'info')} /></div>
      <div className="browser-tabs" role="tablist" aria-label="Browser tabs">{tabs.map(tab => <div className={`browser-tab ${tab.id === activeTabId ? 'selected' : ''}`} key={tab.id}><button role="tab" aria-selected={tab.id === activeTabId} className="tab-main" onClick={() => focusTab(tab.id)}>{tab.url.includes('youtube.com') ? <YouTubeMark size={16} /> : tab.url === 'core://newtab' ? <Globe2 size={14} /> : tab.url.startsWith('core://') ? <ShieldCheck size={15} className="orange" /> : <Globe2 size={14} />}<span>{tab.title}</span></button><button className="tab-close" aria-label={`Close ${tab.title} tab`} onClick={() => closeTab(tab.id)}><X size={12} /></button></div>)}</div>
      <button className="new-tab-button" aria-label="New tab" title="New tab (Ctrl+T)" onClick={() => newTab()}><Plus size={17} /></button><div className="tab-strip-space" /><button className="tab-search-button" aria-label="Search open tabs" onClick={() => setPopover(popover === 'tabs' ? null : 'tabs')}><ChevronDown size={16} /></button>
    </div>
    <div className="browser-toolbar"><div className="navigation-controls"><button className="icon-button" aria-label="Go back" disabled={active.historyIndex === 0 && !window.chromiumCore} onClick={() => window.chromiumCore && getPage(active.url) === 'external' ? window.chromiumCore.tabAction(active.id, 'back') : moveHistory(-1)}><ArrowLeft size={18} /></button><button className="icon-button" aria-label="Go forward" disabled={active.historyIndex >= active.history.length - 1 && !window.chromiumCore} onClick={() => window.chromiumCore && getPage(active.url) === 'external' ? window.chromiumCore.tabAction(active.id, 'forward') : moveHistory(1)}><ArrowRight size={18} /></button><button className={`icon-button ${reloading ? 'spin' : ''}`} aria-label="Reload page" onClick={reload}><RotateCw size={16} /></button></div><form className="address-bar" onSubmit={submit}><LockKeyhole size={14} /><input ref={addressRef} aria-label="Address and search bar" value={address} placeholder="Search or enter a website address" onChange={event => setAddress(event.target.value)} onFocus={event => event.target.select()} spellCheck={false} /><button type="button" aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this page'} onClick={favorite}><Star size={16} fill={bookmarked ? 'currentColor' : 'none'} /></button></form><div className="toolbar-right"><button className={`icon-button shield-toolbar ${protection.enabled ? '' : 'off'}`} aria-label="Protection controls" onClick={() => setPopover(popover === 'shield' ? null : 'shield')}>{protection.enabled ? <ShieldCheck size={19} /> : <ShieldOff size={19} />}<span /></button><div className="toolbar-divider" /><button className="icon-button toolbar-download" aria-label="Open downloads" onClick={() => go('downloads')}><Download size={18} /></button><button className="profile-button" aria-label="Open profile settings" onClick={() => go('settings')}>C</button><button className="icon-button" aria-label="Browser menu" onClick={() => setPopover(popover === 'menu' ? null : 'menu')}><Ellipsis size={21} /></button></div></div>
    <AnimatePresence>{popover && <motion.div className={`chrome-popover ${popover === 'tabs' ? 'tabs-popover' : ''}`} initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }}>
      {popover === 'shield' ? <><div className="popover-title"><span className={`popover-shield ${!protection.enabled ? 'paused' : ''}`}><ShieldCheck size={23} /></span><div><strong>{protection.enabled ? 'You are protected' : 'Protection is paused'}</strong><p>Built into your browser. Always yours.</p></div></div><div className="popover-toggle"><span>Protection for all websites</span><Toggle label="Global protection" checked={protection.enabled} onChange={value => setProtection('enabled', value)} /></div><button className="popover-action" onClick={() => go('overview')}>Open protection overview <ArrowRight size={15} /></button><p className="popover-note">{window.chromiumCore ? 'Network filtering runs in your desktop session.' : 'Web preview. Download the desktop app for network protection.'}</p></> : popover === 'tabs' ? <><div className="popover-section-title">OPEN TABS <span>{tabs.length}</span></div>{tabs.map(tab => <button className="menu-item" key={tab.id} onClick={() => { focusTab(tab.id); setPopover(null); }}><Globe2 size={15} /><span>{tab.title}</span>{tab.id === activeTabId && <Check size={15} />}</button>)}</> : <><button className="menu-item" onClick={() => { newTab(); setPopover(null); }}><Plus size={16} /><span>New tab</span><kbd>Ctrl T</kbd></button><button className="menu-item" onClick={() => go('bookmarks')}><Bookmark size={16} /><span>Bookmarks</span></button><button className="menu-item" onClick={() => go('downloads')}><Download size={16} /><span>Downloads</span></button><div className="popover-divider" /><button className="menu-item" onClick={() => go('settings')}><Settings2 size={16} /><span>Settings</span></button><button className="menu-item" onClick={() => { notify('ChromiumCore 1.0.0. An independent browser built with Electron, React, and Ghostery.', 'info'); setPopover(null); }}><CircleHelp size={16} /><span>About ChromiumCore</span><ExternalLink size={13} /></button></>}
    </motion.div>}</AnimatePresence>
  </header>;
}