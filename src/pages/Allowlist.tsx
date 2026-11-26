import { ArrowUpRight, CircleCheck, Globe2, Plus, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { EmptyState, Modal, PageHeading, SavedIndicator } from '../components/ui';
import { useBrowser } from '../store/browser';

export function Allowlist() {
  const { allowlist, addAllowed, removeAllowed, notify, newTab } = useBrowser();
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState(false);
  const [domain, setDomain] = useState('');
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const url = new URL(domain.includes('://') ? domain : `https://${domain}`);
      if (!['https:', 'http:'].includes(url.protocol) || !url.hostname.includes('.') || url.hostname.includes(' ')) throw new Error('Enter a valid website, such as example.com.');
      const host = url.hostname.replace(/^www\./, '').toLowerCase();
      if (!addAllowed(host)) throw new Error('This website is already on your allowlist.');
      setModal(false); setDomain(''); setError(''); notify(`${host} added to your allowlist.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Enter a valid domain.'); }
  };
  const filtered = allowlist.filter(item => item.includes(query.toLowerCase()));
  return <><PageHeading title="Your internet. Your exceptions." description="Support the sites you love, or give a website a little room to work."><button className="button button-primary" onClick={() => setModal(true)}><Plus size={15} />Add website</button></PageHeading><div className="info-banner"><CircleCheck size={20} /><div><strong>You decide who gets a pass.</strong><p>Ad blocking and tracker prevention are paused on allowlisted websites, including their subdomains.</p></div></div><section className="panel full-panel"><div className="list-toolbar"><h2>Allowed websites <span className="count-label">{allowlist.length}</span></h2><label className="search-field"><Search size={15} /><input aria-label="Search allowed websites" placeholder="Find a website..." value={query} onChange={event => setQuery(event.target.value)} /></label></div>{filtered.length ? <div className="allowed-list">{filtered.map(item => <div className="allowed-item" key={item}><span className="neutral-site-icon"><Globe2 size={20} /></span><button className="allowed-domain" onClick={() => newTab(`https://${item}`, item)}>{item}<ArrowUpRight size={13} /></button><span className="allowed-badge"><CircleCheck size={13} />Allowed</span><button className="icon-button delete-button" aria-label={`Remove ${item} from allowlist`} onClick={() => { removeAllowed(item); notify(`Protection is back on for ${item}.`); }}><Trash2 size={16} /></button></div>)}</div> : <EmptyState icon={<ShieldCheck size={32} />} title={query ? 'No matching websites' : 'Every website gets your protection.'} description={query ? 'Try a different domain name.' : 'Your allowlist is empty. Add a website when you want to make an exception.'}>{!query && <button className="button button-white" onClick={() => setModal(true)}><Plus size={14} />Add your first website</button>}</EmptyState>}<div className="simple-panel-footer"><SavedIndicator /><span>Changes apply to new requests.</span></div></section><div className="page-footnote"><ShieldCheck size={13} />Only allow websites you trust. You can remove an exception at any time.</div>{modal && <Modal title="Make an exception." description="Protection will be paused for this website and its subdomains. Your other websites stay protected." onClose={() => setModal(false)}><form className="modal-form" onSubmit={submit}><label>Website domain<input required autoComplete="off" placeholder="example.com" value={domain} onChange={event => setDomain(event.target.value)} /></label>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button type="button" className="button button-white" onClick={() => setModal(false)}>Cancel</button><button className="button button-primary"><Plus size={15} />Allow website</button></div></form></Modal>}</>;
}