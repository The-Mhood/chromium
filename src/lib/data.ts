import type { ActivityItem, FilterList, Page } from '../types';

// Address bar classification lives in shared/ (plain, engine-free) so the
// exact same rules run in the desktop renderer and in the Node test suite.
export { classifyAddress, safeUrl, searchUrl } from '../../shared/address';
export type { Address, AddressKind } from '../../shared/address';

export const pageDetails: Record<Exclude<Page, 'external'>, { title: string; path: string }> = {
  overview: { title: 'Protection overview', path: 'protection' },
  activity: { title: 'Browsing activity', path: 'activity' },
  filters: { title: 'Filter lists', path: 'filters' },
  allowlist: { title: 'Allowlist', path: 'allowlist' },
  youtube: { title: 'YouTube protection', path: 'youtube' },
  bookmarks: { title: 'Bookmarks', path: 'bookmarks' },
  downloads: { title: 'Downloads', path: 'downloads' },
  settings: { title: 'Settings', path: 'settings' },
  newtab: { title: 'New Tab', path: 'newtab' },
};

export function getPage(url: string): Page {
  if (!url.startsWith('core://')) return 'external';
  return (Object.entries(pageDetails).find(([, value]) => `core://${value.path}` === url)?.[0] as Page) || 'newtab';
}

export const initialFilters: FilterList[] = [
  { id: 'easylist', name: 'EasyList', description: 'The essentials. Removes ads from the websites you visit.', rules: 78642, enabled: true, url: 'https://easylist.to/easylist/easylist.txt', category: 'Advertising' },
  { id: 'easyprivacy', name: 'EasyPrivacy', description: 'Stops invisible trackers from following you around the web.', rules: 53418, enabled: true, url: 'https://easylist.to/easylist/easyprivacy.txt', category: 'Privacy' },
  { id: 'annoyances', name: 'EasyList Annoyances', description: 'A calmer web, without newsletter overlays and other distractions.', rules: 21843, enabled: true, url: 'https://easylist.to/easylist/easylist-annoyances.txt', category: 'Annoyances' },
  { id: 'youtube', name: 'YouTube cosmetic filters', description: 'Hides supported in-page ad placements and sponsored containers.', rules: 12, enabled: true, url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-others.txt', category: 'Video' },
  { id: 'malware', name: 'Malware & phishing protection', description: 'An extra layer against known malicious domains.', rules: 16924, enabled: true, url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter.txt', category: 'Security' },
  { id: 'regional', name: 'EasyList Germany', description: 'Additional ad filtering for German-language websites.', rules: 9216, enabled: false, url: 'https://easylist.to/easylistgermany/easylistgermany.txt', category: 'Regional' },
];

const sites = ['youtube.com', 'theverge.com', 'reddit.com', 'nytimes.com', 'wired.com', 'cnn.com', 'medium.com', 'forbes.com'];
const requests = [
  ['doubleclick.net/pagead/ads', 'Ad'],
  ['google-analytics.com/g/collect', 'Tracker'],
  ['adservice.google.com/adsid', 'Ad'],
  ['connect.facebook.net/signals', 'Tracker'],
  ['popads.net/redirect', 'Pop-up'],
  ['pagead2.googlesyndication.com', 'Ad'],
  ['tracking.example.org/pixel', 'Tracker'],
  ['malware.test/download', 'Threat'],
] as const;

export const sampleActivity: ActivityItem[] = Array.from({ length: 32 }, (_, index) => ({
  id: `sample-${index}`,
  domain: sites[index % sites.length],
  request: requests[index % requests.length][0],
  type: requests[index % requests.length][1],
  time: new Date(Date.now() - (index * 173 + 20) * 1000).toISOString(),
}));

export const recentSites = [
  { domain: 'youtube.com', label: 'YouTube', blocked: 1248, color: '#ff0033', mark: 'play', percent: 88 },
  { domain: 'theverge.com', label: 'The Verge', blocked: 864, color: '#242128', mark: 'V', percent: 66 },
  { domain: 'reddit.com', label: 'Reddit', blocked: 632, color: '#ff5700', mark: 'reddit', percent: 48 },
  { domain: 'nytimes.com', label: 'The New York Times', blocked: 419, color: '#18191b', mark: 'N', percent: 32 },
];

export function relativeTime(date: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}



export function downloadText(name: string, content: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportActivity(items: ActivityItem[]) {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  downloadText('chromiumcore-activity.csv', ['Time,Website,Request,Type,Status', ...items.map(item => [item.time, item.domain, item.request, item.type, 'Blocked'].map(escape).join(','))].join('\n'), 'text/csv');
}