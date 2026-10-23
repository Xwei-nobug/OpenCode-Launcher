/*
 * WebView2 输入法候选框重锚护栏（仅 Windows / WebView2 生效）。
 *
 * 现象：用鼠标真实拖拽窗口边框缩放后，输入法候选框与预编辑浮到屏幕左上角，
 * 且不自愈——直到发生一次真正的焦点转移（“点别处再点回来”就是它）。
 * 回车上屏的文字位置是对的，只有选词框错位。
 *
 * 成因在 WebView2 宿主层（Edge/Chrome 不复现）：拖拽缩放后浏览器进程侧的
 * TSF 文本库丢了 caret 布局，输入法退回屏幕原点。要让渲染进程把布局喂回去，
 * 必须发生一次“真的”焦点转移。上游记录：
 * https://github.com/MicrosoftEdge/WebView2Feedback/issues/5675
 *
 * 实测结论（微软拼音 + WebView2 154，2026-10）——别“简化”这个 60ms：
 *   blur → 等 60ms → focus        修复
 *   blur → setTimeout(0) → focus  部分编辑器无效（会被渲染进程合并成没转移过）
 *   同一任务内同步 blur + focus    无效
 *   只调 focus / 只挪 DOM 选区     无效
 *
 * 做法：窗口尺寸稳定后（防抖）把当前可编辑元素重锚一次——blur、等 60ms、
 * focus 回来，还原选区与滚动位置。输入法合成中不打断（等 compositionend
 * 再补做）。修复方案参考 lanmark 项目的 ime-anchor 实测（MIT）。
 */
(function () {
  "use strict";
  if (!/Windows/i.test(navigator.userAgent)) return;

  var DEBOUNCE_MS = 120;
  var FOCUS_DELAY_MS = 60;
  var timer = 0;
  var focusTimer = 0;
  var composing = false;
  var pending = false;

  function isEditable(el) {
    if (!el || el === document.body) return false;
    var tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return true;
    var attr = el.getAttribute ? el.getAttribute("contenteditable") : null;
    return el.isContentEditable === true || attr === "" || attr === "true" || attr === "plaintext-only";
  }

  function saveScroll(el) {
    var out = [];
    for (var node = el; node; node = node.parentElement) {
      if (node.scrollTop !== 0 || node.scrollLeft !== 0) {
        out.push({ el: node, top: node.scrollTop, left: node.scrollLeft });
      }
    }
    return out;
  }

  function reanchor() {
    var el = document.activeElement;
    if (!isEditable(el)) return;
    var sel = window.getSelection();
    // clone：原 Range 会随 blur 后的选区变化被改写
    var range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    var scrolls = saveScroll(el);
    el.blur();
    // 必须等一会儿：紧挨着的 blur+focus 会被渲染进程合并，等于没转移焦点
    focusTimer = setTimeout(function () {
      focusTimer = 0;
      if (el.isConnected) {
        try {
          el.focus({ preventScroll: true });
        } catch (e) {
          el.focus();
        }
        if (range) {
          var s = window.getSelection();
          if (s) {
            s.removeAllRanges();
            s.addRange(range);
          }
        }
      }
      for (var i = 0; i < scrolls.length; i++) {
        if (!scrolls[i].el.isConnected) continue;
        scrolls[i].el.scrollTop = scrolls[i].top;
        scrolls[i].el.scrollLeft = scrolls[i].left;
      }
    }, FOCUS_DELAY_MS);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      timer = 0;
      if (composing) {
        pending = true;
        return;
      }
      reanchor();
    }, DEBOUNCE_MS);
  }

  document.addEventListener("compositionstart", function () { composing = true; }, true);
  document.addEventListener("compositionend", function () {
    composing = false;
    if (pending) {
      pending = false;
      schedule();
    }
  }, true);
  window.addEventListener("resize", schedule);

  // 供功能测试确认护栏已装上
  window.__imeAnchorGuard = true;
})();
