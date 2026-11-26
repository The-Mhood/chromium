import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, ArrowUpRight, Ban, ChevronDown, CircleCheck, Clock3, Database, EyeOff, Layers3, MoreHorizontal, Shield, ShieldCheck, Sparkles, TrendingUp, Zap } from 'lucide-react';
import { useState } from 'react';
import { useBrowser } from '../store/browser';
import { recentSites } from '../lib/data';
import { PageHeading, PreviewNote, Toggle } from '../components/ui';
import { SiteIcon, YouTubeMark } from '../components/Brand';
import type { Protection } from '../types';

const orangePoints = [2100, 2850, 2050, 3900, 3150, 5400, 4300];
const purplePoints = [700, 1180, 660, 1390, 980, 2140, 1590];
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function smoothPath(values: number[], max: number, width = 620, height = 174) {
  const points = values.map((value, index) => ({ x: index * width / (values.length - 1), y: height - value / max * height }));
  let result = `M ${points[0].x},${points[0].y}`;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const current = points[index];
    const middle = (previous.x + current.x) / 2;
    result += ` C ${middle},${previous.y} ${middle},${current.y} ${current.x},${current.y}`;
  }
  return result;
}

function BlockingChart({ range }: { range: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [visible, setVisible] = useState({ ads: true, trackers: true });
  const nativeStats = useBrowser(state => state.nativeStats);
  const activityCleared = useBrowser(state => state.activityCleared);
  const isNative = !!window.chromiumCore || activityCleared;
  const bucketDuration = range * 86400000 / 7;
  const startTime = Date.now() - range * 86400000;
  const bucketCount = (index: number, type: string) => nativeStats?.events.filter(item => item.type === type && Math.floor((new Date(item.time).getTime() - startTime) / bucketDuration) === index).length || 0;
  const nativeValues = Array.from({ length: 7 }, (_, index) => bucketCount(index, 'Ad'));
  const multiplier = range === 7 ? 1 : range === 30 ? 3.5 : 8.2;
  const values = isNative ? nativeValues : orangePoints.map(value => value * multiplier);
  const trackers = isNative ? Array.from({ length: 7 }, (_, index) => bucketCount(index, 'Tracker')) : purplePoints.map(value => value * multiplier);
  const max = isNative ? Math.max(6, ...values, ...trackers) : 6000 * multiplier;
  const line = smoothPath(values, max);
  const trackerLine = smoothPath(trackers, max);
  const format = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value % 1000 ? 1 : 0)}k` : String(value);
  return <div className="activity-chart">
    <div className="chart-legend"><button className={!visible.ads ? 'muted' : ''} onClick={() => setVisible(value => ({ ...value, ads: !value.ads }))}><span className="legend-dot ads" />Ads blocked</button><button className={!visible.trackers ? 'muted' : ''} onClick={() => setVisible(value => ({ ...value, trackers: !value.trackers }))}><span className="legend-dot trackers" />Trackers blocked</button></div>
    <div className="chart-canvas" onMouseLeave={() => setHover(null)}>
      <svg viewBox="0 0 674 218" preserveAspectRatio="none" role="img" aria-label={`Ads and trackers blocked over the last ${range} days`}>
        <defs><linearGradient id="ads-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f87843" stopOpacity=".20" /><stop offset="100%" stopColor="#f87843" stopOpacity=".015" /></linearGradient><linearGradient id="trackers-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#9381d9" stopOpacity=".12" /><stop offset="100%" stopColor="#9381d9" stopOpacity="0" /></linearGradient></defs>
        {[0, 1, 2, 3].map(index => <g key={index}><text x="2" y={15 + index * 58} className="chart-axis">{format(max - max * index / 3)}</text><line x1="41" x2="661" y1={11 + index * 58} y2={11 + index * 58} stroke="var(--chart-grid)" strokeDasharray={index === 3 ? '0' : '3 4'} /></g>)}
        <g transform="translate(41 11)">{visible.ads && <><motion.path d={`${line} L 620,174 L 0,174 Z`} fill="url(#ads-fill)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1 }} /><motion.path d={line} stroke="#f47b46" strokeWidth="2.7" fill="none" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.3, ease: 'easeInOut' }} /></>}{visible.trackers && <><path d={`${trackerLine} L 620,174 L 0,174 Z`} fill="url(#trackers-fill)" /><motion.path d={trackerLine} stroke="#9c8acb" strokeWidth="2.3" fill="none" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.4, delay: .15 }} /></>}{hover !== null && <g><line x1={hover * 620 / 6} x2={hover * 620 / 6} y1="0" y2="174" stroke="#e3c5b6" strokeDasharray="4 4" /><circle cx={hover * 620 / 6} cy={174 - values[hover] / max * 174} r="5" fill="#f47b46" stroke="white" strokeWidth="3" /></g>}{values.map((_, index) => <rect key={index} x={Math.max(0, index * 620 / 6 - 50)} y="-10" width={index === 0 || index === 6 ? 53 : 103} height="195" fill="transparent" onMouseEnter={() => setHover(index)} />)}</g>
        {weekdays.map((day, index) => <text key={day} x={41 + index * 620 / 6} y="211" textAnchor={index === 0 ? 'start' : index === 6 ? 'end' : 'middle'} className="chart-axis">{isNative ? new Date(startTime + (index + .5) * bucketDuration).toLocaleDateString('en-US', { weekday: 'short' }) : range === 7 ? day : range === 30 ? `${index * 4 + 1} Jun` : `${index * 2 + 1} wk`}</text>)}
      </svg>
      <AnimatePresence>{hover !== null && <motion.div className="chart-tooltip" style={{ left: `${Math.max(14, Math.min(79, 8 + hover * 14))}%` }} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}><strong>{weekdays[hover]}</strong><span><i className="legend-dot ads" />{values[hover].toLocaleString()} ads</span><span><i className="legend-dot trackers" />{trackers[hover].toLocaleString()} trackers</span></motion.div>}</AnimatePresence>
    </div>
  </div>;
}

const protectionRows: { key: keyof Protection; title: string; description: string; icon: typeof Shield }[] = [
  { key: 'network', title: 'Ad blocking', description: 'The web, without the clutter', icon: Ban },
  { key: 'tracking', title: 'Tracker prevention', description: 'Keep your business, yours', icon: EyeOff },
  { key: 'cosmetic', title: 'Cosmetic filtering', description: 'No empty spaces left behind', icon: Sparkles },
  { key: 'popups', title: 'Pop-up protection', description: 'Fewer unwelcome interruptions', icon: Layers3 },
];

export function Overview() {
  const [range, setRange] = useState(7);
  const [dateOpen, setDateOpen] = useState(false);
  const [donutType, setDonutType] = useState<string | null>(null);
  const { navigatePage, protection, setProtection, filters, notify, nativeStats, newTab, activityCleared } = useBrowser();
  const isNative = !!window.chromiumCore || activityCleared;
  const factor = range === 7 ? 1 : range === 30 ? 3.8 : 10.2;
  const total = isNative ? (nativeStats?.ads || 0) + (nativeStats?.trackers || 0) + (nativeStats?.popups || 0) : Math.round(24831 * factor);
  const threats = isNative ? nativeStats?.threats || 0 : Math.round(143 * factor);
  const metrics = [
    { title: 'Ads & trackers blocked', value: total.toLocaleString(), change: '12.8%', icon: ShieldCheck, color: 'peach', detail: 'Less noise, more internet', page: 'activity' as const },
    { title: 'Threats prevented', value: threats.toLocaleString(), change: '8.2%', icon: Shield, color: 'sage', detail: 'Safer with every click', page: 'activity' as const },
    { title: 'Data saved', value: isNative ? `${(total * 0.0515).toFixed(1)}` : (1.28 * factor).toFixed(2), unit: isNative ? 'MB' : 'GB', change: '16.4%', icon: Database, color: 'lavender', detail: 'A lighter way to browse', page: 'activity' as const },
    { title: 'Time given back', value: isNative ? `${Math.round(total * .37 / 60)}m` : range === 7 ? '2h 34m' : range === 30 ? '9h 45m' : '26h 11m', change: '10.6%', icon: Clock3, color: 'blue', detail: 'For the things that matter', page: 'activity' as const },
  ];
  const breakdown = [
    { name: 'Ads', value: isNative ? nativeStats?.ads || 0 : Math.round(15764 * factor), percent: '63.5%', color: '#f47740' },
    { name: 'Trackers', value: isNative ? nativeStats?.trackers || 0 : Math.round(7982 * factor), percent: '32.1%', color: '#a08ccc' },
    { name: 'Pop-ups', value: isNative ? nativeStats?.popups || 0 : Math.round(1085 * factor), percent: '4.4%', color: '#e8c9a7' },
  ];
  const donutSegments = breakdown.map((item, index) => ({ length: Math.max(0, item.value / Math.max(total, 1) * 390 - 4), offset: -breakdown.slice(0, index).reduce((sum, current) => sum + current.value, 0) / Math.max(total, 1) * 390 }));
  const activeFilters = filters.filter(item => item.enabled).length;

  return <>
    <PageHeading title="A cleaner, safer internet." description="Less noise. More peace of mind. Your protection, at a glance.">
      <div className="date-select-wrap"><button className="button button-white date-select" onClick={() => !window.chromiumCore && setDateOpen(!dateOpen)} aria-expanded={dateOpen}><Clock3 size={14} />{window.chromiumCore ? 'All time' : `Last ${range} days`}<ChevronDown size={14} /></button>{dateOpen && <div className="date-menu">{[7, 30, 90].map(days => <button key={days} className={range === days ? 'selected' : ''} onClick={() => { setRange(days); setDateOpen(false); }}>Last {days} days{range === days && <CircleCheck size={14} />}</button>)}</div>}</div>
    </PageHeading>
    <motion.div className="metric-grid" initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: .08 } } }}>{metrics.map(({ title, value, unit, change, icon: Icon, color, detail, page }) => <motion.button key={title} className="metric" onClick={() => navigatePage(page)} variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }} transition={{ duration: .45 }}><div className="metric-label"><span className={`metric-icon ${color}`}><Icon size={17} strokeWidth={1.8} /></span>{title}</div><div className="metric-value">{value}{unit && <span>{unit}</span>}</div><div className="metric-change">{!isNative ? <><TrendingUp size={12} /><strong>{change}</strong><span>vs. last week</span></> : <span>{detail}</span>}</div></motion.button>)}</motion.div>
    <div className="overview-main-grid">
      <section className="panel blocking-panel"><div className="panel-heading"><div><h2>Blocking activity</h2><p>A little protection, around the clock.</p></div><PreviewNote /></div><BlockingChart range={range} /><div className="chart-footer"><span><span className="soft-shield"><ShieldCheck size={13} /></span>{total.toLocaleString()} unwanted requests stopped.</span><button className="text-link" onClick={() => navigatePage('activity')}>View activity<ArrowRight size={13} /></button></div></section>
      <section className="panel protection-panel"><div className="panel-heading"><div><h2>Always in your corner <span className={`status-dot ${!protection.enabled ? 'paused' : ''}`} /></h2><p>Protection that works quietly.</p></div></div><div className={`protection-controls ${!protection.enabled ? 'controls-paused' : ''}`}>{protectionRows.map(({ key, title, description, icon: Icon }) => <div className="protection-row" key={key}><Icon size={17} strokeWidth={1.6} /><div><strong>{title}</strong><span>{description}</span></div><Toggle label={title} checked={protection[key] && protection.enabled} disabled={!protection.enabled} onChange={value => setProtection(key, value)} /></div>)}</div><div className="youtube-control"><span className="youtube-control-icon"><YouTubeMark size={23} /></span><div><strong>YouTube protection</strong><button onClick={() => navigatePage('youtube')}>More watching. Less waiting.</button></div><Toggle label="YouTube protection" checked={protection.youtube && protection.enabled} disabled={!protection.enabled} onChange={value => setProtection('youtube', value)} /></div><button className="protection-footer" onClick={() => navigatePage('settings')}><SettingsIcon />Make it yours<ArrowRight size={13} /></button></section>
    </div>
    <div className="overview-lower-grid">
      <section className="panel recent-panel"><div className="panel-heading"><div><h2>Recently protected</h2><p>Looking out for you, wherever you go.</p></div><button className="text-link" onClick={() => navigatePage('activity')}>See all<ArrowRight size={13} /></button></div><div className="sites-table"><div className="sites-table-head"><span>WEBSITE</span><span>REQUESTS BLOCKED</span></div>{(isNative ? Array.from(new Set(nativeStats?.events.map(item => item.domain) || [])).slice(0, 4).map(domain => ({ domain, label: domain, blocked: nativeStats?.events.filter(item => item.domain === domain).length || 0, percent: 40 })) : recentSites).map(site => <button key={site.domain} className="site-row" onClick={() => newTab(`https://${site.domain}`, site.label)}><SiteIcon domain={site.domain} /><span className="site-domain">{site.domain}<ArrowUpRight size={12} /></span><span className="site-progress"><span style={{ width: `${site.percent}%` }} /></span><strong>{site.blocked.toLocaleString()}</strong></button>)}{isNative && !nativeStats?.events.length && <div className="native-empty"><ShieldCheck size={24} /><p>Your protected websites will appear here as you browse.</p></div>}</div></section>
      <section className="panel breakdown-panel"><div className="panel-heading"><div><h2>What we kept out</h2><p>A breakdown of the unwanted.</p></div><button className="icon-button small" aria-label="About blocked requests" onClick={() => notify('Ads are promotional requests, trackers collect browsing data, and pop-ups open unsolicited windows. Data savings and time saved are estimates.', 'info')}><MoreHorizontal size={18} /></button></div><div className="breakdown-content"><div className="donut-wrap"><svg viewBox="0 0 160 160" className="donut" role="img" aria-label="Blocked requests: 63.5 percent ads, 32.1 percent trackers, 4.4 percent pop-ups"><circle cx="80" cy="80" r="62" fill="none" stroke="var(--surface-alt)" strokeWidth="17" />{breakdown.map((item, index) => <motion.circle key={item.name} cx="80" cy="80" r="62" fill="none" stroke={item.color} strokeWidth={donutType === item.name ? 21 : 17} strokeDasharray={`${donutSegments[index].length} 390`} strokeDashoffset={donutSegments[index].offset} transform="rotate(-90 80 80)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: .8, delay: .2 }} onMouseEnter={() => setDonutType(item.name)} onMouseLeave={() => setDonutType(null)} />)}</svg><div className="donut-center"><strong>{donutType ? breakdown.find(item => item.name === donutType)?.value.toLocaleString() : total >= 1000 ? `${(total / 1000).toFixed(1)}k` : total}</strong><span>{donutType || 'requests blocked'}</span></div></div><div className="breakdown-legend">{breakdown.map(item => <button key={item.name} onMouseEnter={() => setDonutType(item.name)} onMouseLeave={() => setDonutType(null)} onClick={() => navigatePage('activity')}><span className="legend-dot" style={{ background: item.color }} /><span>{item.name}</span><strong>{isNative ? `${total ? (item.value / total * 100).toFixed(1) : 0}%` : item.percent}</strong></button>)}</div></div><div className="breakdown-footer"><Zap size={13} />Lighter pages. A faster-feeling web.</div></section>
    </div>
    <div className="overview-bottom"><button onClick={() => navigatePage('filters')}><span className="status-dot" />{activeFilters} filter lists keeping you protected<ArrowUpRight size={12} /></button><span><LockIcon />Your browsing data stays on this device.</span></div>
  </>;
}

function SettingsIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="var(--surface)" /><circle cx="15" cy="17" r="3" fill="var(--surface)" /></svg>; }
function LockIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>; }