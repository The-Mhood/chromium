import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Code2,
  Copy,
  FileArchive,
  Info,
  LoaderCircle,
  MousePointer2,
  PackageCheck,
  ShieldCheck,
  Tv,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Modal, PageHeading } from "../components/ui";
import { useBrowser } from "../store/browser";
import { archiveExists, downloadUrl, isRelease } from "../lib/downloads";
import type { Release } from "../types";

type PlatformId = Release["platform"];

function WindowsIcon() {
  return (
    <svg
      width="37"
      height="37"
      viewBox="0 0 40 40"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="m2 8 15-2v13H2V8Zm18-2.5L38 3v16H20V5.5ZM2 22h15v13L2 33V22Zm18 0h18v16l-18-2.5V22Z" />
    </svg>
  );
}
function AppleIcon() {
  return (
    <svg
      width="37"
      height="41"
      viewBox="0 0 34 40"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        d="M26.6 21.4c0-5 4.1-7.4 4.3-7.5-2.4-3.5-6.1-4-7.4-4.1-3.1-.3-6.2 1.9-7.8 1.9-1.6 0-4.1-1.8-6.7-1.7-3.5 0-6.8 2.1-8.6 5.2-3.7 6.4-.9 15.9 2.6 21.1 1.7 2.5 3.8 5.2 6.5 5.1 2.6-.1 3.6-1.6 6.8-1.6 3.1 0 4 1.6 6.8 1.5 2.8 0 4.6-2.5 6.3-5 2-2.8 2.8-5.6 2.8-5.8-.1 0-5.6-2.1-5.6-9.1ZM21.5 6.5c1.4-1.7 2.4-4 2.1-6.5-2 .1-4.5 1.4-6 3.1-1.3 1.5-2.5 3.9-2.2 6.2 2.3.2 4.7-1.1 6.1-2.8Z"
        transform="translate(1 0) scale(.93)"
      />
    </svg>
  );
}

const PLATFORMS: PlatformId[] = ["win32", "darwin", "android"];

const PLATFORM_COPY: Record<
  PlatformId,
  { name: string; tagline: string; madeFor: string; extension: string; badge: string; iconClass: string }
> = {
  win32: {
    name: "Windows",
    tagline: "A fresh window on your internet.",
    madeFor: "Windows 10 or later",
    extension: ".zip",
    badge: "Unsigned preview",
    iconClass: "windows-icon",
  },
  darwin: {
    name: "macOS",
    tagline: "A calmer corner of your Mac.",
    madeFor: "macOS 12 or later",
    extension: ".zip",
    badge: "Unsigned preview",
    iconClass: "apple-icon",
  },
  android: {
    name: "Android TV",
    tagline: "A big-screen browser you can steer with any remote.",
    madeFor: "Android TV, Google TV, Fire TV (Android 6+)",
    extension: ".apk",
    badge: "Self-signed preview",
    iconClass: "android-icon",
  },
};

const INSTRUCTIONS: Record<
  PlatformId,
  { title: string; description: string; steps: { title: string; body: string }[] }
> = {
  win32: {
    title: "A fresh window is a few clicks away.",
    description:
      "This is an unsigned, portable preview. No account or setup wizard is needed.",
    steps: [
      {
        title: "Extract the ZIP file.",
        body: "Right-click the archive and choose Extract All. Keep all application files together.",
      },
      {
        title: "Open ChromiumCore.exe.",
        body: "Launch the application from the extracted ChromiumCore folder.",
      },
      {
        title: "Review any security warning.",
        body: "The preview is not code-signed. Verify the checksum and only proceed if you trust the source.",
      },
    ],
  },
  darwin: {
    title: "Make a little room on your Mac.",
    description:
      "This is an unsigned, portable preview. No account or setup wizard is needed.",
    steps: [
      {
        title: "Open the ZIP archive.",
        body: "Use Archive Utility to extract ChromiumCore.app.",
      },
      {
        title: "Move the app to Applications.",
        body: "Keep your browser somewhere it feels at home.",
      },
      {
        title: "Review the unsigned app warning.",
        body: "This preview is not notarized. After verifying the download, macOS may offer Open Anyway in System Settings, Privacy & Security.",
      },
    ],
  },
  android: {
    title: "Your TV is a few steps away.",
    description:
      "This is a sideloaded preview signed with a self-generated key, not a Google Play release. Install it only from a source you trust.",
    steps: [
      {
        title: "Allow installs from your file app.",
        body: "On the TV, open Settings, Device Preferences, then Security & restrictions, and allow the app you will install from, such as Downloader. On Fire TV, turn on Apps from Unknown Sources.",
      },
      {
        title: "Install the APK.",
        body: "Copy the file to the TV with a USB drive or a file-transfer app. Or, from a computer on the same network, run adb connect with your TV's IP address, then adb install with the APK file name.",
      },
      {
        title: "Open ChromiumCore and use the pointer.",
        body: "Arrow keys move the pointer and OK clicks. Press Menu for protection and pointer settings, and push the pointer against the top or bottom edge to scroll.",
      },
    ],
  },
};

