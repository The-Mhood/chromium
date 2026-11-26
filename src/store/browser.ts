import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { initialFilters, pageDetails, safeUrl } from '../lib/data';
import type { Bookmark, BrowserTab, FilterList, FullscreenState, NativeStats, Page, Protection, TabIssue } from '../types';

interface BrowserState {
  tabs: BrowserTab[];
  activeTabId: string;
  protection: Protection;
  filters: FilterList[];
  allowlist: string[];
  bookmarks: Bookmark[];
  theme: 'light' | 'dark' | 'system';
  searchEngine: string;
  doNotTrack: boolean;
  nativeStats: NativeStats | null;
  fullscreenState: FullscreenState;
  tabIssues: Record<string, TabIssue>;
  activityCleared: boolean;
  toast: { text: string; tone: 'success' | 'info' | 'error'; key: number } | null;
  setFullscreenState: (state: FullscreenState) => void;
  navigatePage: (page: Exclude<Page, 'external'>) => void;
  newTab: (url?: string, title?: string) => void;
  closeTab: (id: string) => void;
  focusTab: (id: string) => void;
  navigate: (url: string) => void;
  moveHistory: (direction: number) => void;
  updateTab: (tab: { id: string; title: string; url: string }) => void;
  setProtection: (key: keyof Protection, enabled: boolean) => void;
  toggleFilter: (id: string) => void;
  addFilter: (filter: FilterList) => void;
  updateFilters: (filters: FilterList[]) => void;
  removeFilter: (id: string) => void;
  addAllowed: (domain: string) => boolean;
  removeAllowed: (domain: string) => void;
  addBookmark: (title: string, url: string) => void;
  removeBookmark: (id: string) => void;
  setPreference: (key: 'theme' | 'searchEngine' | 'doNotTrack', value: string | boolean) => void;
  setNativeStats: (stats: NativeStats) => void;
  setTabIssue: (id: string, issue: TabIssue | null) => void;
  removeTab: (id: string) => void;
  clearActivity: () => void;
  notify: (text: string, tone?: 'success' | 'info' | 'error') => void;
  dismissToast: () => void;
}

const tab = (id: string, title: string, url: string): BrowserTab => ({ id, title, url, history: [url], historyIndex: 0 });

