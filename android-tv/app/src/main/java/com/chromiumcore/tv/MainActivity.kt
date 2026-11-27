package com.chromiumcore.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.chromiumcore.tv.core.BlockType
import com.chromiumcore.tv.core.BrowserSettings
import com.chromiumcore.tv.core.Cosmetics
import com.chromiumcore.tv.core.PointerAction
import com.chromiumcore.tv.core.Direction
import com.chromiumcore.tv.core.DomainBlocker
import com.chromiumcore.tv.core.Html
import com.chromiumcore.tv.core.PointerBounds
import com.chromiumcore.tv.core.PointerMath
import com.chromiumcore.tv.core.UrlInput
import com.chromiumcore.tv.core.UserAgents
import com.chromiumcore.tv.core.YoutubeShield
import java.io.ByteArrayInputStream
import java.text.NumberFormat
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * ChromiumCore for Android TV: a WebView browser operated entirely with a remote control.
 *
 * The D-pad drives an on-screen pointer. While the pointer is active, arrow keys move it, OK clicks,
 * pushing it against the top or bottom edge scrolls, and pushing up at the top of a page reaches the
 * address bar. Real taps and mouse input still work if the TV supports them.
 */
class MainActivity : Activity() {

    private class MenuEntry(val label: () -> String, val action: () -> Unit, val closes: Boolean = false)

    private val handler = Handler(Looper.getMainLooper())
    private val density: Float by lazy { resources.displayMetrics.density }

    private lateinit var store: SettingsStore
    private lateinit var webView: WebView
    private lateinit var overlay: PointerOverlayView
    private lateinit var newWindowHost: ViewGroup
    private lateinit var toolbar: View
    private lateinit var urlField: EditText
    private lateinit var counter: TextView
    private lateinit var progress: ProgressBar
    private lateinit var fullscreenContainer: FrameLayout
    private lateinit var defaultUserAgent: String
    private lateinit var assetLoader: WebViewAssetLoader

    private val blocker = DomainBlocker()

    // These are read from WebView's network threads, so they are always replaced, never mutated.
    @Volatile private var settings = BrowserSettings()
    @Volatile private var pageHost: String? = null

    private val sessionAds = AtomicInteger()
    private val sessionTrackers = AtomicInteger()
    private val sessionPopups = AtomicInteger()
    private val counterScheduled = AtomicBoolean(false)
    private var baseTotals = Totals(0, 0, 0)

    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private var previousSystemUiVisibility: Int = 0
    private var cosmeticScript: String? = null
    private var cosmeticHandle: ScriptHandler? = null
    private var shieldTemplate: String? = null
    private var shieldScript: String? = null
    private var shieldHandle: ScriptHandler? = null
    private var menuNeedsReload = false
    private var lastBackPress = 0L
    private var okPressed = false
    private var pointerX = 0f
    private var pointerY = 0f
    private val dimPointer = Runnable { overlay.animate().alpha(0.45f).setDuration(400).start() }

    // ---------------------------------------------------------------- lifecycle

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        store = SettingsStore(this)
        settings = store.load()
        baseTotals = store.totals()
        toolbar = findViewById(R.id.toolbar)
        urlField = findViewById(R.id.url_field)
        counter = findViewById(R.id.counter)
        progress = findViewById(R.id.progress)
        webView = findViewById(R.id.web_view)
        newWindowHost = findViewById(R.id.new_window_host)
        overlay = findViewById(R.id.pointer)
        fullscreenContainer = findViewById(R.id.fullscreen_container)
        defaultUserAgent = WebSettings.getDefaultUserAgent(this)
        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        shieldTemplate = try {
            assets.open("youtube-shield.js").bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            null
        }
        configureWebView()
        wireToolbar()
        loadBlocklistsAsync()
        applySettings()
        updateCounter()

