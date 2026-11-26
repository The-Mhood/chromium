import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Bell, ChevronDown, ChevronRight, CircleHelp, LayoutGrid, Menu, ShieldCheck, ShieldOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Chrome } from './components/Chrome';
import { Sidebar } from './components/Sidebar';
import { Toast } from './components/ui';
import { getPage, pageDetails } from './lib/data';
import { Overview } from './pages/Overview';
import { Activity } from './pages/Activity';
import { Filters } from './pages/Filters';
import { Allowlist } from './pages/Allowlist';
import { Settings, YouTubeProtection } from './pages/Settings';
import { Bookmarks } from './pages/Bookmarks';
import { NewTab, ExternalPage } from './pages/NewTab';
import { Downloads } from './pages/Downloads';
import { useBrowser } from './store/browser';

export default function App() {
  const { tabs, activeTabId, protection, setProtection, filters, allowlist, theme, doNotTrack, nativeStats, setNativeStats, updateTab, newTab, notify, navigatePage, fullscreenState, setFullscreenState } = useBrowser();
  const active = tabs.find(tab => tab.id === activeTabId) || tabs[0];
  const page = getPage(active.url);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [systemDark, setSystemDark] = useState(window.matchMedia('(prefers-color-scheme: dark)').matches);
  const scroll = useRef<HTMLElement>(null);
  const simplePage = page === 'newtab' || page === 'external';
  const dark = theme === 'dark' || (theme === 'system' && systemDark);

  useEffect(() => { document.documentElement.classList.toggle('theme-dark', dark); }, [dark]);
  useEffect(() => { const match = window.matchMedia('(prefers-color-scheme: dark)'); const update = () => setSystemDark(match.matches); match.addEventListener('change', update); return () => match.removeEventListener('change', update); }, []);
  useEffect(() => { scroll.current?.scrollTo({ top: 0 }); setNotifications(false); setHelpOpen(false); }, [page, active.id]);
  useEffect(() => {
    if (!window.chromiumCore) return;
    const bridge = window.chromiumCore;
    bridge.getStats().then(setNativeStats).catch(() => notify('Protection statistics could not be loaded.', 'error'));
    const offStats = bridge.onStats(setNativeStats);
    const offTab = bridge.onTabUpdate(updateTab);
    const offOpen = bridge.onOpenTab(tab => newTab(tab.url, tab.title));
    const offChrome = bridge.onChromeVisibility(setChromeVisible);
    const offFullscreen = bridge.onFullscreenState(setFullscreenState);
    const offPopup = bridge.onPopupBlocked(() => notify('Blocked an unwanted popup.', 'info'));
    return () => { offStats(); offTab(); offOpen(); offChrome(); offFullscreen(); offPopup(); };
  }, [setNativeStats, updateTab, newTab, notify, setFullscreenState]);
  useEffect(() => {
    const bridge = window.chromiumCore;
    if (!bridge) return;
    bridge.focusTab(active.id, page === 'external').then(() => {
      if (page === 'external') return bridge.navigate(active.id, active.url);
    }).catch(() => notify('This page could not be opened. Try another address.', 'error'));
  }, [active.id, active.url, page, notify]);
  useEffect(() => { window.chromiumCore?.setProtection(protection).catch(() => notify('Protection settings could not be applied.', 'error')); }, [protection, notify]);
  useEffect(() => { window.chromiumCore?.setAllowlist(allowlist).catch(() => notify('Allowlist could not be applied.', 'error')); }, [allowlist, notify]);
  useEffect(() => { window.chromiumCore?.setFilters(filters).catch(() => notify('Filter lists could not be applied.', 'error')); }, [filters, notify]);
  useEffect(() => { window.chromiumCore?.setPrivacy(doNotTrack).catch(() => notify('Privacy preference could not be applied.', 'error')); }, [doNotTrack, notify]);

  const pages = { overview: <Overview />, activity: <Activity />, filters: <Filters />, allowlist: <Allowlist />, youtube: <YouTubeProtection />, bookmarks: <Bookmarks />, downloads: <Downloads />, settings: <Settings />, newtab: <NewTab />, external: <ExternalPage url={page === 'external' ? active.url : 'https://example.com'} title={active.title} /> };

  return <div className={`app-shell ${!chromeVisible || fullscreenState.media ? "chrome-hidden" : ""}`}><Chrome /><div className={`workspace ${simplePage ? 'simple-workspace' : ''}`}>
    {!simplePage && <Sidebar page={page} mobileOpen={mobileOpen} closeMobile={() => setMobileOpen(false)} />}
    <main ref={scroll} className={`workspace-main ${simplePage ? 'full-width' : ''}`}>
      {!simplePage && <div className="workspace-topbar"><div className="breadcrumb"><button className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={19} /></button><LayoutGrid size={14} /><button onClick={() => navigatePage('overview')}>Workspace</button><ChevronRight size={12} /><span>{pageDetails[page as keyof typeof pageDetails]?.title}</span></div><div className="workspace-topbar-right"><button className={`global-protection ${!protection.enabled ? 'paused' : ''}`} onClick={() => { setProtection('enabled', !protection.enabled); notify(protection.enabled ? 'Protection paused. You can turn it back on at any time.' : 'Protection is back on. Welcome to a quieter web.', protection.enabled ? 'info' : 'success'); }}>{protection.enabled ? <ShieldCheck size={14} /> : <ShieldOff size={14} />}<span>{protection.enabled ? 'Protection is on' : 'Protection paused'}</span><ChevronDown size={12} /></button><span className="topbar-divider" /><div className="workspace-popover-anchor"><button className="icon-button small" aria-label="Notifications" aria-expanded={notifications} onClick={() => { setNotifications(!notifications); setHelpOpen(false); }}><Bell size={17} /><span className="notification-dot" /></button><AnimatePresence>{notifications && <motion.div className="workspace-popover" initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }}><div className="workspace-popover-heading"><h3>A little peace of mind.</h3><button className="icon-button small" aria-label="Close notifications" onClick={() => setNotifications(false)}><X size={15} /></button></div><div className="notification-item"><span className="notification-icon"><ShieldCheck size={18} /></span><div><strong>{protection.enabled ? 'Your protection is ready.' : 'Protection is currently paused.'}</strong><p>{window.chromiumCore ? `${(nativeStats?.ads || 0) + (nativeStats?.trackers || 0)} requests stopped this session.` : 'Your web preview preferences are saved locally. Get the desktop app for native protection.'}</p><span>Just now</span></div></div><button className="popover-action" onClick={() => navigatePage('downloads')}>Explore the desktop app<ArrowRight size={14} /></button></motion.div>}</AnimatePresence></div><div className="workspace-popover-anchor"><button className="icon-button small help-button" aria-label="Help and information" onClick={() => { setHelpOpen(!helpOpen); setNotifications(false); }}><CircleHelp size={17} /></button>{helpOpen && <div className="workspace-popover help-popover"><h3>A browser on your side.</h3><p>Explore the controls, manage your filters, and make ChromiumCore your own. Changes are saved on this device.</p><p>{window.chromiumCore ? 'Your native desktop browser uses Ghostery network filtering.' : 'You are using the web preview. The dashboard shows clearly labeled sample activity.'}</p><button className="text-link" onClick={() => navigatePage('downloads')}>Get ChromiumCore<ArrowRight size={13} /></button></div>}</div></div></div>}
      <AnimatePresence mode="wait" initial={false}><motion.div key={page} className={simplePage ? 'simple-page-content' : 'page-content'} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: .23, ease: 'easeOut' }}>{pages[page]}</motion.div></AnimatePresence>
    </main>
  </div><Toast /></div>;
}