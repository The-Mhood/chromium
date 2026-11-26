import { ArrowUpRight, ChevronDown, Globe2, ListFilter, LoaderCircle, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { EmptyState, Modal, PageHeading, SavedIndicator, Toggle } from '../components/ui';
import { useBrowser } from '../store/browser';
import type { FilterList } from '../types';

export function Filters() {
  const { filters, toggleFilter, addFilter, updateFilters, removeFilter, notify } = useBrowser();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All categories');
  const [updating, setUpdating] = useState(false);
  const [modal, setModal] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const enabled = filters.filter(item => item.enabled);
  const filtered = filters.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()) && (category === 'All categories' || item.category === category));

  const update = async () => {
    setUpdating(true);
    let succeeded = 0;
    const next = await Promise.all(filters.map(async filter => {
      if (!filter.enabled) return filter;
      try {
        const response = await fetch(filter.url, { signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error('Could not fetch filter');
        const text = await response.text();
        if (text.trim().startsWith('<')) throw new Error('Not a filter list');
        const rules = text.split('\n').filter(line => line.trim() && !line.startsWith('!') && !line.startsWith('[')).length;
        succeeded++;
        return { ...filter, rules, updated: new Date().toISOString() };
      } catch { return filter; }
    }));
    updateFilters(next);
    setUpdating(false);
    notify(succeeded ? `${succeeded} filter ${succeeded === 1 ? 'list' : 'lists'} refreshed. ${enabled.length - succeeded ? 'Some lists could not be reached.' : 'You are up to date.'}` : 'Filter servers could not be reached. Existing filters are still in place.', succeeded ? 'success' : 'info');
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') throw new Error('Use a secure HTTPS URL.');
      if (filters.some(item => item.url === parsed.href)) throw new Error('This filter list has already been added.');
      const filter: FilterList = { id: crypto.randomUUID(), name: name.trim(), description: 'A custom filter list added by you.', url: parsed.href, rules: 0, enabled: true, custom: true, category: 'Custom' };
      addFilter(filter); setModal(false); setName(''); setUrl(''); setError(''); notify('Custom filter list added. Update lists to fetch its rules.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Enter a valid filter list URL.'); }
  };

  return <><PageHeading title="Good filters. Better browsing." description="Community-powered lists that keep the unwanted parts of the web away."><button className="button button-white" disabled={updating} onClick={update}>{updating ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{updating ? 'Updating...' : 'Update all'}</button><button className="button button-primary" onClick={() => setModal(true)}><Plus size={15} />Add filter list</button></PageHeading>
    <div className="filter-summary"><div><span className="summary-icon"><ListFilter size={23} /></span><div><strong>{enabled.length} active filter lists</strong><p>{enabled.reduce((sum, item) => sum + item.rules, 0).toLocaleString()} rules working together for a quieter internet.</p></div></div><SavedIndicator /></div>
    <section className="panel full-panel"><div className="list-toolbar"><label className="search-field wide-search"><Search size={15} /><input aria-label="Search filter lists" placeholder="Find a filter list..." value={query} onChange={event => setQuery(event.target.value)} /></label><div className="select-wrap"><select aria-label="Filter category" value={category} onChange={event => setCategory(event.target.value)}>{['All categories', ...new Set(filters.map(item => item.category))].map(value => <option key={value}>{value}</option>)}</select><ChevronDown size={13} /></div></div><div className="filter-list">{filtered.map(filter => <div className="filter-item" key={filter.id}><span className={`filter-list-icon ${filter.enabled ? '' : 'disabled'}`}><ShieldCheck size={22} strokeWidth={1.5} /></span><div className="filter-info"><div><h3>{filter.name}</h3><span className="category-label">{filter.category}</span></div><p>{filter.description}</p><span className="filter-meta">{filter.rules.toLocaleString()} rules<span />{filter.updated ? `Updated ${new Date(filter.updated).toLocaleDateString()}` : filter.custom ? 'Not fetched yet' : 'Included filter list'}<a href={filter.url} target="_blank" rel="noreferrer" aria-label={`View ${filter.name} source`}>View source<ArrowUpRight size={11} /></a></span></div>{filter.custom && <button className="icon-button" aria-label={`Remove ${filter.name}`} onClick={() => { removeFilter(filter.id); notify('Custom filter list removed.'); }}><Trash2 size={15} /></button>}<Toggle label={`Enable ${filter.name}`} checked={filter.enabled} onChange={() => { toggleFilter(filter.id); notify(`${filter.name} ${filter.enabled ? 'disabled' : 'enabled'}.`); }} /></div>)}</div>{!filtered.length && <EmptyState icon={<ListFilter size={27} />} title="No filters found" description="Try another search or add your own filter list." />}</section>
    <div className="page-footnote"><Globe2 size={13} />Filter lists are maintained by the open-source community. Custom lists should come from a source you trust.</div>
    {modal && <Modal title="A little extra protection." description="Add a trusted, EasyList-compatible filter list. Your list preferences stay on this device." onClose={() => setModal(false)}><form onSubmit={submit} className="modal-form"><label>List name<input required placeholder="My custom filters" value={name} onChange={event => setName(event.target.value)} maxLength={70} /></label><label>Filter list URL<input required type="url" placeholder="https://example.com/filters.txt" value={url} onChange={event => setUrl(event.target.value)} /></label>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button type="button" className="button button-white" onClick={() => setModal(false)}>Cancel</button><button className="button button-primary"><Plus size={15} />Add filter list</button></div></form></Modal>}
  </>;
}