        window.decorView.viewTreeObserver.addOnGlobalFocusChangeListener { _, _ -> updatePointerVisibility() }
        webView.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> clampPointer() }
        overlay.post { centerPointer() }

        if (!handleIntent(intent)) loadHome()
        webView.requestFocus()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        // Hidden with a video in fullscreen: tear the session down. A custom view left
        // attached across a background/resolution change comes back frozen, or it blocks
        // the next fullscreen request — the "fullscreen is inconsistent" report.
        if (customView != null) exitFullscreen()
        webView.onPause()
        flushTotals()
        super.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    private fun handleIntent(intent: Intent?): Boolean {
        val data = intent?.data ?: return false
        val scheme = data.scheme?.lowercase()
        if (intent.action == Intent.ACTION_VIEW && (scheme == "http" || scheme == "https")) {
            webView.loadUrl(data.toString())
            return true
        }
        return false
    }

    // ---------------------------------------------------------------- WebView

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val ws = webView.settings
        ws.javaScriptEnabled = true
        ws.domStorageEnabled = true
        ws.allowFileAccess = false
        ws.allowContentAccess = false
        ws.setGeolocationEnabled(false)
        ws.setSupportMultipleWindows(true)
        ws.javaScriptCanOpenWindowsAutomatically = true
        ws.mediaPlaybackRequiresUserGesture = true
        ws.useWideViewPort = true
        ws.loadWithOverviewMode = true
        ws.setSupportZoom(false)
        ws.builtInZoomControls = false
        ws.displayZoomControls = false
        ws.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ws.safeBrowsingEnabled = true
        CookieManager.getInstance().setAcceptCookie(true)
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.setDownloadListener { _, _, _, _, _ -> toast("Downloads are not supported on this TV browser yet.") }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                assetLoader.shouldInterceptRequest(request.url)?.let { return it }
                return blockIfNeeded(request)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // Filter top-level ad redirects as well as subresources. Click-triggered ad landers
                // are main-frame requests and must not bypass the domain blocker.
                val current = settings
                val host = request.url.host
                if (request.isForMainFrame && current.protection && current.ads && !current.isAllowlisted(pageHost) &&
                    blocker.classify(host, pageHost) == BlockType.AD) {
                    sessionAds.incrementAndGet()
                    scheduleCounterUpdate()
                    return true
                }
                // Only web pages may load. intent:, file:, javascript: and custom schemes are refused.
                val scheme = request.url.scheme?.lowercase()
                return !(scheme == "http" || scheme == "https" || scheme == "about")
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                pageHost = url?.let { Uri.parse(it).host }
                showUrl(url)
                injectFallbackCosmetics()
            }

            override fun onPageFinished(view: WebView, url: String?) {
                progress.visibility = View.INVISIBLE
                showUrl(url)
                injectFallbackCosmetics()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showError(request.url.toString(), error.description?.toString() ?: "The connection failed.")
            }

            override fun onReceivedSslError(view: WebView, sslHandler: SslErrorHandler, error: SslError) {
                sslHandler.cancel()
                showError(error.url ?: "", "This site's security certificate could not be verified, so it was not opened.")
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                handler.post { recreate() }
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress in 1..99) View.VISIBLE else View.INVISIBLE
            }

            override fun onShowCustomView(view: View, callback: CustomViewCallback) = enterFullscreen(view, callback)

            override fun onHideCustomView() = exitFullscreen()

            // Camera, microphone and location are never granted to web pages in this preview.
            override fun onPermissionRequest(request: PermissionRequest) = request.deny()

            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
                callback.invoke(origin, false, false)

            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                val current = settings
                if (current.protection && current.popups && !current.isAllowlisted(pageHost) && !isUserGesture) {
                    sessionPopups.incrementAndGet()
                    scheduleCounterUpdate()
                    return false
                }
                val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
                // The new window is a real, hidden but ATTACHED WebView. An unattached carrier
                // is never laid out on many devices, its first navigation never starts, and the
                // user's "open in new tab" click died silently — the reported "new pages don't
                // open". A 1dp attached host is enough for the load to begin so it can be
                // intercepted and handed to the visible tab.
                val carrier = WebView(this@MainActivity)
                var handedOff = false
                val handoff: (String) -> Unit = { rawUrl ->
                    if (!handedOff) {
                        handedOff = true
                        // User-initiated links open in this tab, but known advertising
                        // destinations are rejected even when the popup was triggered by a click.
                        val latest = settings
                        val host = runCatching { Uri.parse(rawUrl).host }.getOrNull()
                        val blockedAd = latest.protection && latest.popups && !latest.isAllowlisted(pageHost) &&
                            host != null && blocker.classify(host, pageHost) == BlockType.AD
                        if (blockedAd) {
                            sessionPopups.incrementAndGet()
                            scheduleCounterUpdate()
                        } else {
                            val scheme = rawUrl.substringBefore("://").lowercase()
                            if (scheme == "http" || scheme == "https") webView.loadUrl(rawUrl)
                        }
                        handler.post {
                            newWindowHost.removeView(carrier)
                            runCatching { carrier.destroy() }
                        }
                    }
                }
                carrier.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        handoff(request.url.toString())
                        return true
                    }

                    // Fallback for WebView builds where the initial load of a transported window
                    // does not offer an override: onPageStarted still sees the destination.
                    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                        if (url != null) handoff(url)
                    }
                }
                newWindowHost.addView(carrier)
                // Safety net: a window that never navigates (blocked or dead URL) still goes away.
                handler.postDelayed({
                    if (!handedOff) runCatching {
                        newWindowHost.removeView(carrier)
                        carrier.destroy()
                    }
                }, 15000)
                transport.webView = carrier
                resultMsg.sendToTarget()
                return true
            }
        }
    }

    private fun blockIfNeeded(request: WebResourceRequest): WebResourceResponse? {
        val current = settings
        if (!current.protection || request.isForMainFrame) return null
        val page = pageHost
        if (current.isAllowlisted(page)) return null
        val type = blocker.classify(request.url.host, page) ?: return null
        if (type == BlockType.AD && !current.ads) return null
        if (type == BlockType.TRACKER && !current.trackers) return null
        if (type == BlockType.AD) sessionAds.incrementAndGet() else sessionTrackers.incrementAndGet()
        scheduleCounterUpdate()
        return WebResourceResponse("text/plain", "utf-8", 403, "Blocked by ChromiumCore", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }

    private fun applySettings() {
        store.save(settings)
        val ws = webView.settings
        val agent = if (settings.desktopSite) UserAgents.desktop(defaultUserAgent) else defaultUserAgent
        if (ws.userAgentString != agent) {
            ws.userAgentString = agent
            menuNeedsReload = true
        }
        ws.textZoom = settings.textZoom
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, !(settings.protection && settings.trackers))
        installCosmetics()
        overlay.sizeScale = 1.7f
        updatePointerVisibility()
    }

    private fun installCosmetics() {
        cosmeticScript = Cosmetics.script(settings)
        shieldScript = YoutubeShield.script(shieldTemplate, settings)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            cosmeticHandle?.remove()
            cosmeticHandle = null
            shieldHandle?.remove()
            shieldHandle = null
            cosmeticScript?.let { cosmeticHandle = WebViewCompat.addDocumentStartJavaScript(webView, it, setOf("*")) }
            // Runs in every frame before page scripts, so YouTube's player never sees its own ad data.
            shieldScript?.let { shieldHandle = WebViewCompat.addDocumentStartJavaScript(webView, it, setOf("*")) }
        }
    }

    /** Older WebView builds cannot run scripts at document start, so hide elements once the page is up. */
    private fun injectFallbackCosmetics() {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        cosmeticScript?.let { webView.evaluateJavascript(it, null) }
        shieldScript?.let { webView.evaluateJavascript(it, null) }
    }

    private fun loadBlocklistsAsync() {
        Thread({
            try {
                val ads = assets.open("blocklists/ads.txt").bufferedReader().use { it.readLines() }
                val trackers = assets.open("blocklists/trackers.txt").bufferedReader().use { it.readLines() }
                blocker.load(ads, trackers)
            } catch (e: Exception) {
                // The built-in baseline rules remain active.
            }
        }, "blocklist-loader").start()
    }

    // ---------------------------------------------------------------- navigation and toolbar

    private fun wireToolbar() {
        findViewById<View>(R.id.btn_back).setOnClickListener { if (webView.canGoBack()) webView.goBack() }
        findViewById<View>(R.id.btn_forward).setOnClickListener { if (webView.canGoForward()) webView.goForward() }
        findViewById<View>(R.id.btn_reload).setOnClickListener { if (webView.progress < 100) webView.stopLoading() else webView.reload() }
        findViewById<View>(R.id.btn_home).setOnClickListener { loadHome() }
        findViewById<View>(R.id.shield_chip).setOnClickListener { showMenu() }
        findViewById<View>(R.id.btn_menu).setOnClickListener { showMenu() }
        urlField.setOnClickListener { showKeyboard(urlField) }
        urlField.setOnEditorActionListener { view, actionId, event ->
            val enter = event != null && event.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
            if (actionId == EditorInfo.IME_ACTION_GO || enter) {
                UrlInput.resolve(view.text.toString(), settings.engine)?.let { webView.loadUrl(it) }
                hideKeyboard()
                webView.requestFocus()
                true
            } else {
                false
            }
        }
        // Pressing Down on the toolbar returns to the page and the pointer.
        listOf(R.id.btn_back, R.id.btn_forward, R.id.btn_reload, R.id.btn_home, R.id.url_field, R.id.shield_chip, R.id.btn_menu)
            .forEach { findViewById<View>(it).nextFocusDownId = R.id.web_view }
    }

    private fun loadHome() {
        webView.loadUrl("$HOME_URL?engine=${settings.engine.id}")
    }

    private fun showUrl(url: String?) {
        val shown = if (url == null || url.startsWith(HOME_URL) || url == "about:blank") "" else url
        if (!urlField.hasFocus()) urlField.setText(shown)
    }

    private fun showError(failingUrl: String, description: String) {
        val page = "<html><head><meta name='viewport' content='width=device-width'></head>" +
            "<body style='background:#14161a;color:#e8eaed;font-family:sans-serif;padding:72px;line-height:1.6'>" +
            "<h1 style='font-weight:600'>This page can't be reached</h1><p style='color:#aab0ba'>${Html.escape(description)}</p>" +
            "<p style='color:#8d94a0;word-break:break-all'>${Html.escape(failingUrl)}</p>" +
            "<p style='color:#8d94a0'>Check the connection, then choose Reload in the toolbar.</p></body></html>"
        webView.loadDataWithBaseURL(null, page, "text/html", "utf-8", failingUrl)
    }

    private fun focusToolbar() {
        findViewById<View>(R.id.btn_back).requestFocus()
    }

    private fun focusAddressBar() {
        urlField.requestFocus()
        urlField.selectAll()
        showKeyboard(urlField)
    }

    private fun showKeyboard(view: View) {
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(view, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun hideKeyboard() {
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(urlField.windowToken, 0)
    }

    @Deprecated("Back handling stays on the framework callback so it works on every Android TV release.")
    override fun onBackPressed() {
        when {
            customView != null -> exitFullscreen()
            webView.canGoBack() -> webView.goBack()
            SystemClock.uptimeMillis() - lastBackPress < 2000 -> @Suppress("DEPRECATION") super.onBackPressed()
            else -> {
                lastBackPress = SystemClock.uptimeMillis()
                toast("Press Back again to exit")
            }
        }
    }

    // ---------------------------------------------------------------- fullscreen video

    private fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
        // A page can request fullscreen again while our session is still up (it toggled it,
        // or the previous hide never reported). REPLACE the old session: the previous code
        // dropped the new request and kept showing the old — possibly already-detached —
        // video element, which is the "fullscreen works sometimes, doesn't work sometimes"
        // report.
        teardownFullscreenView()
        customView = view
        customCallback = callback
        previousSystemUiVisibility = window.decorView.systemUiVisibility
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            )
        fullscreenContainer.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        fullscreenContainer.visibility = View.VISIBLE
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        clampPointer()
        updatePointerVisibility()
    }

    /** Removes the video view from the fullscreen container and releases the page's callback.
     *  No-op when there is no active session. */
    private fun teardownFullscreenView() {
        val view = customView ?: return
        val callback = customCallback
        customView = null
        customCallback = null
        fullscreenContainer.removeView(view)
        callback?.onCustomViewHidden()
    }

    private fun exitFullscreen() {
        if (customView == null) return
        teardownFullscreenView()
        fullscreenContainer.visibility = View.GONE
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.systemUiVisibility = previousSystemUiVisibility
        clampPointer()
        webView.requestFocus()
        updatePointerVisibility()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && customView != null) {
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                )
        }
    }

    // ---------------------------------------------------------------- remote control and pointer

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val down = event.action == KeyEvent.ACTION_DOWN
        when (event.keyCode) {
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_INFO, KeyEvent.KEYCODE_BOOKMARK -> {
                if (down && event.repeatCount == 0) showMenu()
                return true
            }
            KeyEvent.KEYCODE_SEARCH -> {
                if (down && event.repeatCount == 0) focusAddressBar()
                return true
            }
            KeyEvent.KEYCODE_BACK -> {
                // In sticky-immersive fullscreen the FRAMEWORK swallows the first Back press to
                // reveal the system bars, so leaving video fullscreen took two presses (or the
                // press seemed dead) — the "fullscreen is inconsistent" report. Intercepting
                // here, before the framework's immersive handling, makes every Back press exit.
                if (down && event.repeatCount == 0 && customView != null) {
                    exitFullscreen()
                    return true
                }
            }
        }
        if (pointerActive(event) && handlePointerKey(event)) return true
        return super.dispatchKeyEvent(event)
    }

    private fun pointerActive(event: KeyEvent): Boolean {
        if (!settings.pointer || toolbar.hasFocus()) return false
        // A full keyboard typing into a page field must reach the page, not move the pointer.
        val fromKeyboard = event.device?.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        return !(fromKeyboard && imm.isAcceptingText)
    }

    private fun handlePointerKey(event: KeyEvent): Boolean {
        val down = event.action == KeyEvent.ACTION_DOWN
        val direction = when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_UP -> Direction.UP
            KeyEvent.KEYCODE_DPAD_DOWN -> Direction.DOWN
            KeyEvent.KEYCODE_DPAD_LEFT -> Direction.LEFT
            KeyEvent.KEYCODE_DPAD_RIGHT -> Direction.RIGHT
            else -> null
        }
        if (direction != null) {
            if (down) movePointer(direction, event.repeatCount)
            return true
        }
        when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_BUTTON_A -> {
                if (down) {
                    okPressed = true
                } else if (okPressed) {
                    okPressed = false
                    clickPointer()
                }
                return true
            }
            KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_CHANNEL_UP -> {
                if (down) scrollLines(-3)
                return true
            }
            KeyEvent.KEYCODE_PAGE_DOWN, KeyEvent.KEYCODE_CHANNEL_DOWN -> {
                if (down) scrollLines(3)
                return true
            }
        }
        return false
    }

    private fun movePointer(direction: Direction, repeat: Int) {
        // SCROLL ZONE: the page scrolls while the pointer is inside the top or bottom quarter
        // of the page (see PointerMath.scrollDecision) — it no longer has to travel to the very
        // edge first (half a screen away on a TV, which is what made YouTube feel unscrollable,
        // and what the old 48dp band still failed to fix). The pointer stays put while the page
        // moves, so keeping the key held scrolls steadily at one line per repeat.
        val bounds = pointerBounds()
        val zone = PointerMath.scrollZonePx(bounds.bottom - bounds.top, density)
        when (PointerMath.scrollDecision(pointerX, pointerY, direction, bounds, zone,
            webView.canScrollVertically(-1), webView.canScrollVertically(1))
        ) {
            PointerAction.SCROLL_DOWN -> {
                scrollLines(PointerMath.EDGE_SCROLL_LINES)
                return
            }
            PointerAction.SCROLL_UP -> {
                scrollLines(-PointerMath.EDGE_SCROLL_LINES)
                return
            }
            PointerAction.FOCUS_TOOLBAR -> {
                if (repeat == 0) focusToolbar() // at the top of the page: the next press up reaches the toolbar
                return
            }
            PointerAction.MOVE_POINTER -> Unit
        }
        val step = PointerMath.step(PointerMath.BASE_STEP_DP * density, repeat, PointerMath.speedFactor(settings.pointerSpeed))
        val move = PointerMath.move(pointerX, pointerY, direction, step, bounds)
        pointerX = move.x
        pointerY = move.y
        overlay.moveTo(pointerX, pointerY)
        wakePointer()
        dispatchHover()
    }

    /** Sends a mouse-wheel event at the pointer so the scrollable element under it moves, as with a real mouse. */
    private fun scrollLines(lines: Int) {
        val target = inputTarget()
        val (x, y) = toLocal(target, pointerX, pointerY)
        val event = mouseEvent(MotionEvent.ACTION_SCROLL, x, y, -lines.toFloat())
        target.dispatchGenericMotionEvent(event)
        event.recycle()
        wakePointer()
    }

    private fun dispatchHover() {
        val target = inputTarget()
        val (x, y) = toLocal(target, pointerX, pointerY)
        val event = mouseEvent(MotionEvent.ACTION_HOVER_MOVE, x, y, 0f)
        target.dispatchGenericMotionEvent(event)
        event.recycle()
    }

    private fun clickPointer() {
        overlay.pulse()
        wakePointer()
        val target = inputTarget()
        webView.requestFocus()
        val (x, y) = toLocal(target, pointerX, pointerY)
        val downTime = SystemClock.uptimeMillis()
        val down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, 0)
        down.source = InputDevice.SOURCE_TOUCHSCREEN
        target.dispatchTouchEvent(down)
        down.recycle()
        handler.postDelayed({
            val up = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0)
            up.source = InputDevice.SOURCE_TOUCHSCREEN
            target.dispatchTouchEvent(up)
            up.recycle()
        }, 55)
    }

    private fun mouseEvent(action: Int, x: Float, y: Float, scroll: Float): MotionEvent {
        val now = SystemClock.uptimeMillis()
        val properties = arrayOf(MotionEvent.PointerProperties().apply {
            id = 0
            toolType = MotionEvent.TOOL_TYPE_MOUSE
        })
        val coords = arrayOf(MotionEvent.PointerCoords().apply {
            this.x = x
            this.y = y
            if (scroll != 0f) setAxisValue(MotionEvent.AXIS_VSCROLL, scroll)
        })
        return MotionEvent.obtain(now, now, action, 1, properties, coords, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_MOUSE, 0)
    }

    /** Pointer coordinates are in overlay space. Fullscreen video is a separate view above the page. */
    private fun inputTarget(): View = customView ?: webView

    private fun toLocal(target: View, x: Float, y: Float): Pair<Float, Float> {
        val overlayOrigin = IntArray(2)
        val targetOrigin = IntArray(2)
        overlay.getLocationOnScreen(overlayOrigin)
        target.getLocationOnScreen(targetOrigin)
        return Pair(x + overlayOrigin[0] - targetOrigin[0], y + overlayOrigin[1] - targetOrigin[1])
    }

    private fun pointerBounds(): PointerBounds {
        if (customView != null) return PointerBounds(0f, 0f, (overlay.width - 1).toFloat(), (overlay.height - 1).toFloat())
        val overlayOrigin = IntArray(2)
        val webOrigin = IntArray(2)
        overlay.getLocationOnScreen(overlayOrigin)
        webView.getLocationOnScreen(webOrigin)
        val left = (webOrigin[0] - overlayOrigin[0]).toFloat()
        val top = (webOrigin[1] - overlayOrigin[1]).toFloat()
        return PointerBounds(left, top, left + webView.width - 1, top + webView.height - 1)
    }

    private fun centerPointer() {
        val bounds = pointerBounds()
        pointerX = (bounds.left + bounds.right) / 2f
        pointerY = (bounds.top + bounds.bottom) / 2f
        overlay.moveTo(pointerX, pointerY)
        wakePointer()
    }

    private fun clampPointer() {
        val bounds = pointerBounds()
        pointerX = bounds.clampX(pointerX)
        pointerY = bounds.clampY(pointerY)
        overlay.moveTo(pointerX, pointerY)
    }

    private fun wakePointer() {
        overlay.animate().cancel()
        overlay.alpha = 1f
        handler.removeCallbacks(dimPointer)
        handler.postDelayed(dimPointer, 5000)
    }

    private fun updatePointerVisibility() {
        overlay.visibility = if (settings.pointer && !toolbar.hasFocus()) View.VISIBLE else View.INVISIBLE
    }

    // ---------------------------------------------------------------- protection statistics

    private fun scheduleCounterUpdate() {
        if (counterScheduled.compareAndSet(false, true)) {
            handler.postDelayed({
                counterScheduled.set(false)
                updateCounter()
            }, 700)
        }
    }

    private fun updateCounter() {
        val total = baseTotals.all + sessionAds.get() + sessionTrackers.get() + sessionPopups.get()
        counter.text = NumberFormat.getIntegerInstance().format(total)
    }

    private fun flushTotals() {
        val ads = sessionAds.getAndSet(0)
        val trackers = sessionTrackers.getAndSet(0)
        val popups = sessionPopups.getAndSet(0)
        store.addTotals(ads, trackers, popups)
        baseTotals = Totals(baseTotals.ads + ads, baseTotals.trackers + trackers, baseTotals.popups + popups)
    }

    // ---------------------------------------------------------------- menu

    private fun change(reload: Boolean = false, block: (BrowserSettings) -> BrowserSettings) {
        settings = block(settings)
        if (reload) menuNeedsReload = true
        applySettings()
    }

    private fun buildMenu(): List<MenuEntry> {
        fun onOff(value: Boolean) = if (value) "On" else "Off"
        return listOf(
            MenuEntry({ "Protection: ${onOff(settings.protection)}" }, { change(true) { it.copy(protection = !it.protection) } }),
            MenuEntry({ "Ad blocking: ${onOff(settings.ads)}" }, { change(true) { it.copy(ads = !it.ads) } }),
            MenuEntry({ "Tracker blocking: ${onOff(settings.trackers)}" }, { change(true) { it.copy(trackers = !it.trackers) } }),
            MenuEntry({ "Hide ad slots on pages: ${onOff(settings.cosmetic)}" }, { change(true) { it.copy(cosmetic = !it.cosmetic) } }),
            MenuEntry({ "YouTube ad blocking: ${onOff(settings.youtube)}" }, { change(true) { it.copy(youtube = !it.youtube) } }),
            MenuEntry({ "Pop-up blocking: ${onOff(settings.popups)}" }, { change { it.copy(popups = !it.popups) } }),
            MenuEntry({
                if (settings.isAllowlisted(pageHost)) "This site: protection paused. Select to resume"
                else "This site: protected. Select to pause"
            }, { toggleSiteAllowance() }),
            MenuEntry({ "Pointer: ${onOff(settings.pointer)}" }, { change { it.copy(pointer = !it.pointer) } }),
            MenuEntry({ "Pointer speed: ${listOf("Slow", "Normal", "Fast")[settings.pointerSpeed.coerceIn(0, 2)]}" }, {
                change { it.copy(pointerSpeed = (it.pointerSpeed + 1) % 3) }
            }),
            MenuEntry({ "Desktop site: ${onOff(settings.desktopSite)}" }, { change(true) { it.copy(desktopSite = !it.desktopSite) } }),
            MenuEntry({ "Text size: ${settings.textZoom}%" }, { change { it.copy(textZoom = BrowserSettings.nextTextZoom(it.textZoom)) } }),
            MenuEntry({ "Search engine: ${settings.engine.label}" }, { change { it.copy(engine = it.engine.next()) } }),
            MenuEntry({ "Remote controls and pointer help" }, { showHelp() }, closes = true),
            MenuEntry({ "Clear browsing data" }, { confirmClear() }, closes = true),
            MenuEntry({ "Go to the home page" }, { loadHome() }, closes = true),
            MenuEntry({ "Quit ChromiumCore" }, { finish() }, closes = true),
        )
    }

    private fun showMenu() {
        val entries = buildMenu()
        menuNeedsReload = false
        val adapter = object : ArrayAdapter<MenuEntry>(this, android.R.layout.simple_list_item_1, entries) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                val row = super.getView(position, convertView, parent) as TextView
                row.text = entries[position].label()
                row.textSize = 20f
                row.setPadding((28 * density).toInt(), (14 * density).toInt(), (28 * density).toInt(), (14 * density).toInt())
                return row
            }
        }
        val dialog = AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("ChromiumCore")
            .setAdapter(adapter, null)
            .setNegativeButton("Close", null)
            .create()
        dialog.setOnShowListener {
            dialog.listView.setOnItemClickListener { _, _, position, _ ->
                val entry = entries[position]
                entry.action()
                if (entry.closes) dialog.dismiss() else adapter.notifyDataSetChanged()
            }
        }
        dialog.setOnDismissListener {
            if (menuNeedsReload) {
                menuNeedsReload = false
                webView.reload()
            }
            webView.requestFocus()
        }
        dialog.show()
    }

    private fun toggleSiteAllowance() {
        val host = pageHost?.lowercase()?.removePrefix("www.")
        if (host == null || host == ASSET_HOST) {
            toast("Open a website first.")
            return
        }
        change(true) { current ->
            if (current.isAllowlisted(host)) current.copy(allowlist = current.allowlist.filterNot { host == it || host.endsWith(".$it") }.toSet())
            else current.copy(allowlist = current.allowlist + host)
        }
    }

    private fun showHelp() {
        AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Remote controls")
            .setMessage(
                "Arrow keys: move the pointer. Hold to move faster.\n" +
                    "OK / Select: click at the pointer.\n" +
                    "Pointer near the top or bottom edge: keep pressing to scroll the page.\n" +
                    "Channel or Page Up / Down: scroll the page.\n" +
                    "Pointer at the top of a page: press Up again to reach the toolbar.\n" +
                    "Menu or Info: open this menu. Search: edit the address.\n" +
                    "Back: go back, or leave full-screen video.",
            )
            .setPositiveButton("Got it", null)
            .show()
    }

    private fun confirmClear() {
        AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Clear browsing data?")
            .setMessage("Cookies, cache, history, and protection counts will be removed from this device. Your settings stay as they are.")
            .setPositiveButton("Clear") { _, _ -> clearData() }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun clearData() {
        webView.clearCache(true)
        webView.clearHistory()
        webView.clearFormData()
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        WebStorage.getInstance().deleteAllData()
        store.resetTotals()
        sessionAds.set(0)
        sessionTrackers.set(0)
        sessionPopups.set(0)
        baseTotals = Totals(0, 0, 0)
        updateCounter()
        loadHome()
        toast("Browsing data cleared.")
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    companion object {
        private const val ASSET_HOST = "appassets.androidplatform.net"
        private const val HOME_URL = "https://$ASSET_HOST/assets/home.html"
    }
}
