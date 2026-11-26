import { ArrowUpRight, BookOpen, ChevronRight, CircleCheck, Download, History, LayoutGrid, ListFilter, LockKeyhole, Settings2, ShieldCheck, Video } from 'lucide-react';
import { Brand, CoreMark } from './Brand';
import { useBrowser } from '../store/browser';
import type { Page } from '../types';

const mainNav = [
  { page: 'overview' as const, title: 'Overview', icon: LayoutGrid },
  { page: 'activity' as const, title: 'Browsing activity', icon: History },
  { page: 'filters' as const, title: 'Filter lists', icon: ListFilter },
  { page: 'allowlist' as const, title: 'Allowlist', icon: CircleCheck },
  { page: 'youtube' as const, title: 'YouTube protection', icon: Video },
];

export function Sidebar({ page, mobileOpen, closeMobile }: { page: Page; mobileOpen: boolean; closeMobile: () => void }) {
  const navigate = useBrowser(state => state.navigatePage);
  const protection = useBrowser(state => state.protection.enabled);
  const go = (target: Exclude<Page, 'external'>) => { navigate(target); closeMobile(); };
  return <>
    {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={closeMobile} />}
    <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
      <button className="brand-button" aria-label="ChromiumCore overview" onClick={() => go('overview')}><Brand /></button>
      <div className="nav-section-label">YOUR BROWSER</div>
      <nav aria-label="Browser workspace">{mainNav.map(({ page: target, title, icon: Icon }) => <button key={target} onClick={() => go(target)} className={`nav-item ${page === target ? 'active' : ''}`} aria-current={page === target ? 'page' : undefined}><Icon size={18} strokeWidth={1.7} /><span>{title}</span>{target === 'youtube' && <span className="nav-new">NEW</span>}</button>)}</nav>
      <div className="sidebar-divider" />
      <div className="nav-section-label second-label">WORKSPACE</div>
      <nav aria-label="Workspace tools"><button onClick={() => go('bookmarks')} className={`nav-item ${page === 'bookmarks' ? 'active' : ''}`}><BookOpen size={18} strokeWidth={1.7} /><span>Bookmarks</span></button><button onClick={() => go('downloads')} className={`nav-item ${page === 'downloads' ? 'active' : ''}`}><Download size={18} strokeWidth={1.7} /><span>Downloads</span><span className="nav-download-dot" /></button></nav>
      <div className="sidebar-bottom">
        <div className="privacy-message"><div className={`privacy-mark ${!protection ? 'paused' : ''}`}><ShieldCheck size={24} strokeWidth={1.5} /></div><h4>{protection ? 'Quietly looking out for you.' : 'Protection is paused.'}</h4><p>{protection ? 'Your internet. Without the unwanted company.' : 'Turn protection back on when you are ready.'}</p><button onClick={() => go('settings')}>You are in control <ArrowUpRight size={13} /></button></div>
        <button onClick={() => go('settings')} className={`nav-item settings-nav ${page === 'settings' ? 'active' : ''}`}><Settings2 size={18} strokeWidth={1.7} /><span>Settings</span></button>
        <div className="sidebar-version"><span className="version-icon"><CoreMark size={19} /></span><span>ChromiumCore <small>v1.0.0</small></span><button aria-label="About ChromiumCore" onClick={() => go('downloads')}><ChevronRight size={15} /></button></div>
      </div>
      <div className="sidebar-secure"><LockKeyhole size={11} /> Private by design.</div>
    </aside>
  </>;
}