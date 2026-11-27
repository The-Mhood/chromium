import { ArrowRight, ArrowUpRight, CloudOff, ExternalLink, Globe2, Plus, RefreshCw, Search, ShieldCheck, ShieldOff } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useBrowser } from '../store/browser';
import { Brand, CoreMark, SiteIcon } from '../components/Brand';
import type { TabIssue } from '../types';

export function NewTab() {
  const [query, setQuery] = useState('');
  const { navigate, navigatePage, bookmarks, protection } = useBrowser();
  const search = (event: FormEvent) => { event.preventDefault(); if (query.trim()) navigate(query); };
  return <div className="new-tab-page"><div className="new-tab-top"><Brand /><button className="button button-white" onClick={() => navigatePage('overview')}><ShieldCheck size={14} />Protection overview<ArrowUpRight size={13} /></button></div><main className="new-tab-main"><div className="new-tab-wordmark"><CoreMark size={58} /><span>chromiumcore<span className="wordmark-period">.</span></span></div><h1>A little less noise.<br />A lot more internet.</h1><form className="new-tab-search" onSubmit={search}><Search size={20} /><input aria-label="Search the web" placeholder="Where will your curiosity take you?" value={query} onChange={event => setQuery(event.target.value)} autoFocus /><button aria-label="Search"><ArrowRight size={20} /></button></form><div className="quick-links">{bookmarks.slice(0, 5).map(item => <button key={item.id} onClick={() => navigate(item.url)}><SiteIcon domain={item.url.startsWith('core://') ? 'chromiumcore.app' : new URL(item.url).hostname} size={43} /><span>{item.title}</span></button>)}<button onClick={() => navigatePage('bookmarks')}><span className="quick-add"><Plus size={22} /></span><span>Add shortcut</span></button></div></main><div className="new-tab-footer"><span><span className={`status-dot ${!protection.enabled ? 'paused' : ''}`} />{protection.enabled ? 'Your next adventure is protected.' : 'Protection is paused.'}</span><span>Private by design. Human by nature.</span></div></div>;
}

/** What the loading card shows for the URL: host and path — long tracking
 *  query strings ("jargon") are not information the user needs while the
 *  page loads. */
function loadingUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    let shown = parsed.host + path;
    if (shown.length > 64) shown = `${shown.slice(0, 61)}…`;
    return shown;
  } catch {
    return url;
  }
}

export function ExternalPage({ url, title, issue }: { url: string; title: string; issue?: TabIssue }) {
  const { navigate, navigatePage, protection } = useBrowser();
  const hostname = new URL(url).hostname.replace(/^www\./, '');
  if (window.chromiumCore) {
    // Desktop app: the tab's WebContentsView loads over this card as soon as
    // the page paints. Never present a click-to-open prompt here — the
    // navigation is already in flight, and a slow first byte should read as
    // "loading", not as a request for permission.
    if (issue && issue.url === url && issue.kind === 'blocked') {
      const label = { Ad: 'ad filtering', Tracker: 'tracker blocking', 'Pop-up': 'popup protection', Threat: 'malware protection' }[issue.type ?? 'Ad'];
      return <div className="external-page"><div className="external-icon-tile danger"><ShieldOff size={30} /></div><h1>Blocked by protection</h1><p className="external-url">{url}</p><p>This page was stopped by {label} before it could load.</p><button className="button button-primary" onClick={() => navigatePage('activity')}>See blocked requests<ArrowRight size={15} /></button><div className="external-note"><ShieldCheck size={15} />Add the domain to your allowlist to load this page.</div></div>;
    }
    if (issue && issue.url === url && issue.kind === 'failed') {
      return <div className="external-page"><div className="external-icon-tile"><CloudOff size={30} /></div><h1>Couldn't reach {hostname}</h1><p className="external-url">{url}</p><p>The address could not be loaded.<br />Check the address or your connection.</p><button className="button button-primary" onClick={() => navigate(url)}><RefreshCw size={15} />Try again</button></div>;
    }
    return <div className="external-page external-loading" title={url}><span className="external-spinner" aria-hidden="true" /><h1>{title}</h1><p className="external-url">{loadingUrl(url)}</p><p>Loading {hostname}…</p><div className="external-note"><ShieldCheck size={15} />{protection.enabled ? 'Protected browsing — ads, popups and redirects are being filtered.' : 'Protection is paused for this page.'}</div></div>;
  }
  return <div className="external-page"><div className="external-preview-label"><Globe2 size={14} />BROWSER PREVIEW</div><SiteIcon domain={hostname} size={68} /><h1>{title}</h1><p className="external-url">{url}</p><p>This website is ready to explore.<br />In the web preview, external sites open in a new window.</p><a className="button button-primary" href={url} target="_blank" rel="noopener noreferrer">Open {hostname}<ExternalLink size={15} /></a><button className="text-link" onClick={() => navigatePage('downloads')}>Browse natively with the desktop app<ArrowRight size={14} /></button><div className="external-note"><ShieldCheck size={15} />{`${protection.enabled ? 'Network-level protection is available' : 'Enable built-in protection'} in ChromiumCore for Windows and macOS.`}</div></div>;
}