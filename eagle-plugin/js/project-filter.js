/* Keep the existing select as the filtering source of truth. */
(() => {
 let sequence = 0;
 const controls = new Map();
 let activeClose;
 function enhanceSelect(select, searchable = true, name = searchable ? "项目" : "排序依据") {
  if (!select || select.dataset.xbotEnhanced) return;
  select.dataset.xbotEnhanced = "1";
  const trigger = document.createElement("button");
  trigger.type = "button"; trigger.className = "project-filter-trigger";
  trigger.dataset.selectFor = select.id || "";
  trigger.setAttribute("aria-haspopup", "listbox"); trigger.setAttribute("aria-expanded", "false");
  const label = document.createElement("span");
  trigger.append(label);
  const menu = document.createElement("div");
  menu.id = select.id === "manageSyncFilter" ? "manageSyncFilterMenu" : select.id === "manageSort" ? "manageSortMenu" : "xbotSelectMenu" + (++sequence); menu.className = "project-filter-menu"; menu.hidden = true;
  const search = document.createElement("input");
  search.hidden = !searchable;
  search.type = "search"; search.className = "project-filter-search";
  search.placeholder = "查找" + name; search.setAttribute("aria-label", "查找" + name);
  const list = document.createElement("div");
  list.className = "project-filter-list"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", name);
  const empty = document.createElement("div");
  empty.className = "project-filter-empty"; empty.textContent = "没有匹配选项"; empty.hidden = true;
  empty.setAttribute("role", "status");
  menu.append(search, list, empty);
  trigger.setAttribute("aria-controls", menu.id);
  select.classList.add("project-filter-native"); select.tabIndex = -1; select.setAttribute("aria-hidden", "true");
  select.after(trigger); document.body.append(menu);
  let options = [];
  const listeners = new AbortController();
  function close(restoreFocus = false) {
    menu.hidden = true; trigger.setAttribute("aria-expanded", "false");
    if (activeClose === close) activeClose = null;
    if (restoreFocus) trigger.focus();
  }
  function sync() {
    label.textContent = select.selectedOptions[0]?.textContent || "请选择";
    trigger.setAttribute("aria-label", name + "：" + label.textContent);
    trigger.disabled = select.disabled;
    list.replaceChildren();
    options = [...select.options].map(option => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "project-filter-option";
      button.textContent = option.textContent; button.title = option.textContent;
      button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(option.selected));
      button.tabIndex = -1; button.disabled = option.disabled || option.parentElement?.disabled;
      button.hidden = option.hidden;
      button.addEventListener("click", () => {
        select.selectedIndex = [...select.options].indexOf(option); sync(); close(true);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      list.append(button); return button;
    });
    filter();
  }
  function filter() {
    const query = search.value.trim().toLocaleLowerCase();
    options.forEach((option, index) => { option.hidden = select.options[index].hidden || !option.textContent.toLocaleLowerCase().includes(query); });
    empty.hidden = options.some(option => !option.hidden);
    list.scrollTop = 0;
  }
  search.addEventListener("input", filter);
  function open(direction = 0) {
    if (select.disabled) return;
    activeClose?.(); activeClose = close;
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
    const enabled = options.filter(option => !option.disabled && !option.hidden);
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
  }, { signal: listeners.signal });
  document.addEventListener("keydown", event => {
    if (!menu.hidden && !event.isComposing && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
  }, { capture: true, signal: listeners.signal });
  window.addEventListener("resize", () => close(), { signal: listeners.signal });
  document.addEventListener("scroll", event => { if (!menu.hidden && !menu.contains(event.target)) close(); }, { capture: true, signal: listeners.signal });
  select.addEventListener("change", sync);
  select.addEventListener("xbot-select-sync", sync);
  const observer = new MutationObserver(() => { close(); sync(); });
  observer.observe(select, { childList: true, subtree: true, attributes: true, characterData: true });
  controls.set(select, () => { close(); observer.disconnect(); trigger.remove(); menu.remove(); listeners.abort(); });
  sync();
 }
 window.xbotEnhanceSelect = enhanceSelect;
 enhanceSelect(document.querySelector(".manage-side select"));
 enhanceSelect(document.querySelector("#manageSort"), false);
 enhanceSelect(document.querySelector("#manageSyncFilter"), false, "信息同步");
 function enhanceAll() {
  for (const [select, dispose] of controls) {
   if (!select.isConnected) { dispose(); controls.delete(select); }
  }
  document.querySelectorAll("select:not([multiple])").forEach(select => {
   const name = select.getAttribute("aria-label") || (select.id && document.querySelector(`label[for="${select.id}"]`)?.textContent?.trim()) || "选项";
   enhanceSelect(select, select.options.length > 8, name);
  });
  for (const [select] of controls) {
   if (select.closest("[hidden]") && select.nextElementSibling?.getAttribute("aria-expanded") === "true") activeClose?.();
  }
 }
 enhanceAll();
 new MutationObserver(enhanceAll).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
 const panel = document.querySelector("#screen-manage .manage-main");
 if (panel) {
   let idle;
   panel.addEventListener("scroll", () => {
     panel.classList.add("is-scrolling"); clearTimeout(idle);
     idle = setTimeout(() => panel.classList.remove("is-scrolling"), 800);
   }, { passive: true });
 }
})();

