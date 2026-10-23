/*!
 * LinkPay Business payment links on your website.
 * Contract: docs/briefs/payment-links.md §5.
 *
 *   <script src="https://<web>/embed.js" async></script>
 *   <button data-linkpay-link="<slug>" data-reference="ORDER-1" data-email="a@b.ng">Pay</button>
 *   <div data-linkpay-inline="<slug>"></div>
 *   LinkPay.open({ link, name, email, phone, amountKobo, clientReference, metadata,
 *                  onOpen, onCheckout, onUpdate, onSuccess, onClose })
 *
 * Payments are bank transfers: the checkout shows an exact amount and account details, and tells this page
 * when the money lands. Anyone can call your callbacks with a checkout, so confirm on your server
 * (GET <api>/api/public/checkouts/<token>) before fulfilling, and fulfil only when `status` is "paid",
 * `mode` is "live" (a link in test mode has simulated payments), `link.slug` is your link, `currency` is "NGN",
 * `priceKobo` is the order total (`paidKobo` is at least that) and `clientReference` is your order id; then
 * mark the order paid so the same checkout can't be used twice.
 */
;(function () {
  "use strict"
  if (window.LinkPay && window.LinkPay.version) return

  var script =
    document.currentScript ||
    (function () {
      var all = document.getElementsByTagName("script")
      for (var i = all.length - 1; i >= 0; i--) if (/\/embed\.js(\?|$)/.test(all[i].src)) return all[i]
      return null
    })()
  if (!script) return
  var BASE = new URL(script.src, location.href).origin
  var Z = 2147483000

  /** frameId -> { iframe, kind, options, el, overlay, checkout, opener } */
  var frames = {}
  var popupId = null
  var seq = 0
  var newId = function () {
    return "lp" + Date.now().toString(36) + (seq++).toString(36)
  }

  // The payer's name, email and phone aren't put in the frame's address (servers, logs and history keep those):
  // they're sent to the frame once it says it's ready (see "ready" below).
  function urlFor(slug, kind, frameId, o) {
    var u = new URL("/pay/" + encodeURIComponent(slug), BASE)
    u.searchParams.set("embed", kind)
    u.searchParams.set("frame", frameId)
    u.searchParams.set("origin", location.origin)
    if (o.amountKobo) u.searchParams.set("amount", String(Math.round(Number(o.amountKobo))))
    if (o.clientReference) u.searchParams.set("reference", String(o.clientReference))
    if (o.metadata && typeof o.metadata === "object") {
      var keys = Object.keys(o.metadata)
      if (keys.length) u.searchParams.set("meta", JSON.stringify(o.metadata))
    }
    return u.toString()
  }

  /** Options from data-* attributes: data-name, -email, -phone, -amount-kobo, -reference, -meta-<key>. */
  function optionsFrom(el) {
    var d = el.dataset
    var metadata = {}
    for (var k in d) {
      if (k.indexOf("meta") === 0 && k.length > 4) metadata[k.charAt(4).toLowerCase() + k.slice(5)] = d[k]
    }
    return {
      link: d.linkpayLink || d.linkpayInline,
      name: d.name,
      email: d.email,
      phone: d.phone,
      amountKobo: d.amountKobo ? Number(d.amountKobo) : undefined,
      clientReference: d.reference,
      metadata: metadata,
    }
  }

  function emit(entry, name, checkout) {
    if (!entry.el) return
    try {
      entry.el.dispatchEvent(new CustomEvent("linkpay:" + name, { bubbles: true, detail: checkout || null }))
    } catch {}
  }

  function call(fn, arg) {
    if (typeof fn !== "function") return
    try {
      fn(arg)
    } catch (e) {
      setTimeout(function () {
        throw e
      })
    }
  }

  /** Sends the payer's details to the frame (each time it's ready), and only to our own page in it. */
  function sendPrefill(entry, frameId) {
    var o = entry.options
    if (!(o.name || o.email || o.phone)) return
    var prefill = {}
    if (o.name) prefill.name = String(o.name)
    if (o.email) prefill.email = String(o.email)
    if (o.phone) prefill.phone = String(o.phone)
    try {
      entry.iframe.contentWindow.postMessage({ source: "linkpay", type: "prefill", frameId: frameId, prefill: prefill }, BASE)
    } catch {}
  }

  function makeFrame(src, title) {
    var f = document.createElement("iframe")
    f.src = src
    f.title = title || "Pay with LinkPay Business"
    f.setAttribute("allow", "clipboard-write")
    f.setAttribute("allowtransparency", "true")
    f.style.cssText = "border:0;background:transparent;color-scheme:normal;display:block;width:100%;"
    return f
  }

  // -------------------------------------------------------------------------------------------------------
  // Popup
  // -------------------------------------------------------------------------------------------------------

  var savedOverflow = ""

  function open(options, el) {
    var o = options || {}
    if (!o.link) throw new Error('LinkPay.open needs { link: "<slug>" }')
    close()
    var id = newId()
    var overlay = document.createElement("div")
    overlay.setAttribute("data-linkpay-overlay", "")
    overlay.style.cssText = "position:fixed;inset:0;z-index:" + Z + ";background:rgba(23,32,46,.6);"
    // A plain spinner until the page draws its own backdrop.
    var spinner = document.createElement("div")
    spinner.setAttribute("aria-hidden", "true")
    spinner.style.cssText =
      "position:absolute;top:50%;left:50%;width:32px;height:32px;margin:-16px 0 0 -16px;border-radius:50%;" +
      "border:3px solid rgba(255,255,255,.35);border-top-color:#fff;animation:linkpay-spin .8s linear infinite;"
    if (!document.getElementById("linkpay-style")) {
      var style = document.createElement("style")
      style.id = "linkpay-style"
      style.textContent = "@keyframes linkpay-spin{to{transform:rotate(360deg)}}"
      document.head.appendChild(style)
    }
    var iframe = makeFrame(urlFor(o.link, "popup", id, o))
    iframe.style.height = "100%"
    iframe.style.position = "absolute"
    iframe.style.inset = "0"
    overlay.appendChild(spinner)
    overlay.appendChild(iframe)
    document.body.appendChild(overlay)
    savedOverflow = document.documentElement.style.overflow
    document.documentElement.style.overflow = "hidden"

    var entry = { iframe: iframe, kind: "popup", options: o, el: el || null, overlay: overlay, spinner: spinner, checkout: null, opener: document.activeElement }
    frames[id] = entry
    popupId = id
    iframe.focus()
    call(o.onOpen)
    emit(entry, "open", null)
    return id
  }

  function close() {
    if (!popupId) return
    var id = popupId
    var entry = frames[id]
    popupId = null
    delete frames[id]
    if (!entry) return
    if (entry.overlay && entry.overlay.parentNode) entry.overlay.parentNode.removeChild(entry.overlay)
    document.documentElement.style.overflow = savedOverflow
    if (entry.opener && typeof entry.opener.focus === "function") entry.opener.focus()
    call(entry.options.onClose, entry.checkout)
    emit(entry, "close", entry.checkout)
  }

  // -------------------------------------------------------------------------------------------------------
  // Inline
  // -------------------------------------------------------------------------------------------------------

  function mount(root) {
    var scope = root || document
    var nodes = scope.querySelectorAll ? scope.querySelectorAll("[data-linkpay-inline]") : []
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      if (el.getAttribute("data-linkpay-mounted")) continue
      el.setAttribute("data-linkpay-mounted", "true")
      var o = optionsFrom(el)
      var id = newId()
      var iframe = makeFrame(urlFor(o.link, "inline", id, o), el.getAttribute("data-title"))
      iframe.style.height = "640px"
      iframe.style.maxWidth = "480px"
      el.appendChild(iframe)
      frames[id] = { iframe: iframe, kind: "inline", options: o, el: el, checkout: null }
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Messages from the checkout page
  // -------------------------------------------------------------------------------------------------------

  window.addEventListener("message", function (e) {
    if (e.origin !== BASE) return
    var d = e.data
    if (!d || d.source !== "linkpay") return
    var entry = frames[d.frameId]
    if (!entry) {
      // A pasted <iframe> without our frame id: only resizing applies.
      if (d.type === "resize" && d.height) {
        var all = document.getElementsByTagName("iframe")
        for (var i = 0; i < all.length; i++) if (all[i].contentWindow === e.source) all[i].style.height = Math.max(200, d.height) + "px"
      }
      return
    }
    if (entry.iframe.contentWindow !== e.source) return
    var o = entry.options
    if (d.checkout) entry.checkout = d.checkout
    switch (d.type) {
      case "ready":
        if (entry.spinner && entry.spinner.parentNode) entry.spinner.parentNode.removeChild(entry.spinner)
        if (entry.overlay) entry.overlay.style.background = "transparent"
        sendPrefill(entry, d.frameId)
        break
      case "resize":
        if (entry.kind === "inline" && d.height) entry.iframe.style.height = Math.max(200, d.height) + "px"
        break
      case "checkout":
        call(o.onCheckout, d.checkout)
        emit(entry, "checkout", d.checkout)
        break
      case "update":
        call(o.onUpdate, d.checkout)
        emit(entry, "update", d.checkout)
        break
      case "paid":
        call(o.onSuccess, d.checkout)
        emit(entry, "success", d.checkout)
        break
      case "close":
        if (entry.kind === "popup") close()
        break
    }
  })

  document.addEventListener("keydown", function (e) {
    if (popupId && (e.key === "Escape" || e.key === "Esc")) close()
  })

  // Pay buttons, including ones added after the page loaded.
  document.addEventListener("click", function (e) {
    var t = e.target
    var el = t && t.closest ? t.closest("[data-linkpay-link]") : null
    if (!el) return
    e.preventDefault()
    open(optionsFrom(el), el)
  })

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { mount() })
  else mount()

  window.LinkPay = { version: "1", open: open, close: close, mount: mount }
})()