const REMOTE_KEYS: [string, string][] = [
  ["Arrow keys", "Move the on-screen pointer. Hold a key to move faster."],
  ["OK / Select", "Click wherever the pointer is."],
  ["Screen edge", "Keep pressing against the top or bottom edge to scroll."],
  ["Channel or Page", "Scroll the page up or down."],
  ["Menu or Info", "Open protection, pointer speed, and text size settings."],
  ["Back", "Go back, or leave full-screen video."],
];

export function Downloads() {
  const { notify } = useBrowser();
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);
  const [macArch, setMacArch] = useState("arm64");
  const [checksum, setChecksum] = useState<Release | null>(null);
  const [instructions, setInstructions] = useState<PlatformId | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [sourceAvailable, setSourceAvailable] = useState(false);
  const [availableFiles, setAvailableFiles] = useState<Set<string>>(new Set());
  const [downloadError, setDownloadError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [requesting, setRequesting] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setDownloadError("");
    const load = async () => {
      try {
        const response = await fetch(downloadUrl("manifest.json"), {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Release manifest unavailable");
        const data = await response.json();
        const verifiedReleases: Release[] = Array.isArray(data.releases)
          ? data.releases.filter(isRelease)
          : [];
        const files = [
          ...verifiedReleases.map((release) => release.file),
          ...(data.source === "chromiumcore-source.zip" ? [data.source] : []),
        ];
        const checks = await Promise.all(
          files.map(async (file) => ({
            file,
            exists: await archiveExists(file, controller.signal),
          })),
        );
        if (controller.signal.aborted) return;
        const available = new Set(
          checks.filter((check) => check.exists).map((check) => check.file),
        );
        setReleases(verifiedReleases);
        setAvailableFiles(available);
        setSourceAvailable(available.has("chromiumcore-source.zip"));
        if (!verifiedReleases.length || checks.some((check) => !check.exists)) {
          setDownloadError(
            "Some download files are missing from this server. Only archives that are actually available can be downloaded.",
          );
        }
      } catch {
        if (controller.signal.aborted) return;
        setReleases([]);
        setAvailableFiles(new Set());
        setSourceAvailable(false);
        setDownloadError(
          "Downloads could not be loaded. Please check your connection and try again.",
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [refresh]);
  const download = async (release: Release) => {
    setRequesting(release.file);
    try {
      if (!(await archiveExists(release.file))) {
        setAvailableFiles(
          (current) => new Set([...current].filter((file) => file !== release.file)),
        );
        setDownloadError(
          "This archive is no longer available on the server. Please retry after the download files have been restored.",
        );
        notify("The archive is missing. No download was started.", "error");
        return;
      }
      const anchor = document.createElement("a");
      anchor.href = downloadUrl(release.file);
      anchor.download = release.file;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      notify(`Your ${release.name} download is starting.`);
      setInstructions(release.platform);
    } finally {
      setRequesting(null);
    }
  };
  const guide = instructions ? INSTRUCTIONS[instructions] : null;
  return (
    <>
      <PageHeading
        title="Take a quieter internet with you."
        description="Your browser. Your privacy. Now on your desktop and your TV."
      >
        <span className="release-label">
          <span className="status-dot" />
          Version 1.0.0 <span>Desktop and TV preview</span>
        </span>
      </PageHeading>
      <div className="download-intro">
        <span className="eyebrow">BUILT FOR YOUR EVERYDAY</span>
        <h2>
          Feels familiar.
          <br />
          <span>Leaves the noise behind.</span>
        </h2>
        <p>
          A Chromium-powered browser with ad blocking, tracker prevention, and a
          little more breathing room. No extensions required.
        </p>
      </div>
      {downloadError && (
        <div className="download-warning download-error" role="status">
          <Info size={17} />
          <p>{downloadError}</p>
          <button
            className="text-link"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Retry
            <ArrowRight size={12} />
          </button>
        </div>
      )}
      <div className="download-grid">
        {PLATFORMS.map((platform) => {
          const copy = PLATFORM_COPY[platform];
          const isMac = platform === "darwin";
          const arch = isMac ? macArch : platform === "android" ? "universal" : "x64";
          const release = releases.find(
            (item) => item.platform === platform && item.arch === arch,
          );
          const available = !!release && availableFiles.has(release.file);
          const starting = requesting === release?.file;
          return (
            <section className="download-platform" key={platform}>
              <div className={`os-icon ${copy.iconClass}`}>
                {isMac ? (
                  <AppleIcon />
                ) : platform === "android" ? (
                  <Tv size={37} strokeWidth={1.5} aria-hidden="true" />
                ) : (
                  <WindowsIcon />
                )}
              </div>
              <h2>ChromiumCore for {copy.name}</h2>
              <p>{copy.tagline}</p>
              <div className="download-spec">
                <span>Made for</span>
                <strong>{copy.madeFor}</strong>
              </div>
              <div className="download-spec">
                <label htmlFor={`arch-${platform}`}>Architecture</label>
                {isMac ? (
                  <div className="select-wrap">
                    <select
                      id={`arch-${platform}`}
                      value={macArch}
                      onChange={(event) => setMacArch(event.target.value)}
                    >
                      <option value="arm64">Apple Silicon (M1 or newer)</option>
                      <option value="x64">Intel (64-bit)</option>
                    </select>
                    <ChevronDown size={13} />
                  </div>
                ) : (
                  <strong id={`arch-${platform}`}>
                    {platform === "android"
                      ? "Universal (ARM and x86)"
                      : "Intel / AMD (64-bit)"}
                  </strong>
                )}
              </div>
              <button
                className="button button-primary download-button"
                disabled={loading || !available || starting}
                onClick={() => release && download(release)}
              >
                {loading || starting ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <ArrowDownToLine size={17} />
                )}
                {loading
                  ? "Checking releases..."
                  : starting
                    ? "Starting download..."
                    : available
                      ? `Download for ${copy.name}`
                      : "Native build not available"}
                {available && !starting && <span>{copy.extension}</span>}
              </button>
              <div className="download-metadata">
                <span>
                  {release ? release.size : "Desktop and TV application"}{" "}
                  <i />
                  {copy.badge}
                </span>
                <button
                  disabled={!available}
                  onClick={() => release && setChecksum(release)}
                >
                  SHA-256
                  <ArrowUpRight size={10} />
                </button>
              </div>
              <button
                className="installation-link"
                onClick={() => setInstructions(platform)}
              >
                Installation instructions
                <ArrowRight size={12} />
              </button>
            </section>
          );
        })}
      </div>
      <div className="download-trust">
        <ShieldCheck size={16} />
        <span>Built-in protection.</span>
        <span>No accounts.</span>
        <span>No browsing-data collection.</span>
      </div>
      <div className="download-warning">
        <Info size={17} />
        <p>
          These are unsigned or self-signed preview builds, not production
          releases from an app store. Your operating system may show a security
          warning. Only run builds from a source you trust.
        </p>
      </div>
      <section className="remote-section" aria-labelledby="remote-heading">
        <div className="remote-intro">
          <span className="remote-icon">
            <MousePointer2 size={26} strokeWidth={1.5} />
          </span>
          <div>
            <h3 id="remote-heading">Built for the remote. Pointer included.</h3>
            <p>
              The Android TV app turns your D-pad into an on-screen pointer, so
              every website can be used without a mouse.
            </p>
          </div>
        </div>
        <dl className="remote-keys">
          {REMOTE_KEYS.map(([key, action]) => (
            <div key={key}>
              <dt>
                <kbd>{key}</kbd>
              </dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="source-section">
        <div className="source-symbol">
          <Code2 size={24} />
        </div>
        <div>
          <h3>Curious about what's under the hood?</h3>
          <p>
            Get the complete source, Electron Forge configuration, Android TV
            project, and native build workflow.
          </p>
        </div>
        <a
          className={`button button-white ${!sourceAvailable ? "disabled-link" : ""}`}
          href={sourceAvailable ? downloadUrl("chromiumcore-source.zip") : undefined}
          aria-disabled={!sourceAvailable}
          download="chromiumcore-source.zip"
        >
          <FileArchive size={15} />
          Download source
          <ArrowUpRight size={13} />
        </a>
      </section>
      <section className="release-notes">
        <button
          aria-expanded={notesOpen}
          onClick={() => setNotesOpen(!notesOpen)}
        >
          <span>
            <PackageCheck size={17} />
            What's inside version 1.0.0
          </span>
          <ChevronDown size={17} className={notesOpen ? "rotated" : ""} />
        </button>
        {notesOpen && (
          <div className="release-notes-content">
            <p>
              <Check size={13} />
              Desktop: native multi-tab browsing with isolated Chromium web
              contents.
            </p>
            <p>
              <Check size={13} />
              Desktop: Ghostery-powered network blocking and targeted cosmetic
              filtering.
            </p>
            <p>
              <Check size={13} />
              Android TV: a remote-controlled pointer, desktop-style pages,
              full-screen video, and a TV-friendly home page.
            </p>
            <p>
              <Check size={13} />
              Android TV: domain-level ad and tracker blocking from bundled
              EasyList and EasyPrivacy domains, plus ad-slot hiding and pop-up
              blocking.
            </p>
            <p>
              <Check size={13} />
              Persistent filter lists, bookmarks, allowlist, and appearance
              preferences on desktop.
            </p>
            <p>
              <Check size={13} />
              YouTube, on desktop and Android TV: the ad schedule is removed from
              video data before the player reads it, any ad that still starts is
              skipped, and ad containers are hidden.
            </p>
            <p>
              <Info size={13} />
              The Android TV preview has one tab and matches hosts only, so ads
              served from a site's own domain can still appear (YouTube has its
              own shield). It has been built and unit-tested but not yet run on
              a physical TV.
            </p>
            <p>
              <Info size={13} />
              Ad-free YouTube playback is not guaranteed. Signing, store
              distribution, and auto-update are not included.
            </p>
          </div>
        )}
      </section>
      {checksum && (
        <Modal
          title="A quick integrity check."
          description={`Compare this SHA-256 checksum with your downloaded ${checksum.name} file.`}
          onClose={() => setChecksum(null)}
        >
          <code className="checksum-code">{checksum.sha256}</code>
          <p className="checksum-help">
            Windows: Get-FileHash filename -Algorithm SHA256
            <br />
            macOS: shasum -a 256 filename
            <br />
            Linux or Android TV tools: sha256sum filename
          </p>
          <div className="modal-actions">
            <button
              className="button button-white"
              onClick={() => setChecksum(null)}
            >
              Close
            </button>
            <button
              className="button button-primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(checksum.sha256);
                  notify("Checksum copied to your clipboard.");
                } catch {
                  notify("Select and copy the checksum shown above.", "info");
                }
              }}
            >
              <Copy size={14} />
              Copy checksum
            </button>
          </div>
        </Modal>
      )}
      {instructions && guide && (
        <Modal
          title={guide.title}
          description={guide.description}
          onClose={() => setInstructions(null)}
        >
          <ol className="installation-steps">
            {guide.steps.map((step, index) => (
              <li key={step.title}>
                <span>{index + 1}</span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="modal-actions">
            <button
              className="button button-primary"
              onClick={() => setInstructions(null)}
            >
              Sounds good
              <ArrowRight size={14} />
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
