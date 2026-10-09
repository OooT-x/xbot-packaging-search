/* Keep the existing select as the filtering source of truth. */
(() => {
  const select = document.querySelector(".manage-side select");
  if (!select) return;
  const trigger = document.createElement("button");
  trigger.type = "button"; trigger.className = "project-filter-trigger";
  trigger.setAttribute("aria-haspopup", "listbox"); trigger.setAttribute("aria-expanded", "false");
  const label = document.createElement("span");
  trigger.append(label);
  const menu = document.createElement("div");
  menu.id = "projectFilterMenu"; menu.className = "project-filter-menu"; menu.hidden = true;
  menu.setAttribute("role", "listbox"); menu.setAttribute("aria-label", "项目");
  trigger.setAttribute("aria-controls", menu.id);
  select.classList.add("project-filter-native"); select.tabIndex = -1; select.setAttribute("aria-hidden", "true");
  select.after(trigger); document.body.append(menu);
  let options = [];
  function close(restoreFocus = false) {
    menu.hidden = true; trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
  }
  function sync() {
    label.textContent = select.selectedOptions[0]?.textContent || "全部项目";
    trigger.setAttribute("aria-label", "项目：" + label.textContent);
    trigger.disabled = select.disabled;
    menu.replaceChildren();
    options = [...select.options].map(option => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "project-filter-option";
      button.textContent = option.textContent; button.title = option.textContent;
      button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(option.selected));
      button.tabIndex = -1; button.disabled = option.disabled;
      button.addEventListener("click", () => {
        select.value = option.value; sync(); close(true);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      menu.append(button); return button;
    });
  }
  function open(direction = 0) {
    sync();
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 24);
    const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
    const upward = below < 200 && above > below;
    menu.style.width = width + "px";
    menu.style.maxHeight = Math.min(320, Math.max(60, upward ? above : below)) + "px";
    menu.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + "px";
    menu.style.top = upward ? "auto" : rect.bottom + 6 + "px";
    menu.style.bottom = upward ? window.innerHeight - rect.top + 6 + "px" : "auto";
    menu.hidden = false; trigger.setAttribute("aria-expanded", "true");
    const enabled = options.filter(option => !option.disabled);
    const selected = enabled.find(option => option.getAttribute("aria-selected") === "true");
    const target = selected || (direction < 0 ? enabled.at(-1) : enabled[0]);
    target?.focus(); target?.scrollIntoView({ block: "nearest" });
  }
  trigger.addEventListener("click", () => menu.hidden ? open() : close());
  trigger.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation(); open(event.key === "ArrowUp" ? -1 : 1);
    }
  });
  menu.addEventListener("keydown", event => {
    const enabled = options.filter(option => !option.disabled), index = enabled.indexOf(document.activeElement);
    let target;
    if (event.key === "ArrowDown") target = enabled[(index + 1) % enabled.length];
    if (event.key === "ArrowUp") target = enabled[(index - 1 + enabled.length) % enabled.length];
    if (event.key === "Home") target = enabled[0];
    if (event.key === "End") target = enabled.at(-1);
    if (target) { event.preventDefault(); event.stopPropagation(); target.focus(); target.scrollIntoView({ block: "nearest" }); }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    if (event.key === "Tab") close(true);
  });
  document.addEventListener("pointerdown", event => {
    if (!menu.hidden && !menu.contains(event.target) && !trigger.contains(event.target)) close();
  });
  document.addEventListener("keydown", event => {
    if (!menu.hidden && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
  }, true);
  window.addEventListener("resize", () => close());
  document.addEventListener("scroll", event => { if (!menu.hidden && !menu.contains(event.target)) close(); }, true);
  select.addEventListener("change", sync);
  new MutationObserver(() => { close(); sync(); }).observe(select, { childList: true, subtree: true, attributes: true });
  sync();
})();
