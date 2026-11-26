import { ArrowRight, ArrowUpRight, ExternalLink, Globe2, Plus, Search, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useBrowser } from '../store/browser';
import { Brand, CoreMark, SiteIcon } from '../components/Brand';

export function NewTab() {
  const [query, setQuery] = useState('');
  const { navigate, navigatePage, bookmarks, protection } = useBrowser();
  const search = (event: FormEvent) => { event.preventDefault(); if (query.trim()) navigate(query); };
  return <div className="new-tab-page"><div className="new-tab-top"><Brand /><button className="button button-white" onClick={() => navigatePage('overview')}><ShieldCheck size={14} />Protection overview<ArrowUpRight size={13} /></button></div><main className="new-tab-main"><div className="new-tab-wordmark"><CoreMark size={58} /><span>chromiumcore<span className="wordmark-period">.</span></span></div><h1>A little less noise.<br />A lot more internet.</h1><form className="new-tab-search" onSubmit={search}><Search size={20} /><input aria-label="Search the web" placeholder="Where will your curiosity take you?" value={query} onChange={event => setQuery(event.target.value)} autoFocus /><button aria-label="Search"><ArrowRight size={20} /></button></form><div className="quick-links">{bookmarks.slice(0, 5).map(item => <button key={item.id} onClick={() => navigate(item.url)}><SiteIcon domain={item.url.startsWith('core://') ? 'chromiumcore.app' : new URL(item.url).hostname} size={43} /><span>{item.title}</span></button>)}<button onClick={() => navigatePage('bookmarks')}><span className="quick-add"><Plus size={22} /></span><span>Add shortcut</span></button></div></main><div className="new-tab-footer"><span><span className={`status-dot ${!protection.enabled ? 'paused' : ''}`} />{protection.enabled ? 'Your next adventure is protected.' : 'Protection is paused.'}</span><span>Private by design. Human by nature.</span></div></div>;
}

export function ExternalPage({ url, title }: { url: string; title: string }) {
  const { navigatePage, protection } = useBrowser();
  const hostname = new URL(url).hostname.replace(/^www\./, '');
  return <div className="external-page"><div className="external-preview-label"><Globe2 size={14} />BROWSER PREVIEW</div><SiteIcon domain={hostname} size={68} /><h1>{title}</h1><p className="external-url">{url}</p><p>This website is ready to explore.<br />In the web preview, external sites open in a new window.</p><a className="button button-primary" href={url} target="_blank" rel="noopener noreferrer">Open {hostname}<ExternalLink size={15} /></a><button className="text-link" onClick={() => navigatePage('downloads')}>Browse natively with the desktop app<ArrowRight size={14} /></button><div className="external-note"><ShieldCheck size={15} />{window.chromiumCore ? 'Loading your protected browsing session...' : `${protection.enabled ? 'Network-level protection is available' : 'Enable built-in protection'} in ChromiumCore for Windows and macOS.`}</div></div>;
}