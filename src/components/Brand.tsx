export function CoreMark({ size = 33, className = '' }: { size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 40 40" fill="none" className={className} aria-hidden="true">
    <rect width="40" height="40" rx="12" fill="currentColor" />
    <path d="M29 13.4a12 12 0 1 0 .2 13.2l-5.4-3.1a5.8 5.8 0 1 1-.1-7l5.3-3.1Z" fill="white" />
    <path d="m22.5 8.2-5.7 9.9M31.7 20H20.2M22.5 31.8l-5.7-9.9" stroke="currentColor" strokeWidth="2.8" />
    <circle cx="20" cy="20" r="4.5" fill="white" />
  </svg>;
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><CoreMark /><span>chromium<span className="brand-core">core</span></span>{!compact && <span className="sr-only">private browser</span>}</div>;
}

export function YouTubeMark({ size = 21 }: { size?: number }) {
  return <svg width={size} height={size * .75} viewBox="0 0 28 21" fill="none" aria-hidden="true"><rect y="1" width="28" height="19" rx="6" fill="#ff153b" /><path d="m11 6 8 4.5-8 4.5V6Z" fill="white" /></svg>;
}

export function SiteIcon({ domain, size = 32 }: { domain: string; size?: number }) {
  const site = domain.replace(/^www\./, '');
  return <span className={`site-icon site-${site.split('.')[0]}`} style={{ width: size, height: size }}>
    {site === 'youtube.com' ? <YouTubeMark size={size * .62} /> : site === 'reddit.com' ? <svg width={size * .7} height={size * .7} viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="m15 10 2-6 5 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" /><circle cx="23" cy="5" r="2" fill="white" /><ellipse cx="14" cy="17" rx="10" ry="7.2" fill="white" /><circle cx="5" cy="13" r="3" fill="white" /><circle cx="23" cy="13" r="3" fill="white" /><circle cx="10" cy="16" r="1.5" fill="#ff5700" /><circle cx="18" cy="16" r="1.5" fill="#ff5700" /><path d="M10 20c2.5 1.8 5.5 1.8 8 0" stroke="#ff5700" strokeWidth="1.2" strokeLinecap="round" /></svg> : site === 'nytimes.com' ? <span className="newspaper-mark">N</span> : site === 'theverge.com' ? <span className="verge-mark">V</span> : site.charAt(0).toUpperCase()}
  </span>;
}