/* Naming fields share one interaction in the production and preview workbenches. */
(() => {
 const fields = ["项目", "包装类型", "包装名称", "版本"];
 function mount(container, selector) {
  container.querySelectorAll(selector).forEach(input => {
   if (input.dataset.namingTiles) return;
   input.dataset.namingTiles = "true";
   const suffix = input.value.endsWith(".zip") ? ".zip" : ".png";
   const selected = new Set(fields.filter(field => input.value.includes(`{${field}}`)));
   const order = [...input.value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).filter(field => fields.includes(field));
   fields.forEach(field => { if (!order.includes(field)) order.push(field); });
   const group = document.createElement("div"); group.className = "naming-rule";
   group.setAttribute("role", "group");
   group.setAttribute("aria-label", suffix === ".png" ? "图片命名字段" : "工程命名字段");
   const tiles = document.createElement("div"); tiles.className = "naming-tiles";
   const available = document.createElement("div"); available.className = "naming-tiles naming-available";
   tiles.setAttribute("aria-label", "已选字段"); available.setAttribute("aria-label", "未选字段");
   const summary = document.createElement("div"); summary.className = "naming-rule-summary";
   summary.setAttribute("aria-live", "polite");
   let dragged = null, lastDrag = 0;
   const buttons = new Map();
   const update = (notify = true) => {
    const enabled = order.filter(field => selected.has(field));
    input.value = enabled.length ? enabled.map(field => `{${field}}`).join("_") + suffix : "";
    group.dataset.empty = String(!enabled.length);
    summary.textContent = enabled.length ? enabled.join(" _ ") + suffix : "至少选择一个字段";
    order.forEach(field => {
     const button = buttons.get(field);
     button.setAttribute("aria-pressed", String(selected.has(field)));
     button.setAttribute("aria-label", `${field}，${selected.has(field) ? "已选择" : "未选择"}；Alt 加左右方向键调整顺序`);
     (selected.has(field) ? tiles : available).appendChild(button);
    });
    available.hidden = selected.size === fields.length;
    if (notify) input.dispatchEvent(new Event("input", { bubbles: true }));
   };
   const move = (field, target) => {
    if (!fields.includes(field) || target < 0 || target >= order.length) return;
    order.splice(order.indexOf(field), 1); order.splice(target, 0, field); update();
    buttons.get(field).focus();
   };
   fields.forEach(field => {
    const button = document.createElement("button"); button.type = "button";
    button.className = "naming-tile"; button.draggable = true;
    button.dataset.namingField = field;
    button.innerHTML = `<span class="naming-grip" aria-hidden="true">⠿</span><span>${field}</span><span class="naming-check" aria-hidden="true">✓</span>`;
    button.addEventListener("click", () => {
     if (Date.now() - lastDrag < 200) return;
     if (selected.has(field)) selected.delete(field); else selected.add(field);
     update(); button.focus();
    });
    button.addEventListener("keydown", event => {
     if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
     event.preventDefault(); move(field, order.indexOf(field) + (event.key === "ArrowLeft" ? -1 : 1));
    });
    button.addEventListener("dragstart", event => {
     dragged = field; button.classList.add("dragging");
     event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", field);
    });
    button.addEventListener("dragover", event => {
     if (!dragged) return;
     event.preventDefault(); event.dataTransfer.dropEffect = "move";
     button.classList.add("drop-target");
    });
    button.addEventListener("dragleave", () => button.classList.remove("drop-target"));
    button.addEventListener("drop", event => {
     if (!dragged) return;
     event.preventDefault(); move(dragged, order.indexOf(field));
     dragged = null; lastDrag = Date.now();
     buttons.forEach(item => item.classList.remove("dragging", "drop-target"));
    });
    button.addEventListener("dragend", () => {
     dragged = null; lastDrag = Date.now(); buttons.forEach(item => item.classList.remove("dragging", "drop-target"));
    });
    buttons.set(field, button);
   });
   input.hidden = true; input.insertAdjacentElement("afterend", group);
   group.append(tiles, available, summary); update(false);
  });
 }
 window.XbotNamingRules = { mount };
})();
