/*
 * opencode Web 窗口拖放分流（仅 Windows / WebView2）：
 *   - 文件夹 → 注入 @路径 文本（opencode 是本地 agent，服务端读路径）
 *   - 单文件 → 合成一个带真实内容的 HTML5 drop，交回 opencode 走它自己的
 *              附件上传流程，从而显示图标附件（保持之前的行为）。
 *
 * 背景：wry 原生 handler 会 SetAllowExternalDrop(false) 关掉 WebView2 的
 * 文件 drop，所以必须由 Rust 全权接管；HTML5 DataTransfer 又拿不到绝对路径。
 * 因此 Rust 在 Drop 时把路径分类、读文件内容，经 eval 调用下面的入口。
 *
 * 外部页面没有 __TAURI__，诊断放 window.__dropDiag，由 Rust 回读。
 */
(function () {
  "use strict";
  window.__dropDiag = window.__dropDiag || [];
  function diag(m) { try { window.__dropDiag.push(String(m)); } catch (e) {} }

  function isEditable(el) {
    if (!el) return false;
    var tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT") return true;
    var a = el.getAttribute ? el.getAttribute("contenteditable") : null;
    return el.isContentEditable === true || a === "" || a === "true" || a === "plaintext-only";
  }

  function collectEditables(root, out, depth) {
    if (!root || depth > 5) return;
    var nodes;
    try {
      nodes = root.querySelectorAll(
        'textarea,input[type="text"],[contenteditable="true"],[contenteditable="plaintext-only"]'
      );
    } catch (e) { return; }
    for (var i = 0; i < nodes.length; i++) if (out.indexOf(nodes[i]) < 0) out.push(nodes[i]);
    var all;
    try { all = root.querySelectorAll("*"); } catch (e) { return; }
    for (var j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) collectEditables(all[j].shadowRoot, out, depth + 1);
    }
  }

  function visible(el) {
    try { return el.offsetParent !== null || el.getClientRects().length > 0; }
    catch (e) { return true; }
  }

  function findEditable() {
    var el = document.activeElement;
    for (var e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (isEditable(e)) return e;
    }
    var cands = [];
    collectEditables(document, cands, 0);
    for (var i = 0; i < cands.length; i++) if (visible(cands[i])) return cands[i];
    return cands.length ? cands[0] : null;
  }

  function toRef(p) {
    var s = String(p == null ? "" : p).trim();
    if (!s) return "";
    return /\s/.test(s) ? '@"' + s + '"' : "@" + s;
  }

  /** 文件夹：把 @路径 文本插入输入框，触发 input 事件让框架感知。 */
  function insertPaths(paths) {
    var el = findEditable();
    diag("insertPaths editable=" + (el ? el.tagName : "NONE"));
    if (!el) return false;
    var refs = [];
    for (var i = 0; i < paths.length; i++) {
      var r = toRef(paths[i]);
      if (r && refs.indexOf(r) < 0) refs.push(r);
    }
    if (!refs.length) return false;
    var text = refs.join(" ");
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    var tag = el.tagName, done = false;
    if (tag === "TEXTAREA" || tag === "INPUT") {
      var proto = tag === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, "value");
      var start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
      try {
        var nv = el.value.slice(0, start) + text + el.value.slice(start);
        if (desc && desc.set) desc.set.call(el, nv); else el.value = nv;
        try { el.setSelectionRange(start + text.length, start + text.length); } catch (e) {}
        el.dispatchEvent(new Event("input", { bubbles: true }));
        done = true;
      } catch (e) { diag("path setter failed: " + e); }
    } else {
      try {
        var s = window.getSelection();
        var r = s && s.rangeCount > 0 ? s.getRangeAt(0) : document.createRange();
        if (!s || s.rangeCount === 0) { r.selectNodeContents(el); r.collapse(false); }
        r.deleteContents();
        r.insertNode(document.createTextNode(text));
        r.collapse(false);
        if (s) { s.removeAllRanges(); s.addRange(r); }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        done = true;
      } catch (e) { diag("path ce failed: " + e); }
    }
    diag("insertPaths done=" + done + " text=" + text);
    return done;
  }

  /** 单文件：合成 File + drop 事件，派发到输入框，让 opencode 走原生附件上传。 */
  function dropFiles(files) {
    diag("dropFiles count=" + files.length);
    var target = findEditable();
    if (!target) { diag("dropFiles no target"); return false; }
    var dt;
    try { dt = new DataTransfer(); } catch (e) { diag("no DataTransfer: " + e); return false; }
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      try {
        var bin = atob(f.b64 || "");
        var arr = new Uint8Array(bin.length);
        for (var k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
        var file = new File([arr], f.name, { type: f.mime || "application/octet-stream" });
        dt.items.add(file);
        diag("file added: " + f.name + " type=" + (f.mime || "?") + " bytes=" + bin.length);
      } catch (e) { diag("file add failed: " + (f && f.name) + " " + e); }
    }
    if (!dt.files.length) { diag("no files in DataTransfer"); return false; }
    // opencode 监听 drop 的元素可能是输入框本身或其祖先；在输入框上派发并冒泡。
    try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
    var ev;
    try {
      ev = new DragEvent("drop", {
        bubbles: true, cancelable: true, composed: true,
        dataTransfer: dt, clientX: 0, clientY: 0,
      });
    } catch (e) {
      ev = document.createEvent("DragEvent");
      ev.initDragEvent("drop", true, true, window, 0, 0, 0, 0, false, false, false, false, 0, null, dt);
    }
    Object.defineProperty(ev, "dataTransfer", { value: dt, configurable: true });
    var fired = target.dispatchEvent(ev);
    diag("drop dispatched, defaultPrevented=" + ev.defaultPrevented + " result=" + fired);
    return true;
  }

  /**
   * Rust 入口。payload = { dirs: string[], files: [{name,mime,b64}] }
   */
  window.__opencodeNativeDrop = function (payload) {
    diag("nativeDrop called: dirs=" + (payload.dirs ? payload.dirs.length : 0) +
         " files=" + (payload.files ? payload.files.length : 0));
    if (payload.dirs && payload.dirs.length) insertPaths(payload.dirs);
    if (payload.files && payload.files.length) dropFiles(payload.files);
  };

  window.__folderDropGuard = true;
})();
