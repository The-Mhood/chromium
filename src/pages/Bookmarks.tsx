import { ArrowUpRight, BookOpen, Plus, Search, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { EmptyState, Modal, PageHeading } from '../components/ui';
import { SiteIcon } from '../components/Brand';
import { safeUrl } from '../lib/data';
import { useBrowser } from '../store/browser';

export function Bookmarks() {
  const { bookmarks, addBookmark, removeBookmark, newTab, notify } = useBrowser();
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState(false);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const filtered = bookmarks.filter(item => `${item.title} ${item.url}`.toLowerCase().includes(query.toLowerCase()));
  const submit = (event: FormEvent) => { event.preventDefault(); addBookmark(title.trim(), safeUrl(url)); setModal(false); setTitle(''); setUrl(''); notify('A good find, saved for later.'); };
  return <><PageHeading title="The good corners of your internet." description="Your favorite places, always a little closer."><button className="button button-primary" onClick={() => setModal(true)}><Plus size={15} />Add bookmark</button></PageHeading><section className="panel full-panel"><div className="list-toolbar"><h2>All bookmarks <span className="count-label">{bookmarks.length}</span></h2><label className="search-field"><Search size={15} /><input aria-label="Search bookmarks" placeholder="Find something you saved..." value={query} onChange={event => setQuery(event.target.value)} /></label></div><div className="bookmark-list">{filtered.map(item => <div className="bookmark-row" key={item.id}><SiteIcon domain={item.url.startsWith('core://') ? 'chromiumcore.app' : new URL(item.url).hostname} size={37} /><button onClick={() => newTab(item.url, item.title)}><strong>{item.title}<ArrowUpRight size={13} /></strong><span>{item.url}</span></button><button className="icon-button delete-button" aria-label={`Remove ${item.title} bookmark`} onClick={() => { removeBookmark(item.id); notify('Bookmark removed.'); }}><Trash2 size={16} /></button></div>)}</div>{!filtered.length && <EmptyState icon={<BookOpen size={28} />} title={query ? 'Nothing here by that name.' : 'A little space for your favorites.'} description={query ? 'Try another search.' : 'Save a website with the star in your address bar, or add one here.'} />}</section>{modal && <Modal title="Keep a good thing close." description="Add a favorite website to your bookmarks." onClose={() => setModal(false)}><form className="modal-form" onSubmit={submit}><label>Name<input required placeholder="A favorite corner of the web" value={title} onChange={event => setTitle(event.target.value)} /></label><label>Website URL<input required type="url" placeholder="https://example.com" value={url} onChange={event => setUrl(event.target.value)} /></label><div className="modal-actions"><button type="button" className="button button-white" onClick={() => setModal(false)}>Cancel</button><button className="button button-primary"><Plus size={14} />Save bookmark</button></div></form></Modal>}</>;
}