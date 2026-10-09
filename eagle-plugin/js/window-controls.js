/* Native controls for the merged Eagle navigation/title bar. */
(() => {
  const controls = document.querySelector("#windowControls");
  const bar = document.querySelector(".topbar");
  const nativeWindow = window.eagle?.window;
  if (!controls || !bar || !nativeWindow) return;
  const minimize = controls.querySelector('[data-window-action="minimize"]');
  const maximize = controls.querySelector('[data-window-action="maximize"]');
  const close = controls.querySelector('[data-window-action="close"]');
  const status = controls.querySelector('[role="status"]');
  controls.hidden = false;
  document.body.classList.add("eagle-window");
  let changing = false;

  function report(error) {
    status.textContent = "窗口操作失败：" + (error?.message || String(error));
  }
  async function refreshMaximized() {
    try {
      const maximized = await nativeWindow.isMaximized();
      maximize.dataset.maximized = String(maximized);
      maximize.setAttribute("aria-label", maximized ? "还原窗口" : "最大化窗口");
      maximize.title = maximized ? "还原窗口" : "最大化窗口";
    } catch (error) { report(error); }
  }
  async function toggleMaximized() {
    if (changing) return;
    changing = true;
    maximize.disabled = true;
    status.textContent = "";
    try {
      if (await nativeWindow.isMaximized()) await nativeWindow.unmaximize();
      else await nativeWindow.maximize();
      await refreshMaximized();
    } catch (error) { report(error); }
    finally { changing = false; maximize.disabled = false; }
  }
  minimize.addEventListener("click", async () => {
    try { status.textContent = ""; await nativeWindow.minimize(); }
    catch (error) { report(error); }
  });
  maximize.addEventListener("click", toggleMaximized);
  close.addEventListener("click", () => window.close());
  // Native drag regions handle Windows double-click themselves; this also
  // handles hosts where the double-click is delivered to the web content.
  bar.addEventListener("dblclick", event => {
    if (event.target.closest("button, input, select, a, .top-actions, .nav-buttons, .window-controls")) return;
    event.preventDefault();
    toggleMaximized();
  });
  window.addEventListener("resize", refreshMaximized);
  window.addEventListener("focus", refreshMaximized);
  refreshMaximized();
})();
