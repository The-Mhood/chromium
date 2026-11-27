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

export interface EngineGroupStatus {
  source: 'baseline' | 'fallback' | 'cache' | 'cache-stale' | 'fetched' | 'empty';
  rules: number;
  updatedAt: string | null;
}

export interface EngineStatus {
  ready: boolean;
  totalRules: number;
  ads: EngineGroupStatus;
  trackers: EngineGroupStatus;
  threats: EngineGroupStatus;
}

export interface FullscreenState {
  media: boolean;
  window: boolean;
}

/** Why a tab's page is not on screen: blocked by protection, or the host
 *  could not be reached. Drives the honest placeholder states. */
export interface TabIssue {
  kind: 'blocked' | 'failed';
  url: string;
  type?: 'Ad' | 'Tracker' | 'Pop-up' | 'Threat';
}

export interface DesktopBridge {
  platform: string;
  // `seq` is the navigation sequence (a monotonic counter bumped on every
  // user navigation). The main process uses it to tell a fresh navigation
  // apart from a re-focus of an already-loaded tab: a fresh nav reloads even
  // when the url string is unchanged (the "Try again" retry), while a plain
  // tab switch (same seq) must not reload the page.
  navigate: (id: string, url: string, seq?: number) => Promise<void>;
  focusTab: (id: string, external: boolean) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  tabAction: (id: string, action: 'back' | 'forward' | 'reload') => Promise<void>;
  setProtection: (settings: Protection) => Promise<void>;
  setAllowlist: (domains: string[]) => Promise<void>;
  setFilters: (filters: FilterList[]) => Promise<void>;
  setPrivacy: (doNotTrack: boolean) => Promise<void>;
  getStats: () => Promise<NativeStats>;
  getEngineStatus: () => Promise<EngineStatus>;
  clearData: () => Promise<void>;
  windowAction: (action: 'minimize' | 'maximize' | 'close' | 'fullscreen') => void;
  onTabUpdate: (callback: (tab: { id: string; title: string; url: string }) => void) => () => void;
  onOpenTab: (callback: (tab: { url: string; title: string }) => void) => () => void;
  onStats: (callback: (stats: NativeStats) => void) => () => void;
  onChromeVisibility: (callback: (visible: boolean) => void) => () => void;
  onFullscreenState: (callback: (state: FullscreenState) => void) => () => void;
  onPopupBlocked: (callback: (info: { url: string; source: string; reason?: string }) => void) => () => void;
  onNavigationBlocked: (callback: (info: { id: string; url: string; type: TabIssue['type'] }) => void) => () => void;
  onLoadFailed: (callback: (info: { id: string; url: string }) => void) => () => void;
  onTabClosed: (callback: (info: { id: string }) => void) => () => void;
  onToast: (callback: (info: { text: string; tone: 'success' | 'info' | 'error' }) => void) => () => void;
  onDialogData: (callback: (data: { url: string; title: string; media: boolean; sourceTabId: string | null }) => void) => () => void;
  dialogAction: (action: 'close' | 'open-link' | 'open-tab' | 'open-window' | 'copy' | 'download', payload?: { url: string; sourceTabId?: string | null }) => Promise<void>;
}

declare global {
  interface Window {
    chromiumCore?: DesktopBridge;
  }
}