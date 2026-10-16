/* Keep the existing select as the filtering source of truth. */
(() => {
 function enhanceSelect(select, searchable = true) {
  if (!select) return;
  const trigger = document.createElement("button");
  trigger.type = "button"; trigger.className = "project-filter-trigger";
  trigger.setAttribute("aria-haspopup", "listbox"); trigger.setAttribute("aria-expanded", "false");
  const label = document.createElement("span");
  trigger.append(label);
  const menu = document.createElement("div");
  menu.id = searchable ? "projectFilterMenu" : "manageSortMenu"; menu.className = "project-filter-menu"; menu.hidden = true;
  const search = document.createElement("input");
  search.hidden = !searchable;
  search.type = "search"; search.className = "project-filter-search";
  search.placeholder = "查找项目"; search.setAttribute("aria-label", "查找项目");
  const list = document.createElement("div");
  list.className = "project-filter-list"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", searchable ? "项目" : "排序依据");
  const empty = document.createElement("div");
  empty.className = "project-filter-empty"; empty.textContent = "没有匹配项目"; empty.hidden = true;
  empty.setAttribute("role", "status");
  menu.append(search, list, empty);
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
    trigger.setAttribute("aria-label", (searchable ? "项目：" : "排序依据：") + label.textContent);
    trigger.disabled = select.disabled;
    list.replaceChildren();
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
      list.append(button); return button;
    });
    filter();
  }
  function filter() {
    const query = search.value.trim().toLocaleLowerCase();
    options.forEach(option => { option.hidden = !option.textContent.toLocaleLowerCase().includes(query); });
    empty.hidden = options.some(option => !option.hidden);
    list.scrollTop = 0;
  }
  search.addEventListener("input", filter);
  function open(direction = 0) {
    search.value = ""; sync();
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(rect.width, window.innerWidth - 24);
    const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
    const upward = below < 200 && above > below;
    menu.style.width = width + "px";
    menu.style.maxHeight = Math.min(280, Math.max(60, upward ? above : below)) + "px";
    menu.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + "px";
    menu.style.top = upward ? "auto" : rect.bottom + 6 + "px";
    menu.style.bottom = upward ? window.innerHeight - rect.top + 6 + "px" : "auto";
    menu.hidden = false; trigger.setAttribute("aria-expanded", "true");
    const enabled = options.filter(option => !option.disabled);
    const selected = enabled.find(option => option.getAttribute("aria-selected") === "true");
    const target = selected || (direction < 0 ? enabled.at(-1) : enabled[0]);
    if (direction) { target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: "nearest" }); }
    else if (searchable) search.focus({ preventScroll: true });
    else target?.focus({ preventScroll: true });
  }
  trigger.addEventListener("click", () => menu.hidden ? open() : close());
  trigger.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation(); open(event.key === "ArrowUp" ? -1 : 1);
    }
  });
  menu.addEventListener("keydown", event => {
    if (event.isComposing) return;
    const enabled = options.filter(option => !option.disabled && !option.hidden), index = enabled.indexOf(document.activeElement);
    let target;
    if (event.key === "ArrowDown") target = enabled[(index + 1) % enabled.length];
    if (event.key === "ArrowUp") target = index < 0 ? enabled.at(-1) : enabled[(index - 1 + enabled.length) % enabled.length];
    if (event.target !== search && event.key === "Home") target = enabled[0];
    if (event.target !== search && event.key === "End") target = enabled.at(-1);
    if (target) { event.preventDefault(); event.stopPropagation(); target.focus(); target.scrollIntoView({ block: "nearest" }); }
    if (event.target === search && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); enabled[0]?.click(); }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    if (event.key === "Tab") close(true);
  });
  document.addEventListener("pointerdown", event => {
    if (!menu.hidden && !menu.contains(event.target) && !trigger.contains(event.target)) close();
  });
  document.addEventListener("keydown", event => {
    if (!menu.hidden && !event.isComposing && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
  }, true);
  window.addEventListener("resize", () => close());
  document.addEventListener("scroll", event => { if (!menu.hidden && !menu.contains(event.target)) close(); }, true);
  select.addEventListener("change", sync);
  select.addEventListener("xbot-select-sync", sync);
  new MutationObserver(() => { close(); sync(); }).observe(select, { childList: true, subtree: true, attributes: true });
  sync();
 }
 enhanceSelect(document.querySelector(".manage-side select"));
 enhanceSelect(document.querySelector("#manageSort"), false);
 const panel = document.querySelector("#screen-manage .manage-main");
 if (panel) {
   let idle;
   panel.addEventListener("scroll", () => {
     panel.classList.add("is-scrolling"); clearTimeout(idle);
     idle = setTimeout(() => panel.classList.remove("is-scrolling"), 800);
   }, { passive: true });
 }
})();
