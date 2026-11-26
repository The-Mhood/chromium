import { ChevronLeft, ChevronRight, Download, History, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SiteIcon } from '../components/Brand';
import { EmptyState, Modal, PageHeading, PreviewNote } from '../components/ui';
import { exportActivity, relativeTime, sampleActivity } from '../lib/data';
import { useBrowser } from '../store/browser';

export function Activity() {
  const { nativeStats, activityCleared, clearActivity, notify, addAllowed } = useBrowser();
  const [query, setQuery] = useState('');
  const [type, setType] = useState('All requests');
  const [page, setPage] = useState(1);
  const [confirm, setConfirm] = useState(false);
  const items = activityCleared ? nativeStats?.events || [] : window.chromiumCore ? nativeStats?.events || [] : sampleActivity;
  const filtered = useMemo(() => items.filter(item => (type === 'All requests' || item.type === type) && `${item.domain} ${item.request}`.toLowerCase().includes(query.toLowerCase())), [items, type, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / 8));
  const current = Math.min(page, pages);
  return <>
    <PageHeading title="Nothing gets past unnoticed." description="A closer look at the requests ChromiumCore stopped in their tracks."><button className="button button-white" disabled={!filtered.length} onClick={() => { exportActivity(filtered); notify('Activity exported as a CSV file.'); }}><Download size={15} />Export activity</button></PageHeading>
    <div className="activity-summary"><span className="summary-icon"><ShieldCheck size={25} /></span><div><strong>{items.length} requests blocked</strong><p>{window.chromiumCore ? 'Real-time activity from this desktop browsing session.' : 'Sample activity to help you explore your protection workspace.'}</p></div><PreviewNote /></div>
    <section className="panel full-panel"><div className="list-toolbar"><div className="segmented-tabs">{['All requests', 'Ad', 'Tracker', 'Pop-up', 'Threat'].map(value => <button key={value} className={type === value ? 'active' : ''} onClick={() => { setType(value); setPage(1); }}>{value === 'Ad' ? 'Ads' : value === 'Tracker' ? 'Trackers' : value === 'Pop-up' ? 'Pop-ups' : value === 'Threat' ? 'Threats' : value}</button>)}</div><div className="list-toolbar-right"><label className="search-field"><Search size={15} /><input aria-label="Search browsing activity" placeholder="Search activity..." value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} /></label><button className="icon-button" aria-label="Clear browsing activity" onClick={() => setConfirm(true)}><Trash2 size={16} /></button></div></div>
      <div className="table-scroll"><table className="activity-table"><thead><tr><th>WEBSITE / REQUEST</th><th>TYPE</th><th>STATUS</th><th>WHEN</th><th /></tr></thead><tbody>{filtered.slice((current - 1) * 8, current * 8).map(item => <tr key={item.id}><td><div className="request-cell"><SiteIcon domain={item.domain} size={32} /><div><strong>{item.domain}</strong><span>{item.request}</span></div></div></td><td><span className={`type-label type-${item.type.toLowerCase()}`}>{item.type}</span></td><td><span className="blocked-status"><ShieldCheck size={12} />Blocked</span></td><td className="time-cell">{relativeTime(item.time)}</td><td><button className="table-action" onClick={() => { const added = addAllowed(item.domain); notify(added ? `${item.domain} added to your allowlist.` : 'This website is already on your allowlist.', added ? 'success' : 'info'); }}>Allow site</button></td></tr>)}</tbody></table></div>
      {!filtered.length && <EmptyState icon={<History size={28} />} title={query ? 'No matching requests' : 'A fresh start.'} description={query ? 'Try a different website or request type.' : 'Blocked requests will appear here when you browse in the desktop app.'} />}
      <div className="table-footer"><span>{filtered.length ? `${(current - 1) * 8 + 1}-${Math.min(current * 8, filtered.length)} of ${filtered.length} requests` : '0 requests'}</span><div><button className="icon-button" aria-label="Previous page" disabled={current === 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} /></button><span>Page {current} of {pages}</span><button className="icon-button" aria-label="Next page" disabled={current === pages} onClick={() => setPage(value => value + 1)}><ChevronRight size={16} /></button></div></div>
    </section><div className="page-footnote"><ShieldCheck size={13} />Your activity is stored locally. It is never sent to us.</div>
    {confirm && <Modal title="Clear your activity?" description="This removes the protection activity stored on this device. Your filter lists, bookmarks, and allowlist will not be affected." onClose={() => setConfirm(false)}><div className="modal-actions"><button className="button button-white" onClick={() => setConfirm(false)}>Keep activity</button><button className="button button-primary" onClick={async () => { try { await window.chromiumCore?.clearData(); clearActivity(); setConfirm(false); notify('Your browsing activity has been cleared.'); } catch { notify('Could not clear desktop activity. Please try again.', 'error'); } }}>Clear activity</button></div></Modal>}
  </>;
}