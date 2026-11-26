export type Page = 'overview' | 'activity' | 'filters' | 'allowlist' | 'youtube' | 'bookmarks' | 'downloads' | 'settings' | 'newtab' | 'external';

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  history: string[];
  historyIndex: number;
  openerId?: string;
}

export interface Protection {
  enabled: boolean;
  network: boolean;
  tracking: boolean;
  cosmetic: boolean;
  popups: boolean;
  youtube: boolean;
}

export interface FilterList {
  id: string;
  name: string;
  description: string;
  rules: number;
  enabled: boolean;
  url: string;
  category: string;
  updated?: string;
  custom?: boolean;
}

export interface ActivityItem {
  id: string;
  domain: string;
  request: string;
  type: 'Ad' | 'Tracker' | 'Pop-up' | 'Threat';
  time: string;
}

export interface Bookmark {
  id: string;
  title: string;
  url: string;
}

export interface NativeStats {
  ads: number;
  trackers: number;
  popups: number;
  threats: number;
  events: ActivityItem[];
}

export interface Release {
  platform: 'win32' | 'darwin' | 'android';
  arch: 'x64' | 'arm64' | 'universal';
  name: string;
  file: string;
  size: string;
  sha256: string;
}

export interface DesktopBridge {
  platform: string;
  navigate: (id: string, url: string) => Promise<void>;
  focusTab: (id: string, external: boolean) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  tabAction: (id: string, action: 'back' | 'forward' | 'reload') => Promise<void>;
  setProtection: (settings: Protection) => Promise<void>;
  setAllowlist: (domains: string[]) => Promise<void>;
  setFilters: (filters: FilterList[]) => Promise<void>;
  setPrivacy: (doNotTrack: boolean) => Promise<void>;
  getStats: () => Promise<NativeStats>;
  clearData: () => Promise<void>;
  windowAction: (action: 'minimize' | 'maximize' | 'close') => void;
  onTabUpdate: (callback: (tab: { id: string; title: string; url: string }) => void) => () => void;
  onOpenTab: (callback: (tab: { url: string; title: string }) => void) => () => void;
  onStats: (callback: (stats: NativeStats) => void) => () => void;
  onChromeVisibility: (callback: (visible: boolean) => void) => () => void;
  onFullscreenState: (callback: (fullscreen: boolean) => void) => () => void;
}

declare global {
  interface Window {
    chromiumCore?: DesktopBridge;
  }
}