export const useBrowser = create<BrowserState>()(persist((set, get) => ({
  tabs: [tab('newtab', 'New Tab', 'core://newtab'), tab('overview', 'Protection overview', 'core://protection'), tab('youtube', 'YouTube', 'https://www.youtube.com')],
  activeTabId: 'overview',
  protection: { enabled: true, network: true, tracking: true, cosmetic: true, popups: true, youtube: true },
  filters: initialFilters,
  allowlist: [],
  bookmarks: [
    { id: 'github', title: 'GitHub', url: 'https://github.com' },
    { id: 'mdn', title: 'MDN Web Docs', url: 'https://developer.mozilla.org' },
    { id: 'figma', title: 'Figma', url: 'https://figma.com' },
  ],
  theme: 'light',
  searchEngine: 'google',
  doNotTrack: true,
  nativeStats: null,
  fullscreenState: { media: false, window: false },
  tabIssues: {},
  activityCleared: false,
  toast: null,
  setFullscreenState: (fullscreenState) => set({ fullscreenState }),
  navigatePage: (page) => {
    const detail = pageDetails[page];
    get().navigate(`core://${detail.path}`);
  },
  newTab: (url = 'core://newtab', title = 'New Tab') => {
    const id = crypto.randomUUID();
    set(state => ({ tabs: [...state.tabs, { ...tab(id, title, url), openerId: state.activeTabId }], activeTabId: id }));
  },
  closeTab: (id) => {
    window.chromiumCore?.closeTab(id);
    set(state => {
      const index = state.tabs.findIndex(item => item.id === id);
      const tabs = state.tabs.filter(item => item.id !== id);
      if (!tabs.length) {
        const replacement = tab(crypto.randomUUID(), 'New Tab', 'core://newtab');
        return { tabs: [replacement], activeTabId: replacement.id };
      }
      const opener = tabs.find(item => item.id === state.tabs[index]?.openerId);
      return { tabs, activeTabId: state.activeTabId === id ? opener?.id || tabs[Math.max(0, index - 1)].id : state.activeTabId };
    });
  },
  focusTab: (id) => set({ activeTabId: id }),
  removeTab: (id) => set(state => {
    // The main process already closed this tab (e.g. it was a repeat popup).
    const index = state.tabs.findIndex(item => item.id === id);
    if (index < 0) return {};
    const tabs = state.tabs.filter(item => item.id !== id);
    const tabIssues = { ...state.tabIssues };
    delete tabIssues[id];
    if (!tabs.length) {
      const replacement = tab(crypto.randomUUID(), 'New Tab', 'core://newtab');
      return { tabs: [replacement], activeTabId: replacement.id, tabIssues };
    }
    return { tabs, tabIssues, activeTabId: state.activeTabId === id ? tabs[Math.max(0, index - 1)].id : state.activeTabId };
  }),
  navigate: (input) => {
    const url = safeUrl(input, get().searchEngine);
    const detail = Object.values(pageDetails).find(item => url === `core://${item.path}`);
    let title = detail?.title || 'New Tab';
    if (!detail && !url.startsWith('core://')) {
      try { title = new URL(url).hostname.replace(/^www\./, ''); } catch { title = 'New Tab'; }
    }
    set(state => {
      // A fresh navigation supersedes any earlier blocked/failed state for
      // the tab the user is navigating from.
      const tabIssues = { ...state.tabIssues };
      delete tabIssues[state.activeTabId];
      return { tabIssues, tabs: state.tabs.map(item => item.id === state.activeTabId ? { ...item, url, title, history: [...item.history.slice(0, item.historyIndex + 1), url], historyIndex: item.historyIndex + 1 } : item) };
    });
  },
  moveHistory: (direction) => {
    set(state => ({ tabs: state.tabs.map(item => {
      if (item.id !== state.activeTabId) return item;
      const index = Math.max(0, Math.min(item.history.length - 1, item.historyIndex + direction));
      const url = item.history[index];
      const detail = Object.values(pageDetails).find(page => `core://${page.path}` === url);
      return { ...item, historyIndex: index, url, title: detail?.title || new URL(url).hostname };
    }) }));
  },
  updateTab: (updated) => set(state => ({ tabs: state.tabs.map(item => item.id === updated.id ? { ...item, ...updated } : item) })),
  setProtection: (key, enabled) => set(state => ({ protection: { ...state.protection, [key]: enabled } })),
  toggleFilter: (id) => set(state => ({ filters: state.filters.map(item => item.id === id ? { ...item, enabled: !item.enabled } : item) })),
  addFilter: (filter) => set(state => ({ filters: [...state.filters, filter] })),
  updateFilters: (filters) => set({ filters }),
  removeFilter: (id) => set(state => ({ filters: state.filters.filter(item => item.id !== id) })),
  addAllowed: (domain) => {
    if (get().allowlist.includes(domain)) return false;
    set(state => ({ allowlist: [...state.allowlist, domain] }));
    return true;
  },
  removeAllowed: (domain) => set(state => ({ allowlist: state.allowlist.filter(item => item !== domain) })),
  addBookmark: (title, url) => set(state => ({ bookmarks: [...state.bookmarks, { id: crypto.randomUUID(), title, url }] })),
  removeBookmark: (id) => set(state => ({ bookmarks: state.bookmarks.filter(item => item.id !== id) })),
  setPreference: (key, value) => set({ [key]: value } as Partial<BrowserState>),
  setNativeStats: (nativeStats) => set({ nativeStats }),
  setTabIssue: (id, issue) => set(state => {
    const tabIssues = { ...state.tabIssues };
    if (issue) tabIssues[id] = issue; else delete tabIssues[id];
    return { tabIssues };
  }),
  clearActivity: () => set({ activityCleared: true, nativeStats: { ads: 0, trackers: 0, popups: 0, threats: 0, events: [] } }),
  notify: (text, tone = 'success') => set({ toast: { text, tone, key: Date.now() } }),
  dismissToast: () => set({ toast: null }),
}), {
  name: 'chromiumcore-workspace-v1',
  partialize: state => ({ protection: state.protection, filters: state.filters, allowlist: state.allowlist, bookmarks: state.bookmarks, theme: state.theme, searchEngine: state.searchEngine, doNotTrack: state.doNotTrack, activityCleared: state.activityCleared }),
}));