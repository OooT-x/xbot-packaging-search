from __future__ import annotations

import os
import shutil
import sys
import tempfile
import threading
from pathlib import Path

if getattr(sys, "frozen", False):
    bundle_root = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    os.environ.setdefault("TCL_LIBRARY", str(bundle_root / "_tcl_data"))
    os.environ.setdefault("TK_LIBRARY", str(bundle_root / "_tk_data"))

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from PIL import Image, ImageDraw, ImageTk

from .core import (
    CollectionResult,
    CollectorError,
    CompositionInfo,
    ProjectInfo,
    attach_collection_preview,
    collect_composition,
    direct_precompositions,
    inspect_project,
    mark_collection_preview_error,
    preview_source_candidates,
    preview_source_layer_usage,
    preview_time_for_source,
    recommend_preview_source,
)
from .bridge import BridgeUnavailable, bridge_status, render_bridge_preview
from .preview import PreviewError, default_preview_time, render_preview, select_preview_frame


class PreviewDialog:
    def __init__(
        self,
        parent: tk.Tk,
        aep_path: str,
        collection_composition: CompositionInfo,
        source_candidates: tuple[CompositionInfo, ...],
        initial_source_id: int,
        initial_time: float,
        cache_file: Path,
        on_confirm,
        source_times: dict[int, float] | None = None,
    ) -> None:
        self.parent = parent
        self.aep_path = aep_path
        self.collection_composition = collection_composition
        self.source_candidates = source_candidates
        self.source_labels = {
            self._source_label(item): item for item in self.source_candidates
        }
        self.composition = next(
            (item for item in source_candidates if item.id == initial_source_id),
            collection_composition,
        )
        self.cache_file = cache_file
        self.on_confirm = on_confirm
        self.source_times = source_times or {}
        self.busy = False
        self.photo: ImageTk.PhotoImage | None = None
        self.rendered_frame_index: int | None = None
        self.rendered_source_id: int | None = None
        self.rendered_renderer: str | None = None

        selection = select_preview_frame(
            self.composition.duration,
            self.composition.frame_rate,
            requested_time=initial_time,
            display_start_frame=self.composition.display_start_frame,
        )
        self.window = tk.Toplevel(parent)
        self.window.title(f"预览 / 调整帧 · {collection_composition.name}")
        self.window.geometry("980x760")
        self.window.minsize(760, 620)
        self.window.transient(parent)
        self.window.protocol("WM_DELETE_WINDOW", self.window.destroy)

        self.time_var = tk.StringVar(value=f"{selection.time:.3f}")
        self.frame_var = tk.DoubleVar(value=selection.frame_index)
        self.frame_label_var = tk.StringVar()
        self.title_var = tk.StringVar()
        self.source_var = tk.StringVar(value=self._source_label(self.composition))
        self.status_var = tk.StringVar(
            value=(
                "按视频框图层出现后的第 2 秒取父级画面。"
                if self.composition.id != self.collection_composition.id
                else "默认选择第 2 秒的帧。"
            )
        )

        self._build_ui()
        self._sync_frame_label(selection.frame_index)
        if cache_file.is_file():
            self._show_image(cache_file)
            self.rendered_frame_index = selection.frame_index
            self.rendered_source_id = self.composition.id
            self.confirm_button.configure(state=tk.NORMAL)
            self.status_var.set(f"已生成 {selection.time:.3f} 秒预览，可继续调整。")
        else:
            self.window.after(100, self.render_from_time)

    def _source_label(self, item: CompositionInfo) -> str:
        relation = "自身" if item.id == self.collection_composition.id else "上层"
        return f"{relation} · {item.name}  [ID {item.id}]"

    def _build_ui(self) -> None:
        outer = ttk.Frame(self.window, padding=12)
        outer.pack(fill=tk.BOTH, expand=True)

        title = ttk.Label(
            outer,
            textvariable=self.title_var,
        )
        title.pack(fill=tk.X)
        self._sync_title()

        preview_frame = ttk.Frame(outer, relief=tk.SUNKEN, borderwidth=1)
        preview_frame.pack(fill=tk.BOTH, expand=True, pady=(10, 10))
        self.image_label = ttk.Label(preview_frame, text="正在生成预览…", anchor=tk.CENTER)
        self.image_label.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)

        controls = ttk.LabelFrame(outer, text="预览帧", padding=10)
        controls.pack(fill=tk.X)
        controls.columnconfigure(1, weight=1)

        ttk.Label(controls, text="预览来源").grid(row=0, column=0, sticky="w")
        self.source_combo = ttk.Combobox(
            controls,
            textvariable=self.source_var,
            values=tuple(self.source_labels),
            state="readonly",
        )
        self.source_combo.grid(row=0, column=1, columnspan=4, sticky="ew", padx=(8, 0))
        self.source_combo.bind("<<ComboboxSelected>>", self._source_changed)

        ttk.Label(controls, text="时间（秒）").grid(row=1, column=0, sticky="w", pady=(10, 0))
        self.time_entry = ttk.Entry(controls, textvariable=self.time_var, width=12)
        self.time_entry.grid(row=1, column=1, sticky="w", padx=(8, 8), pady=(10, 0))
        self.time_entry.bind("<Return>", lambda _event: self.render_from_time())
        ttk.Button(controls, text="上一帧", command=lambda: self.step_frame(-1)).grid(row=1, column=2, pady=(10, 0))
        ttk.Button(controls, text="下一帧", command=lambda: self.step_frame(1)).grid(row=1, column=3, padx=(8, 0), pady=(10, 0))
        self.render_button = ttk.Button(controls, text="刷新预览", command=self.render_from_time)
        self.render_button.grid(row=1, column=4, padx=(8, 0), pady=(10, 0))

        self.scale = ttk.Scale(
            controls,
            from_=0,
            to=max(0, select_preview_frame(
                self.composition.duration,
                self.composition.frame_rate,
                0,
            ).last_frame_index),
            variable=self.frame_var,
            command=self._scale_changed,
        )
        self.scale.grid(row=2, column=0, columnspan=5, sticky="ew", pady=(12, 4))
        self.scale.bind("<ButtonRelease-1>", lambda _event: self.render_from_slider())
        ttk.Label(controls, textvariable=self.frame_label_var).grid(row=3, column=0, columnspan=5, sticky="w")

        footer = ttk.Frame(outer)
        footer.pack(fill=tk.X, pady=(10, 0))
        ttk.Label(footer, textvariable=self.status_var).pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(footer, text="取消", command=self.window.destroy).pack(side=tk.RIGHT)
        self.confirm_button = ttk.Button(footer, text="使用当前帧", command=self.confirm)
        self.confirm_button.pack(side=tk.RIGHT, padx=(0, 8))
        self.confirm_button.configure(state=tk.DISABLED)

    def _sync_title(self) -> None:
        source_note = ""
        if self.composition.id != self.collection_composition.id:
            source_note = f"  ·  收集合成：{self.collection_composition.name}"
        self.title_var.set(
            f"取景：{self.composition.name}{source_note}  ·  "
            f"{self.composition.width}×{self.composition.height}  ·  "
            f"{self.composition.duration:.2f}s  ·  {self.composition.frame_rate:g} fps"
        )

    def _source_changed(self, _event=None) -> None:
        selected = self.source_labels.get(self.source_var.get())
        if selected is None or selected.id == self.composition.id:
            return
        self.composition = selected
        requested_time = self.source_times.get(
            selected.id,
            default_preview_time(selected.duration, selected.frame_rate),
        )
        selection = select_preview_frame(
            selected.duration,
            selected.frame_rate,
            requested_time=requested_time,
            display_start_frame=selected.display_start_frame,
        )
        self.scale.configure(to=selection.last_frame_index)
        self.frame_var.set(selection.frame_index)
        self.time_var.set(f"{selection.time:.3f}")
        self.rendered_frame_index = None
        self.rendered_source_id = None
        self.rendered_renderer = None
        self.confirm_button.configure(state=tk.DISABLED)
        self._sync_title()
        self._sync_frame_label(selection.frame_index)
        self.status_var.set(
            "预览来源已更改，正在生成视频框图层出现后的第 2 秒画面…"
            if selected.id != self.collection_composition.id
            else "预览来源已更改，正在生成第 2 秒画面…"
        )
        self.render_from_time()

    def _scale_changed(self, value: str) -> None:
        frame_index = int(round(float(value)))
        self._sync_frame_label(frame_index)
        self.time_var.set(f"{frame_index / self.composition.frame_rate:.3f}")
        if not self.busy:
            self.confirm_button.configure(
                state=(
                    tk.NORMAL
                    if frame_index == self.rendered_frame_index
                    and self.composition.id == self.rendered_source_id
                    else tk.DISABLED
                )
            )

    def _sync_frame_label(self, frame_index: int) -> None:
        absolute = self.composition.display_start_frame + int(frame_index)
        seconds = frame_index / self.composition.frame_rate
        self.frame_label_var.set(
            f"相对第 {frame_index} 帧  ·  AE 帧号 {absolute}  ·  {seconds:.3f} 秒（拖动后松开即刷新）"
        )

    def _selection_from_time(self):
        try:
            requested = float(self.time_var.get().strip())
        except ValueError as exc:
            raise PreviewError("请输入有效的秒数。") from exc
        return select_preview_frame(
            self.composition.duration,
            self.composition.frame_rate,
            requested_time=requested,
            display_start_frame=self.composition.display_start_frame,
        )

    def render_from_slider(self) -> None:
        frame_index = int(round(self.frame_var.get()))
        self.time_var.set(f"{frame_index / self.composition.frame_rate:.3f}")
        self.render_from_time()

    def step_frame(self, delta: int) -> None:
        maximum = int(float(self.scale.cget("to")))
        frame_index = max(0, min(maximum, int(round(self.frame_var.get())) + delta))
        self.frame_var.set(frame_index)
        self.time_var.set(f"{frame_index / self.composition.frame_rate:.3f}")
        self._sync_frame_label(frame_index)
        self.render_from_time()

    def render_from_time(self) -> None:
        if self.busy:
            return
        try:
            selection = self._selection_from_time()
        except Exception as exc:
            messagebox.showerror("预览时间无效", str(exc), parent=self.window)
            return
        self.frame_var.set(selection.frame_index)
        self.time_var.set(f"{selection.time:.3f}")
        self._sync_frame_label(selection.frame_index)
        source = self.composition
        self.busy = True
        self.render_button.configure(state=tk.DISABLED)
        self.source_combo.configure(state=tk.DISABLED)
        self.confirm_button.configure(state=tk.DISABLED)
        self.status_var.set(
            f"正在后台生成 {selection.time:.3f} 秒（AE 帧号 {selection.frame_number}）…"
        )

        def worker() -> None:
            try:
                try:
                    result = render_bridge_preview(
                        self.aep_path,
                        source.id,
                        source.name,
                        source.duration,
                        source.frame_rate,
                        selection.time,
                        self.cache_file,
                        display_start_frame=source.display_start_frame,
                    )
                except BridgeUnavailable:
                    result = render_preview(
                        self.aep_path,
                        source.name,
                        source.duration,
                        source.frame_rate,
                        selection.time,
                        self.cache_file,
                        display_start_frame=source.display_start_frame,
                    )
                self.window.after(0, lambda: self._render_done(result, source.id))
            except Exception as exc:
                self.window.after(0, lambda exc=exc: self._render_failed(exc))

        threading.Thread(target=worker, daemon=True).start()

    def _render_done(self, result, source_id: int) -> None:
        if not self.window.winfo_exists():
            return
        self.busy = False
        self.render_button.configure(state=tk.NORMAL)
        self.source_combo.configure(state="readonly")
        self.confirm_button.configure(state=tk.NORMAL)
        self.rendered_frame_index = result.frame_index
        self.rendered_source_id = source_id
        self.rendered_renderer = result.renderer
        self.time_var.set(f"{result.time:.3f}")
        self.frame_var.set(result.frame_index)
        self._sync_frame_label(result.frame_index)
        self._show_image(Path(result.output_file))
        mode = "AE 快速预览" if result.renderer == "ae-saveFrameToPng-bridge" else "高质量后台预览"
        self.status_var.set(
            f"已用{mode}生成 {result.time:.3f} 秒画面；最终收集会再做一次高质量渲染。"
        )

    def _render_failed(self, error: Exception) -> None:
        if not self.window.winfo_exists():
            return
        self.busy = False
        self.render_button.configure(state=tk.NORMAL)
        self.source_combo.configure(state="readonly")
        self.confirm_button.configure(state=tk.NORMAL if self.cache_file.is_file() else tk.DISABLED)
        self.status_var.set("预览生成失败，可调整后重试。")
        messagebox.showerror("预览生成失败", str(error), parent=self.window)

    def _show_image(self, path: Path) -> None:
        with Image.open(path) as source:
            rgba = source.convert("RGBA")
        rgba.thumbnail((900, 520), Image.Resampling.LANCZOS)
        checker = Image.new("RGBA", rgba.size, (220, 220, 220, 255))
        draw = ImageDraw.Draw(checker)
        tile = 16
        for y in range(0, rgba.height, tile):
            for x in range(0, rgba.width, tile):
                if (x // tile + y // tile) % 2:
                    draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill=(180, 180, 180, 255))
        display = Image.alpha_composite(checker, rgba)
        self.photo = ImageTk.PhotoImage(display)
        self.image_label.configure(image=self.photo, text="")

    def confirm(self) -> None:
        try:
            selection = self._selection_from_time()
        except Exception as exc:
            messagebox.showerror("预览时间无效", str(exc), parent=self.window)
            return
        if not self.cache_file.is_file():
            messagebox.showinfo("尚无预览", "请先生成预览图。", parent=self.window)
            return
        if selection.frame_index != self.rendered_frame_index:
            messagebox.showinfo(
                "请刷新预览",
                "当前时间尚未生成图像，请先点击“刷新预览”。",
                parent=self.window,
            )
            return
        if self.composition.id != self.rendered_source_id:
            messagebox.showinfo("请刷新预览", "当前预览来源尚未生成图像。", parent=self.window)
            return
        self.on_confirm(
            self.composition,
            selection.time,
            selection.frame_number,
            self.cache_file,
            self.rendered_renderer or "aerender",
        )
        self.window.destroy()


class PrecompositionDialog:
    def __init__(
        self,
        parent: tk.Tk,
        target: CompositionInfo,
        children: tuple[CompositionInfo, ...],
        on_export,
    ) -> None:
        self.on_export = on_export
        self.window = tk.Toplevel(parent)
        self.window.title(f"直属预合成 · {target.name}")
        self.window.geometry("920x460")
        self.window.minsize(720, 360)
        self.window.transient(parent)
        self.window.protocol("WM_DELETE_WINDOW", self.window.destroy)

        outer = ttk.Frame(self.window, padding=12)
        outer.pack(fill=tk.BOTH, expand=True)
        ttk.Label(
            outer,
            text=(
                f"“{target.name}”直接包含 {len(children)} 个预合成。"
                "列表按图层出现顺序展示；分别导出时，每个预合成会继续递归收集自己的下层依赖。"
            ),
            wraplength=880,
            justify=tk.LEFT,
        ).pack(fill=tk.X, pady=(0, 10))

        table_frame = ttk.Frame(outer)
        table_frame.pack(fill=tk.BOTH, expand=True)
        table_frame.rowconfigure(0, weight=1)
        table_frame.columnconfigure(0, weight=1)
        columns = ("id", "size", "duration", "fps", "parents", "children")
        self.tree = ttk.Treeview(
            table_frame,
            columns=columns,
            show="tree headings",
            selectmode="browse",
        )
        self.tree.heading("#0", text="预合成名称")
        self.tree.heading("id", text="ID")
        self.tree.heading("size", text="尺寸")
        self.tree.heading("duration", text="时长")
        self.tree.heading("fps", text="帧率")
        self.tree.heading("parents", text="被哪些合成使用")
        self.tree.heading("children", text="下层预合成")
        self.tree.column("#0", width=220, minwidth=160)
        self.tree.column("id", width=70, anchor=tk.E)
        self.tree.column("size", width=110, anchor=tk.CENTER)
        self.tree.column("duration", width=85, anchor=tk.E)
        self.tree.column("fps", width=70, anchor=tk.E)
        self.tree.column("parents", width=180)
        self.tree.column("children", width=220)
        for index, comp in enumerate(children, start=1):
            self.tree.insert(
                "",
                tk.END,
                iid=str(comp.id),
                text=f"{index}. {comp.name}",
                values=(
                    comp.id,
                    f"{comp.width}×{comp.height}",
                    f"{comp.duration:.2f}s",
                    f"{comp.frame_rate:g}",
                    "、".join(comp.parent_names) or "—",
                    "、".join(comp.child_names) or "—",
                ),
            )
        scroll_y = ttk.Scrollbar(table_frame, orient=tk.VERTICAL, command=self.tree.yview)
        scroll_x = ttk.Scrollbar(table_frame, orient=tk.HORIZONTAL, command=self.tree.xview)
        self.tree.configure(yscrollcommand=scroll_y.set, xscrollcommand=scroll_x.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        scroll_y.grid(row=0, column=1, sticky="ns")
        scroll_x.grid(row=1, column=0, sticky="ew")

        footer = ttk.Frame(outer)
        footer.pack(fill=tk.X, pady=(10, 0))
        ttk.Button(footer, text="关闭", command=self.window.destroy).pack(side=tk.RIGHT)
        ttk.Button(
            footer,
            text="分别导出这些预合成",
            command=self.export_children,
        ).pack(side=tk.RIGHT, padx=(0, 8))

    def export_children(self) -> None:
        self.window.destroy()
        self.on_export()


class CollectorWindow:
    """Desktop composition explorer around the existing safe collection core."""

    COLORS = {
        "canvas": "#ebe9e4",
        "panel": "#f8f7f3",
        "panel_strong": "#fffefa",
        "panel_muted": "#f1f0eb",
        "ink": "#1f2523",
        "ink_soft": "#515b56",
        "ink_faint": "#7d8580",
        "line": "#d9d8d0",
        "line_strong": "#c8c7bd",
        "blue": "#2854d9",
        "blue_deep": "#173aa6",
        "blue_soft": "#e3e9ff",
        "green": "#287457",
        "green_soft": "#dff1e7",
        "amber": "#aa6a1e",
        "amber_soft": "#f9ead0",
        "red": "#b84743",
        "red_soft": "#f9dfdd",
        "purple": "#6f56a5",
        "purple_soft": "#eee8fb",
    }
    PACKAGE_HINTS = (
        "包装",
        "背景",
        "视频框",
        "竖屏框",
        "横屏框",
        "信息条",
        "人名条",
        "标注",
        "分镜",
    )

    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("X.bot AEP 收集器 · 合成结构浏览器")
        self.root.geometry("1440x820")
        self.root.minsize(1080, 680)
        self.root.configure(bg=self.COLORS["canvas"])

        self.project: ProjectInfo | None = None
        self.comp_by_id: dict[int, CompositionInfo] = {}
        self.active_comp_id: int | None = None
        self.checked_ids: set[int] = set()
        self.expanded_ids: set[int] = set()
        self.tree_nodes: dict[str, int] = {}
        self.filter_mode = "all"
        self.tree_mode = "structure"
        self.busy = False
        self.aep_var = tk.StringVar()
        self.output_var = tk.StringVar()
        self.summary_var = tk.StringVar(value="打开 AEP 后会在这里显示完整合成结构。")
        self.project_name_var = tk.StringVar(value="未打开 AEP")
        self.project_meta_var = tk.StringVar(value="选择一个 AEP 工程开始解析")
        self.status_var = tk.StringVar(value="就绪")
        self.selection_title_var = tk.StringVar(value="还没有选择交付对象")
        self.selection_subtitle_var = tk.StringVar(value="从结构树勾选需要独立提取的合成")
        self.visible_count_var = tk.StringVar(value="显示 0 个合成")
        self.selection_count_var = tk.StringVar(value="已选 0")
        self.preview_times: dict[int, float] = {}
        self.preview_frames: dict[int, int] = {}
        self.preview_source_ids: dict[int, int] = {}
        self.preview_files: dict[int, Path] = {}
        self.queue_status: dict[int, str] = {}
        self.filter_buttons: dict[str, tk.Button] = {}
        self.preview_cache_root = Path(tempfile.mkdtemp(prefix="xbot-aep-preview-session-"))
        self.inspector_photo: ImageTk.PhotoImage | None = None
        self.brand_photo: ImageTk.PhotoImage | None = None
        self.tree_icons = self._make_tree_icons()
        self._busy_widgets: list[tk.Widget] = []
        self._workspace_pages: dict[str, tk.Frame] = {}
        self._workspace_tab_buttons: dict[str, tk.Button] = {}
        self._workspace_tab_pills: dict[str, tk.Label] = {}
        self._workspace_tab_indicators: dict[str, tk.Frame] = {}
        self.root.protocol("WM_DELETE_WINDOW", self.close)

        self._configure_styles()
        self._build_ui()
        self._update_action_states()

    def _configure_styles(self) -> None:
        style = ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        font = ("Microsoft YaHei UI", 10)
        style.configure("App.TFrame", background=self.COLORS["canvas"])
        style.configure("Panel.TFrame", background=self.COLORS["panel"])
        style.configure("Surface.TFrame", background=self.COLORS["panel_strong"])
        style.configure("Muted.TLabel", background=self.COLORS["panel"], foreground=self.COLORS["ink_faint"], font=(font[0], 9))
        style.configure("SurfaceMuted.TLabel", background=self.COLORS["panel_strong"], foreground=self.COLORS["ink_faint"], font=(font[0], 9))
        style.configure("Title.TLabel", background=self.COLORS["canvas"], foreground=self.COLORS["ink"], font=(font[0], 19, "bold"))
        style.configure("Eyebrow.TLabel", background=self.COLORS["canvas"], foreground=self.COLORS["blue"], font=(font[0], 9, "bold"))
        style.configure("Top.TLabel", background=self.COLORS["panel_strong"], foreground=self.COLORS["ink"], font=(font[0], 10))
        style.configure("TopMuted.TLabel", background=self.COLORS["panel_strong"], foreground=self.COLORS["ink_faint"], font=(font[0], 9))
        style.configure("Inspector.TLabel", background=self.COLORS["panel"], foreground=self.COLORS["ink"], font=(font[0], 10))
        style.configure("InspectorMuted.TLabel", background=self.COLORS["panel"], foreground=self.COLORS["ink_faint"], font=(font[0], 9))
        style.configure("Primary.TButton", background=self.COLORS["blue"], foreground="#ffffff", padding=(11, 7), borderwidth=0, font=(font[0], 10, "bold"))
        style.map("Primary.TButton", background=[("active", self.COLORS["blue_deep"]), ("disabled", self.COLORS["line"])], foreground=[("disabled", self.COLORS["ink_faint"])])
        style.configure("Quiet.TButton", background=self.COLORS["panel_strong"], foreground=self.COLORS["ink_soft"], padding=(10, 7), borderwidth=1, relief="solid", font=(font[0], 10))
        style.map("Quiet.TButton", background=[("active", self.COLORS["panel_muted"]), ("disabled", self.COLORS["panel_muted"])])
        style.configure("Chip.TLabel", background=self.COLORS["blue_soft"], foreground=self.COLORS["blue_deep"], padding=(7, 4), font=(font[0], 9))
        style.configure("Treeview", background=self.COLORS["panel_strong"], fieldbackground=self.COLORS["panel_strong"], foreground=self.COLORS["ink"], rowheight=42, borderwidth=0, font=(font[0], 10))
        style.map("Treeview", background=[("selected", self.COLORS["blue_soft"])], foreground=[("selected", self.COLORS["ink"])])
        style.configure("Treeview.Heading", background=self.COLORS["panel"], foreground=self.COLORS["ink_faint"], relief="flat", borderwidth=0, font=(font[0], 9, "bold"))
        style.map("Treeview.Heading", background=[("active", self.COLORS["panel_muted"])])
        style.configure("TNotebook", background=self.COLORS["panel"], borderwidth=0, tabmargins=(0, 0, 0, 0))
        style.configure("TNotebook.Tab", background=self.COLORS["panel"], foreground=self.COLORS["ink_faint"], padding=(13, 9), font=(font[0], 10, "bold"))
        style.map("TNotebook.Tab", background=[("selected", self.COLORS["panel_strong"])], foreground=[("selected", self.COLORS["ink"])])

    def _build_ui(self) -> None:
        outer = tk.Frame(self.root, bg=self.COLORS["canvas"])
        outer.pack(fill=tk.BOTH, expand=True)
        self._build_topbar(outer)

        self._build_workspace_tabs(outer)
        self.workspace = tk.Frame(outer, bg=self.COLORS["canvas"])
        self.workspace.pack(fill=tk.BOTH, expand=True)
        self.structure_page = tk.Frame(self.workspace, bg=self.COLORS["canvas"])
        self.queue_page = tk.Frame(self.workspace, bg=self.COLORS["canvas"])
        self.history_page = tk.Frame(self.workspace, bg=self.COLORS["canvas"])
        self._workspace_pages = {
            "explorer": self.structure_page,
            "queue": self.queue_page,
            "history": self.history_page,
        }
        self._build_structure_page()
        self._build_queue_page()
        self._build_history_page()
        self._select_workspace("explorer")
        self._busy_widgets = [
            self.open_button,
            self.reload_button,
            self.expand_button,
            self.collapse_button,
            self.choose_output_button,
        ]

    def _build_workspace_tabs(self, parent: tk.Frame) -> None:
        tabs = tk.Frame(
            parent,
            bg=self.COLORS["panel"],
            height=44,
            highlightbackground=self.COLORS["line"],
            highlightthickness=1,
        )
        tabs.pack(fill=tk.X)
        tabs.pack_propagate(False)
        definitions = (("explorer", "合成结构", "0"), ("queue", "提取队列", "0"), ("history", "最近工程", ""))
        for key, label, count in definitions:
            tab = tk.Frame(tabs, bg=self.COLORS["panel"])
            tab.pack(side=tk.LEFT, fill=tk.Y)
            button = tk.Button(
                tab,
                text=label,
                command=lambda key=key: self._select_workspace(key),
                relief="flat",
                bd=0,
                bg=self.COLORS["panel"],
                fg=self.COLORS["ink_faint"],
                activebackground=self.COLORS["panel"],
                activeforeground=self.COLORS["ink"],
                padx=13,
                pady=8,
                font=("Microsoft YaHei UI", 10, "bold"),
                cursor="hand2",
            )
            button.pack(side=tk.LEFT, fill=tk.Y, pady=(0, 2))
            self._workspace_tab_buttons[key] = button
            if count:
                pill = tk.Label(
                    tab,
                    text=count,
                    bg=self.COLORS["panel_muted"],
                    fg=self.COLORS["ink_faint"],
                    padx=5,
                    pady=1,
                    font=("Cascadia Code", 9),
                )
                pill.pack(side=tk.LEFT, padx=(0, 13), pady=(12, 12))
                self._workspace_tab_pills[key] = pill
            indicator = tk.Frame(tab, bg=self.COLORS["panel"], height=2)
            indicator.pack(side=tk.BOTTOM, fill=tk.X)
            self._workspace_tab_indicators[key] = indicator

    def _select_workspace(self, key: str) -> None:
        page = self._workspace_pages.get(key)
        if page is None:
            return
        for candidate in self._workspace_pages.values():
            candidate.pack_forget()
        page.pack(fill=tk.BOTH, expand=True)
        for tab_key, button in self._workspace_tab_buttons.items():
            active = tab_key == key
            button.configure(
                bg=self.COLORS["panel_strong"] if active else self.COLORS["panel"],
                fg=self.COLORS["ink"] if active else self.COLORS["ink_faint"],
                activebackground=self.COLORS["panel_strong"] if active else self.COLORS["panel"],
            )
            self._workspace_tab_indicators[tab_key].configure(
                bg=self.COLORS["blue"] if active else self.COLORS["panel"]
            )
            pill = self._workspace_tab_pills.get(tab_key)
            if pill is not None:
                pill.configure(
                    bg=self.COLORS["blue_soft"] if active else self.COLORS["panel_muted"],
                    fg=self.COLORS["blue"] if active else self.COLORS["ink_faint"],
                )

    def _build_topbar(self, parent: tk.Frame) -> None:
        topbar = tk.Frame(parent, bg=self.COLORS["panel_strong"], height=68, highlightbackground=self.COLORS["line"], highlightthickness=1)
        topbar.pack(fill=tk.X)
        topbar.pack_propagate(False)

        brand = tk.Frame(topbar, bg=self.COLORS["panel_strong"])
        brand.pack(side=tk.LEFT, padx=(20, 18), pady=12)
        self.brand_photo = self._load_brand_photo()
        if self.brand_photo is not None:
            tk.Label(brand, image=self.brand_photo, bg=self.COLORS["panel_strong"]).pack(side=tk.LEFT, padx=(0, 10))
        else:
            tk.Label(brand, text="X", bg="#202735", fg="#ffffff", width=3, height=2, font=("Cascadia Code", 10, "bold")).pack(side=tk.LEFT, padx=(0, 10))
        brand_copy = tk.Frame(brand, bg=self.COLORS["panel_strong"])
        brand_copy.pack(side=tk.LEFT)
        tk.Label(brand_copy, text="X.bot AEP 收集器", bg=self.COLORS["panel_strong"], fg=self.COLORS["ink"], font=("Microsoft YaHei UI", 11, "bold")).pack(anchor="w")
        tk.Label(brand_copy, text="合成结构浏览器 · UI 预览 v0", bg=self.COLORS["panel_strong"], fg=self.COLORS["ink_faint"], font=("Microsoft YaHei UI", 9)).pack(anchor="w", pady=(1, 0))

        context = tk.Frame(topbar, bg=self.COLORS["panel_strong"])
        context.pack(side=tk.LEFT, fill=tk.X, expand=True, pady=12)
        file_mark = tk.Frame(context, width=30, height=36, bg=self.COLORS["panel_muted"], highlightbackground=self.COLORS["line_strong"], highlightthickness=1)
        file_mark.pack(side=tk.LEFT, padx=(0, 10))
        file_mark.pack_propagate(False)
        tk.Label(file_mark, text="AEP", bg=self.COLORS["panel_muted"], fg=self.COLORS["blue"], font=("Cascadia Code", 9)).pack(expand=True)
        context_copy = tk.Frame(context, bg=self.COLORS["panel_strong"])
        context_copy.pack(side=tk.LEFT, fill=tk.X, expand=True)
        tk.Label(context_copy, textvariable=self.project_name_var, bg=self.COLORS["panel_strong"], fg=self.COLORS["ink"], font=("Microsoft YaHei UI", 10, "bold"), anchor="w").pack(fill=tk.X)
        tk.Label(context_copy, textvariable=self.project_meta_var, bg=self.COLORS["panel_strong"], fg=self.COLORS["ink_faint"], font=("Microsoft YaHei UI", 9), anchor="w").pack(fill=tk.X, pady=(1, 0))

        actions = tk.Frame(topbar, bg=self.COLORS["panel_strong"])
        actions.pack(side=tk.RIGHT, padx=20, pady=12)
        self.parse_state_label = tk.Label(actions, text="● 未打开工程", bg=self.COLORS["panel_strong"], fg=self.COLORS["amber"], font=("Microsoft YaHei UI", 9))
        self.parse_state_label.pack(side=tk.LEFT, padx=(0, 10))
        self.open_button = ttk.Button(actions, text="打开其他 AEP", command=self.choose_aep, style="Quiet.TButton")
        self.open_button.pack(side=tk.LEFT)

    def _load_brand_photo(self) -> ImageTk.PhotoImage | None:
        if getattr(sys, "frozen", False):
            path = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "assets" / "logo.png"
        else:
            path = Path(__file__).resolve().parents[2] / "eagle-plugin" / "logo.png"
        try:
            image = Image.open(path).convert("RGBA").resize((34, 34), Image.Resampling.LANCZOS)
            return ImageTk.PhotoImage(image)
        except (OSError, tk.TclError):
            return None

    def _make_tree_icons(self) -> dict[str, ImageTk.PhotoImage]:
        icons: dict[str, ImageTk.PhotoImage] = {}
        for key, fill, outline, text_color in (
            ("base", self.COLORS["blue_soft"], self.COLORS["blue"], self.COLORS["blue"]),
            ("root", self.COLORS["green_soft"], self.COLORS["green"], self.COLORS["green"]),
            ("temp", self.COLORS["amber_soft"], self.COLORS["amber"], self.COLORS["amber"]),
            ("shared", self.COLORS["purple_soft"], self.COLORS["purple"], self.COLORS["purple"]),
        ):
            image = Image.new("RGBA", (22, 22), (0, 0, 0, 0))
            draw = ImageDraw.Draw(image)
            draw.rounded_rectangle((1, 1, 20, 20), radius=5, fill=fill, outline=outline, width=1)
            draw.text((7, 4), "C", fill=text_color)
            icons[key] = ImageTk.PhotoImage(image)
        return icons

    def _build_structure_page(self) -> None:
        head = tk.Frame(self.structure_page, bg=self.COLORS["canvas"])
        head.pack(fill=tk.X, padx=22, pady=(20, 10))
        copy = tk.Frame(head, bg=self.COLORS["canvas"])
        copy.pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Label(copy, text="Composition Explorer / 01", style="Eyebrow.TLabel").pack(anchor="w")
        ttk.Label(copy, text="先看懂工程，再决定提取什么", style="Title.TLabel").pack(anchor="w", pady=(3, 0))
        tk.Label(copy, text="按合成嵌套关系浏览复杂 AEP。复选框只代表独立交付对象，子合成会作为依赖被收集，不会被意外拆成多个 ZIP。", bg=self.COLORS["canvas"], fg=self.COLORS["ink_soft"], font=("Microsoft YaHei UI", 9), anchor="w").pack(anchor="w", pady=(6, 0))
        head_actions = tk.Frame(head, bg=self.COLORS["canvas"])
        head_actions.pack(side=tk.RIGHT, anchor="s")
        self.reload_button = ttk.Button(head_actions, text="重新解析", command=self.load_aep, style="Quiet.TButton")
        self.reload_button.pack(side=tk.LEFT, padx=(0, 7))
        self.expand_button = ttk.Button(head_actions, text="展开全部", command=self.expand_all, style="Quiet.TButton")
        self.expand_button.pack(side=tk.LEFT, padx=(0, 7))
        self.collapse_button = ttk.Button(head_actions, text="收起全部", command=self.collapse_all, style="Quiet.TButton")
        self.collapse_button.pack(side=tk.LEFT, padx=(0, 7))
        self.candidate_button = ttk.Button(head_actions, text="查看推荐交付", command=lambda: self.set_filter("candidate"), style="Primary.TButton")
        self.candidate_button.pack(side=tk.LEFT)

        shell = tk.Frame(self.structure_page, bg=self.COLORS["panel_strong"], highlightbackground=self.COLORS["line"], highlightthickness=1)
        shell.pack(fill=tk.BOTH, expand=True, padx=20, pady=(0, 18))
        shell.grid_columnconfigure(0, minsize=218, weight=0)
        shell.grid_columnconfigure(1, minsize=470, weight=1)
        shell.grid_columnconfigure(2, minsize=330, weight=0)
        shell.grid_rowconfigure(0, weight=1)

        self._build_side_panel(shell)
        self._build_tree_panel(shell)
        self._build_inspector(shell)

        selection_bar = tk.Frame(self.structure_page, bg=self.COLORS["panel_strong"], highlightbackground=self.COLORS["line"], highlightthickness=1)
        selection_bar.configure(height=58)
        selection_bar.pack_propagate(False)
        selection_bar.place(relx=0, rely=1, anchor="sw", relwidth=1)
        selection_bar.lift()
        summary = tk.Frame(selection_bar, bg=self.COLORS["panel_strong"])
        summary.pack(side=tk.LEFT, padx=16, pady=11)
        tk.Label(summary, textvariable=self.selection_title_var, bg=self.COLORS["panel_strong"], fg=self.COLORS["ink"], font=("Microsoft YaHei UI", 10, "bold"), anchor="w").pack(anchor="w")
        tk.Label(summary, textvariable=self.selection_subtitle_var, bg=self.COLORS["panel_strong"], fg=self.COLORS["ink_faint"], font=("Microsoft YaHei UI", 9), anchor="w").pack(anchor="w", pady=(2, 0))
        self.selection_chip_frame = tk.Frame(selection_bar, bg=self.COLORS["panel_strong"])
        self.selection_chip_frame.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=4, pady=8)
        actions = tk.Frame(selection_bar, bg=self.COLORS["panel_strong"])
        actions.pack(side=tk.RIGHT, padx=14, pady=10)
        self.clear_button = ttk.Button(actions, text="清空选择", command=self.clear_selection, style="Quiet.TButton")
        self.clear_button.pack(side=tk.LEFT, padx=(0, 7))
        self.collect_button = ttk.Button(actions, text="开始收集 0 项", command=self.collect_selected, style="Primary.TButton")
        self.collect_button.pack(side=tk.LEFT)

    def _build_side_panel(self, shell: tk.Frame) -> None:
        side = tk.Frame(shell, bg=self.COLORS["panel"], padx=12, pady=15)
        side.grid(row=0, column=0, sticky="nsew", padx=(1, 0), pady=1)
        kicker = tk.Frame(side, bg=self.COLORS["panel"])
        kicker.pack(fill=tk.X, padx=7)
        tk.Label(kicker, text="浏览方式", bg=self.COLORS["panel"], fg=self.COLORS["ink_faint"], font=("Microsoft YaHei UI", 9, "bold")).pack(side=tk.LEFT)
        tk.Label(kicker, text="VIEW", bg=self.COLORS["panel"], fg=self.COLORS["ink_faint"], font=("Cascadia Code", 8)).pack(side=tk.RIGHT)
        self._build_filter_buttons(side)

        tk.Label(side, text="状态图例", bg=self.COLORS["panel"], fg=self.COLORS["ink_faint"], font=("Microsoft YaHei UI", 9, "bold")).pack(anchor="w", padx=7, pady=(20, 6))
        legend = (("#287457", "可收集"), ("#aa6a1e", "需要复核"), ("#b84743", "阻止收集"), ("#6f56a5", "多处复用"))
        for color, text in legend:
            row = tk.Frame(side, bg=self.COLORS["panel"])
            row.pack(fill=tk.X, padx=7, pady=3)
            dot = tk.Canvas(row, width=8, height=8, bg=self.COLORS["panel"], highlightthickness=0, bd=0)
            dot.create_oval(1, 1, 7, 7, fill=color, outline=color)
            dot.pack(side=tk.LEFT, pady=1)
            tk.Label(row, text=text, bg=self.COLORS["panel"], fg=self.COLORS["ink_soft"], font=("Microsoft YaHei UI", 9)).pack(side=tk.LEFT, padx=(6, 0))

        tk.Label(side, text="键盘操作", bg=self.COLORS["panel"], fg=self.COLORS["ink_faint"], font=("Microsoft YaHei UI", 9, "bold")).pack(anchor="w", padx=7, pady=(20, 6))
        keyboard = (("Space", "勾选当前合成"), ("Enter", "查看详情"), ("← →", "收起 / 展开"))
        for key, text in keyboard:
            row = tk.Frame(side, bg=self.COLORS["panel"])
            row.pack(fill=tk.X, padx=7, pady=3)
            tk.Label(row, text=key, bg=self.COLORS["panel_muted"], fg=self.COLORS["ink_faint"], padx=4, pady=1, font=("Cascadia Code", 8)).pack(side=tk.LEFT)
            tk.Label(row, text=text, bg=self.COLORS["panel"], fg=self.COLORS["ink_soft"], font=("Microsoft YaHei UI", 9)).pack(side=tk.LEFT, padx=(8, 0))

        note_wrap = tk.Frame(side, bg=self.COLORS["panel"], highlightbackground=self.COLORS["line"], highlightthickness=1)
        note_wrap.pack(fill=tk.X, padx=7, pady=(22, 0))
        note = tk.Label(note_wrap, text="合成可能被多个父级复用。这里的树是帮助浏览的虚拟结构，所有勾选状态仍按合成 ID 全局保持。", bg=self.COLORS["panel"], fg=self.COLORS["ink_faint"], justify=tk.LEFT, wraplength=175, padx=8, pady=9, font=("Microsoft YaHei UI", 9))
        note.pack(fill=tk.X)

    def _build_filter_buttons(self, parent: tk.Frame) -> None:
        definitions = (("all", "全部合成"), ("candidate", "推荐交付"), ("root", "顶层合成"), ("child", "直属预合成"), ("warning", "有警告"))
        self.filter_rows: dict[str, tk.Frame] = {}
        self.filter_count_labels: dict[str, tk.Label] = {}
        for key, label in definitions:
            row = tk.Frame(parent, bg=self.COLORS["blue_soft"] if key == "all" else self.COLORS["panel"])
            row.pack(fill=tk.X, pady=1)
            button = tk.Button(row, text=label, command=lambda key=key: self.set_filter(key), relief="flat", bd=0, anchor="w", padx=8, pady=7, bg=self.COLORS["blue_soft"] if key == "all" else self.COLORS["panel"], fg=self.COLORS["blue_deep"] if key == "all" else self.COLORS["ink_soft"], activebackground=self.COLORS["blue_soft"], font=("Microsoft YaHei UI", 9, "bold" if key == "all" else "normal"))
            button.pack(side=tk.LEFT, fill=tk.X, expand=True)
            count_label = tk.Label(row, text="0", bg=self.COLORS["blue_soft"] if key == "all" else self.COLORS["panel"], fg=self.COLORS["blue"] if key == "all" else self.COLORS["ink_faint"], padx=8, font=("Cascadia Code", 9))
            count_label.pack(side=tk.RIGHT)
            self.filter_buttons[key] = button
            self.filter_rows[key] = row
            self.filter_count_labels[key] = count_label

    def _build_tree_panel(self, shell: tk.Frame) -> None:
        center = tk.Frame(shell, bg=self.COLORS["panel_strong"])
        center.grid(row=0, column=1, sticky="nsew", padx=1, pady=1)
        center.grid_rowconfigure(1, weight=1)
        center.grid_columnconfigure(0, weight=1)

        toolbar = tk.Frame(center, bg=self.COLORS["panel_strong"], padx=15, pady=13, highlightbackground=self.COLORS["line"], highlightthickness=1)
        toolbar.grid(row=0, column=0, sticky="ew")
        toolbar.grid_columnconfigure(0, weight=1)
        self.search_var = tk.StringVar()
        search_wrap = tk.Frame(toolbar, bg=self.COLORS["panel"], highlightbackground=self.COLORS["line"], highlightthickness=1)
        search_wrap.grid(row=0, column=0, sticky="ew", padx=(0, 8))
        search_wrap.grid_columnconfigure(1, weight=1)
        tk.Label(search_wrap, text="⌕", bg=self.COLORS["panel"], fg=self.COLORS["ink_faint"], font=("Arial", 17)).grid(row=0, column=0, padx=(9, 3))
        search = tk.Entry(search_wrap, textvariable=self.search_var, relief="flat", bd=0, bg=self.COLORS["panel"], fg=self.COLORS["ink"], insertbackground=self.COLORS["ink"], font=("Microsoft YaHei UI", 10))
        search.grid(row=0, column=1, sticky="ew", padx=(0, 8), ipady=6)
        search.insert(0, "搜索合成名称、类型或尺寸…")
        search.configure(fg=self.COLORS["ink_faint"])
        search.bind("<FocusIn>", lambda _event: self._clear_search_placeholder(search))
        search.bind("<FocusOut>", lambda _event: self._restore_search_placeholder(search))
        search.bind("<KeyRelease>", lambda _event: self._search_changed())
        self.search_entry = search
        view_toggle = tk.Frame(toolbar, bg=self.COLORS["panel"], highlightbackground=self.COLORS["line"], highlightthickness=1, padx=2, pady=2)
        view_toggle.grid(row=0, column=1, sticky="e")
        self.structure_mode_button = tk.Button(view_toggle, text="合成结构", command=lambda: self.set_tree_mode("structure"), relief="flat", bd=0, bg=self.COLORS["panel_strong"], fg=self.COLORS["ink"], activebackground=self.COLORS["panel_strong"], padx=9, pady=5, font=("Microsoft YaHei UI", 9, "bold"))
        self.structure_mode_button.pack(side=tk.LEFT)
        self.list_mode_button = tk.Button(view_toggle, text="工程目录", command=lambda: self.set_tree_mode("list"), relief="flat", bd=0, bg=self.COLORS["panel"], fg=self.COLORS["ink_faint"], activebackground=self.COLORS["panel_strong"], padx=9, pady=5, font=("Microsoft YaHei UI", 9))
        self.list_mode_button.pack(side=tk.LEFT)
        summary = tk.Frame(center, bg=self.COLORS["panel_muted"], padx=15, pady=9, highlightbackground=self.COLORS["line"], highlightthickness=1)
        summary.grid(row=2, column=0, sticky="ew")
        tk.Label(summary, textvariable=self.visible_count_var, bg=self.COLORS["panel_muted"], fg=self.COLORS["ink_soft"], font=("Microsoft YaHei UI", 9)).pack(side=tk.LEFT)
        tk.Label(summary, textvariable=self.selection_count_var, bg=self.COLORS["panel_muted"], fg=self.COLORS["ink_faint"], font=("Cascadia Code", 9)).pack(side=tk.RIGHT)

        table_frame = tk.Frame(center, bg=self.COLORS["panel_strong"])
        table_frame.grid(row=1, column=0, sticky="nsew")
        table_frame.grid_rowconfigure(0, weight=1)
        table_frame.grid_columnconfigure(0, weight=1)
        self.tree = ttk.Treeview(table_frame, columns=("size", "duration", "status"), show="tree headings", selectmode="browse")
        self.tree.heading("#0", text="合成 / 嵌套关系")
        self.tree.heading("size", text="尺寸")
        self.tree.heading("duration", text="时长")
        self.tree.heading("status", text="状态")
        self.tree.column("#0", width=350, minwidth=250, stretch=True)
        self.tree.column("size", width=108, minwidth=96, anchor=tk.CENTER)
        self.tree.column("duration", width=80, minwidth=70, anchor=tk.E)
        self.tree.column("status", width=105, minwidth=90, anchor=tk.W)
        self.tree.tag_configure("candidate", foreground=self.COLORS["blue_deep"])
        self.tree.tag_configure("shared", foreground=self.COLORS["purple"])
        self.tree.tag_configure("child", foreground=self.COLORS["amber"])
        self.tree.tag_configure("checked", background=self.COLORS["blue_soft"])
        scroll_y = ttk.Scrollbar(table_frame, orient=tk.VERTICAL, command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll_y.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        scroll_y.grid(row=0, column=1, sticky="ns")
        self.tree.bind("<<TreeviewSelect>>", self._on_tree_select)
        self.tree.bind("<Button-1>", self._on_tree_click, add="+")
        self.tree.bind("<space>", self._on_tree_space)
        self.tree.bind("<Control-a>", self._select_visible)
        self.tree.bind("<Escape>", self._clear_selection_event)
        self.tree.bind("<Return>", self._preview_focused_event)
        self.tree.bind("<<TreeviewOpen>>", self._on_tree_open)
        self.tree.bind("<<TreeviewClose>>", self._on_tree_close)
        tip = tk.Label(center, text="ⓘ  “包装”在多个位置出现时，紫色共享标记表示同一个合成，不是重复文件。选中任一位置都会同步。", bg=self.COLORS["panel_muted"], fg=self.COLORS["ink_soft"], anchor="w", padx=10, pady=8, font=("Microsoft YaHei UI", 9))
        tip.grid(row=3, column=0, sticky="ew", padx=10, pady=(10, 11))

    def _build_inspector(self, shell: tk.Frame) -> None:
        self.inspector = tk.Frame(shell, bg=self.COLORS["panel"], padx=15, pady=15)
        self.inspector.grid(row=0, column=2, sticky="nsew", padx=(0, 1), pady=1)
        self.inspector.grid_columnconfigure(0, weight=1)
        self._render_inspector()

    def _build_queue_page(self) -> None:
        head = tk.Frame(self.queue_page, bg=self.COLORS["canvas"])
        head.pack(fill=tk.X, padx=22, pady=(20, 14))
        ttk.Label(head, text="Collection Queue / 02", style="Eyebrow.TLabel").pack(anchor="w")
        ttk.Label(head, text="收集队列", style="Title.TLabel").pack(anchor="w", pady=(3, 0))
        tk.Label(head, text="每个交付对象独立显示状态。某一项预览失败时，其他 ZIP 仍然保留并可以单独复核。", bg=self.COLORS["canvas"], fg=self.COLORS["ink_soft"], font=("Microsoft YaHei UI", 9), anchor="w").pack(anchor="w", pady=(6, 0))

        shell = tk.Frame(self.queue_page, bg=self.COLORS["panel_strong"], highlightbackground=self.COLORS["line"], highlightthickness=1)
        shell.pack(fill=tk.BOTH, expand=True, padx=20, pady=(0, 12))
        shell.grid_rowconfigure(1, weight=1)
        shell.grid_columnconfigure(0, weight=1)
        queue_toolbar = tk.Frame(shell, bg=self.COLORS["panel_strong"], padx=14, pady=12)
        queue_toolbar.grid(row=0, column=0, sticky="ew")
        tk.Label(queue_toolbar, text="输出目录", bg=self.COLORS["panel_strong"], fg=self.COLORS["ink_faint"], font=("Microsoft YaHei UI", 9)).pack(side=tk.LEFT, padx=(0, 8))
        self.output_entry = tk.Entry(queue_toolbar, textvariable=self.output_var, relief="solid", bd=1, bg=self.COLORS["panel"], fg=self.COLORS["ink_soft"], insertbackground=self.COLORS["ink"], font=("Cascadia Code", 9))
        self.output_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, ipady=4)
        self.choose_output_button = ttk.Button(queue_toolbar, text="选择目录", command=self.choose_output, style="Quiet.TButton")
        self.choose_output_button.pack(side=tk.LEFT, padx=(8, 7))
        ttk.Button(queue_toolbar, text="打开输出目录", command=self.open_output, style="Quiet.TButton").pack(side=tk.RIGHT)
        table_frame = tk.Frame(shell, bg=self.COLORS["panel_strong"], padx=14, pady=0)
        table_frame.grid(row=1, column=0, sticky="nsew", pady=(0, 14))
        table_frame.grid_rowconfigure(0, weight=1)
        table_frame.grid_columnconfigure(0, weight=1)
        self.queue_tree = ttk.Treeview(table_frame, columns=("role", "status", "output"), show="tree headings", selectmode="browse")
        self.queue_tree.heading("#0", text="交付对象")
        self.queue_tree.heading("role", text="关系")
        self.queue_tree.heading("status", text="状态")
        self.queue_tree.heading("output", text="结果")
        self.queue_tree.column("#0", width=290, minwidth=200, stretch=True)
        self.queue_tree.column("role", width=140, minwidth=110)
        self.queue_tree.column("status", width=140, minwidth=110)
        self.queue_tree.column("output", width=520, minwidth=300, stretch=True)
        self.queue_tree.tag_configure("done", foreground=self.COLORS["green"])
        self.queue_tree.tag_configure("working", foreground=self.COLORS["blue"])
        self.queue_tree.tag_configure("warning", foreground=self.COLORS["amber"])
        self.queue_tree.tag_configure("blocked", foreground=self.COLORS["red"])
        queue_scroll = ttk.Scrollbar(table_frame, orient=tk.VERTICAL, command=self.queue_tree.yview)
        self.queue_tree.configure(yscrollcommand=queue_scroll.set)
        self.queue_tree.grid(row=0, column=0, sticky="nsew")
        queue_scroll.grid(row=0, column=1, sticky="ns")
        tk.Label(self.queue_page, textvariable=self.status_var, bg=self.COLORS["canvas"], fg=self.COLORS["ink_faint"], font=("Microsoft YaHei UI", 9), anchor="w").pack(fill=tk.X, padx=22, pady=(0, 8))
        log_frame = ttk.LabelFrame(self.queue_page, text="运行记录", padding=6)
        log_frame.pack(fill=tk.X, padx=20, pady=(0, 8))
        self.log = tk.Text(log_frame, height=5, wrap="word", state=tk.DISABLED, bg=self.COLORS["panel_strong"], fg=self.COLORS["ink_soft"], relief="flat", font=("Cascadia Code", 8))
        self.log.pack(fill=tk.X, expand=True)

    def _build_history_page(self) -> None:
        head = tk.Frame(self.history_page, bg=self.COLORS["canvas"])
        head.pack(fill=tk.X, padx=22, pady=(20, 14))
        ttk.Label(head, text="Recent Projects / 03", style="Eyebrow.TLabel").pack(anchor="w")
        ttk.Label(head, text="最近工程", style="Title.TLabel").pack(anchor="w", pady=(3, 0))
        tk.Label(head, text="保留最近打开的 AEP 和上次的提取队列，后续可接入工程快照恢复。", bg=self.COLORS["canvas"], fg=self.COLORS["ink_soft"], font=("Microsoft YaHei UI", 9), anchor="w").pack(anchor="w", pady=(6, 0))
        card = tk.Frame(self.history_page, bg=self.COLORS["panel_strong"], highlightbackground=self.COLORS["line"], highlightthickness=1, padx=18, pady=18)
        card.pack(fill=tk.X, padx=20, pady=(0, 12))
        tk.Label(card, text="当前工程", bg=self.COLORS["panel_strong"], fg=self.COLORS["ink_faint"], font=("Microsoft YaHei UI", 9, "bold")).pack(anchor="w")
        tk.Label(card, textvariable=self.aep_var, bg=self.COLORS["panel_strong"], fg=self.COLORS["ink"], font=("Microsoft YaHei UI", 12, "bold"), anchor="w").pack(fill=tk.X, pady=(7, 2))
        tk.Label(card, textvariable=self.summary_var, bg=self.COLORS["panel_strong"], fg=self.COLORS["ink_soft"], font=("Microsoft YaHei UI", 9), anchor="w").pack(fill=tk.X)
        tk.Label(self.history_page, text="历史记录将在实际运行过至少一个工程后显示。", bg=self.COLORS["canvas"], fg=self.COLORS["ink_faint"], font=("Microsoft YaHei UI", 9)).pack(anchor="w", padx=22, pady=10)

    def append_log(self, text: str) -> None:
        if not hasattr(self, "log"):
            return
        self.log.configure(state=tk.NORMAL)
        self.log.insert(tk.END, text.rstrip() + "\n")
        self.log.see(tk.END)
        self.log.configure(state=tk.DISABLED)

    def set_busy(self, busy: bool, status: str) -> None:
        self.busy = busy
        self.status_var.set(status)
        for widget in self._busy_widgets:
            try:
                widget.configure(state=tk.DISABLED if busy else tk.NORMAL)
            except tk.TclError:
                pass
        self._update_action_states()

    def _update_action_states(self) -> None:
        has_project = self.project is not None
        has_focus = self._focused_composition() is not None
        has_selection = bool(self.checked_ids)
        if hasattr(self, "preview_button"):
            self.preview_button.configure(state=tk.NORMAL if has_focus and not self.busy else tk.DISABLED)
        if hasattr(self, "precomp_button"):
            self.precomp_button.configure(state=tk.NORMAL if has_focus and not self.busy else tk.DISABLED)
        if hasattr(self, "children_button"):
            self.children_button.configure(state=tk.NORMAL if has_focus and not self.busy else tk.DISABLED)
        if hasattr(self, "export_precomp_button"):
            self.export_precomp_button.configure(state=tk.NORMAL if has_focus and not self.busy else tk.DISABLED)
        if hasattr(self, "collect_button"):
            self.collect_button.configure(state=tk.NORMAL if has_selection and has_project and not self.busy else tk.DISABLED)
            self.collect_button.configure(text=f"开始收集 {len(self.checked_ids)} 项")
        if hasattr(self, "clear_button"):
            self.clear_button.configure(state=tk.NORMAL if has_selection and not self.busy else tk.DISABLED)
        if hasattr(self, "candidate_button"):
            self.candidate_button.configure(state=tk.NORMAL if has_project and not self.busy else tk.DISABLED)
        if hasattr(self, "reload_button"):
            self.reload_button.configure(state=tk.NORMAL if self.aep_var.get().strip() and not self.busy else tk.DISABLED)
        if hasattr(self, "open_button"):
            self.open_button.configure(state=tk.NORMAL if not self.busy else tk.DISABLED)
        if hasattr(self, "expand_button"):
            self.expand_button.configure(state=tk.NORMAL if has_project and not self.busy else tk.DISABLED)
        if hasattr(self, "collapse_button"):
            self.collapse_button.configure(state=tk.NORMAL if has_project and not self.busy else tk.DISABLED)
        if hasattr(self, "choose_output_button"):
            self.choose_output_button.configure(state=tk.NORMAL if not self.busy else tk.DISABLED)

    def choose_aep(self) -> None:
        path = filedialog.askopenfilename(title="选择 AEP 工程", filetypes=[("After Effects Project", "*.aep")])
        if path:
            self.aep_var.set(path)
            if not self.output_var.get():
                self.output_var.set(str(Path(path).parent / "Xbot_Collected_Projects"))
            self.load_aep()

    def load_aep(self) -> None:
        path = self.aep_var.get().strip()
        if not path:
            messagebox.showinfo("请选择工程", "请先选择一个 AEP 工程。")
            return
        self.set_busy(True, "正在离线解析 AEP 结构…")
        self.append_log(f"开始解析：{path}")

        def worker() -> None:
            try:
                result = inspect_project(path)
                self.root.after(0, lambda: self._show_project(result))
            except Exception as exc:
                self.root.after(0, lambda exc=exc: self._show_error("解析失败", exc))

        threading.Thread(target=worker, daemon=True).start()

    def _show_project(self, project: ProjectInfo) -> None:
        self.project = project
        self.comp_by_id = {item.id: item for item in project.compositions}
        self.preview_times.clear()
        self.preview_frames.clear()
        self.preview_source_ids.clear()
        self.preview_files.clear()
        self.checked_ids.clear()
        self.queue_status.clear()
        self.filter_mode = "all"
        self.tree_mode = "structure"
        root_ids = {item.id for item in project.compositions if not item.parent_ids}
        self.expanded_ids = set(root_ids)
        candidate = next((item for item in project.compositions if self._is_package_candidate(item)), project.compositions[0] if project.compositions else None)
        self.active_comp_id = candidate.id if candidate else None
        by_id = self.comp_by_id
        for comp in project.compositions:
            recommendation = recommend_preview_source(project, comp)
            source = by_id.get(recommendation.source_id, comp)
            source_candidates = preview_source_candidates(project, comp)
            source_times = {candidate.id: preview_time_for_source(project, comp, candidate) for candidate in source_candidates}
            preview_time = source_times[source.id]
            preview_selection = select_preview_frame(source.duration, source.frame_rate, preview_time, display_start_frame=source.display_start_frame)
            self.preview_times[comp.id] = preview_time
            self.preview_frames[comp.id] = preview_selection.frame_number
            self.preview_source_ids[comp.id] = source.id
        self.summary_var.set(f"AE {project.ae_version} · 项目项 {project.item_count} · 合成 {len(project.compositions)} 个")
        self.aep_var.set(project.path)
        self.project_name_var.set(Path(project.path).name)
        self.project_meta_var.set(f"完整项目快照 · {project.item_count} 个项目项 · {len(project.compositions)} 个合成 · 解析于刚刚")
        if "explorer" in self._workspace_tab_pills:
            self._workspace_tab_pills["explorer"].configure(text=str(len(project.compositions)))
        self.parse_state_label.configure(text="● 结构已解析", fg=self.COLORS["green"])
        self.append_log(f"解析完成：识别 {len(project.compositions)} 个合成，已按父级使用关系建立结构树。")
        fast, fast_message = bridge_status(project.path)
        self.append_log(("快速预览可用：" if fast else "快速预览未启用：") + fast_message)
        self.render_tree()
        self.render_selection()
        self._render_inspector()
        self.set_busy(False, "解析完成")

    def _is_package_candidate(self, comp: CompositionInfo) -> bool:
        name = comp.name.casefold()
        return any(term.casefold() in name for term in self.PACKAGE_HINTS)

    def _is_visible_match(self, comp: CompositionInfo) -> bool:
        if self.filter_mode == "candidate" and not self._is_package_candidate(comp):
            return False
        if self.filter_mode == "root" and comp.parent_ids:
            return False
        if self.filter_mode == "child" and not comp.parent_ids:
            return False
        if self.filter_mode == "warning" and not self._has_review_signal(comp):
            return False
        query = self.search_var.get().strip() if hasattr(self, "search_var") else ""
        if query and query != "搜索合成名称、类型或尺寸…":
            haystack = f"{comp.name} {comp.role} {comp.width}x{comp.height} {comp.duration:.2f}".casefold()
            if query.casefold() not in haystack:
                return False
        return True

    def _has_review_signal(self, comp: CompositionInfo) -> bool:
        """Expose the preview's review filter without inventing collection results."""
        return len(comp.parent_ids) > 1 or any(
            term in comp.name for term in ("测试", "临时", "视频框", "横屏框", "竖屏框")
        )

    def _has_visible_descendant(self, comp_id: int, path: set[int] | None = None) -> bool:
        if self.project is None:
            return False
        path = set(path or ())
        if comp_id in path:
            return False
        path.add(comp_id)
        comp = self.comp_by_id[comp_id]
        return any(self._is_visible_match(self.comp_by_id[child_id]) or self._has_visible_descendant(child_id, path) for child_id in comp.child_ids if child_id in self.comp_by_id)

    def _node_status(self, comp: CompositionInfo, reference: bool = False) -> str:
        if reference:
            return "共享引用"
        if "测试" in comp.name or "临时" in comp.name:
            return "阻止收集"
        if self._is_package_candidate(comp):
            return "可收集"
        if self._has_review_signal(comp):
            return "需要复核"
        return "可查看"

    def _node_role(self, comp: CompositionInfo) -> str:
        if not comp.parent_ids:
            return "顶层合成"
        return "直属预合成" if self._is_package_candidate(comp) else "内部预合成"

    def _node_tags(self, comp: CompositionInfo, reference: bool) -> tuple[str, ...]:
        if reference:
            return ("shared",)
        if comp.id in self.checked_ids:
            return ("checked",)
        if self._is_package_candidate(comp):
            return ("candidate",)
        if comp.child_ids:
            return ("child",)
        return ()

    def _tree_text(self, comp: CompositionInfo, reference: bool = False) -> str:
        checked = "☑" if comp.id in self.checked_ids else "☐"
        suffix = "  · 同一合成" if reference else ""
        return f"{checked}  {comp.name}{suffix}  · {self._node_role(comp)}"

    def render_tree(self) -> None:
        self.tree.delete(*self.tree.get_children())
        self.tree_nodes.clear()
        if self.project is None:
            self.visible_count_var.set("当前显示 0 个合成 · 点击名称查看详情，勾选框加入提取队列")
            self.selection_count_var.set(f"已选 {len(self.checked_ids)}")
            return
        if self.tree_mode == "list":
            for comp in sorted((item for item in self.project.compositions if self._is_visible_match(item)), key=lambda item: (item.name.casefold(), item.id)):
                self._insert_tree_node("", comp, (), set(), reference=False)
        else:
            seen: set[int] = set()
            root_items = [item for item in self.project.compositions if not item.parent_ids]
            if not root_items:
                root_items = list(self.project.compositions)
            for comp in sorted(root_items, key=lambda item: (item.name.casefold(), item.id)):
                self._insert_tree_node("", comp, (), seen, reference=False)
        visible = sum(1 for item in self.project.compositions if self._is_visible_match(item))
        self.visible_count_var.set("当前显示 " + str(visible) + " 个合成 · 点击名称查看详情，勾选框加入提取队列")
        self.selection_count_var.set(f"已选 {len(self.checked_ids)}")
        self._refresh_filter_buttons()
        if self.active_comp_id is not None:
            for iid, comp_id in self.tree_nodes.items():
                if comp_id == self.active_comp_id:
                    self.tree.selection_set(iid)
                    self.tree.focus(iid)
                    break

    def _insert_tree_node(self, parent_iid: str, comp: CompositionInfo, path: tuple[int, ...], seen: set[int], reference: bool) -> None:
        if not self._is_visible_match(comp) and not self._has_visible_descendant(comp.id):
            return
        path_ids = path + (comp.id,)
        iid = "node-" + "-".join(str(item) for item in path_ids)
        is_reference = reference or comp.id in seen
        seen.add(comp.id)
        is_open = comp.id in self.expanded_ids and not is_reference
        icon_key = "shared" if is_reference else "temp" if "测试" in comp.name or "临时" in comp.name else "root" if not comp.parent_ids else "base"
        self.tree.insert(parent_iid, tk.END, iid=iid, image=self.tree_icons[icon_key], text=self._tree_text(comp, is_reference), values=(f"{comp.width}×{comp.height}", f"{comp.duration:.2f}s", self._node_status(comp, is_reference)), open=is_open, tags=self._node_tags(comp, is_reference))
        self.tree_nodes[iid] = comp.id
        if is_reference or not is_open:
            return
        next_path = set(path_ids)
        for child_id in comp.child_ids:
            child = self.comp_by_id.get(child_id)
            if child is None:
                continue
            if child_id in next_path:
                self._insert_tree_node(iid, child, path_ids, seen, reference=True)
            else:
                self._insert_tree_node(iid, child, path_ids, seen, reference=False)

    def set_filter(self, filter_mode: str) -> None:
        self.filter_mode = filter_mode
        self.render_tree()
        self.status_var.set(f"已筛选：{dict(all='全部合成', candidate='推荐交付', root='顶层合成', child='直属预合成', warning='有警告').get(filter_mode, '全部合成')}")

    def _refresh_filter_buttons(self) -> None:
        if self.project is None:
            return
        counts = {
            "all": len(self.project.compositions),
            "candidate": sum(1 for item in self.project.compositions if self._is_package_candidate(item)),
            "root": sum(1 for item in self.project.compositions if not item.parent_ids),
            "child": sum(1 for item in self.project.compositions if item.parent_ids),
            "warning": sum(1 for item in self.project.compositions if self._has_review_signal(item)),
        }
        labels = {"all": "全部合成", "candidate": "推荐交付", "root": "顶层合成", "child": "直属预合成", "warning": "有警告"}
        for key, button in self.filter_buttons.items():
            selected = key == self.filter_mode
            row_bg = self.COLORS["blue_soft"] if selected else self.COLORS["panel"]
            button.configure(bg=row_bg, fg=self.COLORS["blue_deep"] if selected else self.COLORS["ink_soft"], font=("Microsoft YaHei UI", 9, "bold" if selected else "normal"))
            self.filter_rows[key].configure(bg=row_bg)
            self.filter_count_labels[key].configure(bg=row_bg, fg=self.COLORS["blue"] if selected else self.COLORS["ink_faint"], text=str(counts[key]))

    def set_tree_mode(self, mode: str) -> None:
        self.tree_mode = mode
        self.structure_mode_button.configure(bg=self.COLORS["panel_strong"] if mode == "structure" else self.COLORS["panel"], fg=self.COLORS["ink"] if mode == "structure" else self.COLORS["ink_faint"], font=("Microsoft YaHei UI", 9, "bold" if mode == "structure" else "normal"))
        self.list_mode_button.configure(bg=self.COLORS["panel_strong"] if mode == "list" else self.COLORS["panel"], fg=self.COLORS["ink"] if mode == "list" else self.COLORS["ink_faint"], font=("Microsoft YaHei UI", 9, "bold" if mode == "list" else "normal"))
        self.render_tree()

    def expand_all(self) -> None:
        if self.project is None:
            return
        self.expanded_ids.update(item.id for item in self.project.compositions if item.child_ids)
        self.render_tree()
        self.status_var.set("已展开全部可浏览合成")

    def collapse_all(self) -> None:
        self.expanded_ids.clear()
        self.render_tree()
        self.status_var.set("已收起全部合成")

    def expand_candidates(self) -> None:
        if self.project is None:
            return
        for comp in self.project.compositions:
            if self._is_package_candidate(comp):
                self.expanded_ids.add(comp.id)
                self.expanded_ids.update(comp.parent_ids)
        self.render_tree()
        self.status_var.set("已展开可能交付合成的上下文")

    def _clear_search_placeholder(self, widget: tk.Entry) -> None:
        if widget.get() == "搜索合成名称、类型或尺寸…":
            widget.delete(0, tk.END)
            widget.configure(fg=self.COLORS["ink"])

    def _restore_search_placeholder(self, widget: tk.Entry) -> None:
        if not widget.get().strip():
            widget.insert(0, "搜索合成名称、类型或尺寸…")
            widget.configure(fg=self.COLORS["ink_faint"])

    def _search_changed(self) -> None:
        self.render_tree()

    def _on_tree_open(self, _event=None) -> None:
        iid = self.tree.focus()
        comp_id = self.tree_nodes.get(iid)
        if comp_id is not None:
            self.expanded_ids.add(comp_id)

    def _on_tree_close(self, _event=None) -> None:
        iid = self.tree.focus()
        comp_id = self.tree_nodes.get(iid)
        if comp_id is not None:
            self.expanded_ids.discard(comp_id)

    def _on_tree_select(self, _event=None) -> None:
        selected = self.tree.selection()
        if not selected:
            return
        self.active_comp_id = self.tree_nodes.get(selected[0])
        self._render_inspector()
        self._update_action_states()

    def _on_tree_click(self, event: tk.Event) -> str | None:
        iid = self.tree.identify_row(event.y)
        if not iid:
            return None
        bbox = self.tree.bbox(iid, "#0")
        if not bbox:
            return None
        self.tree.selection_set(iid)
        self.tree.focus(iid)
        self.active_comp_id = self.tree_nodes.get(iid)
        try:
            element = self.tree.identify_element(event.x, event.y)
        except tk.TclError:
            element = ""
        if element == "Treeitem.indicator" or event.x <= bbox[0] + 18:
            return None
        if event.x <= bbox[0] + 50:
            self._toggle_checked(self.active_comp_id)
            return "break"
        return None

    def _on_tree_space(self, _event=None) -> str:
        iid = self.tree.focus() or (self.tree.selection()[0] if self.tree.selection() else "")
        self._toggle_checked(self.tree_nodes.get(iid))
        return "break"

    def _select_visible(self, _event=None) -> str:
        if self.project is not None:
            self.checked_ids.update(item.id for item in self.project.compositions if self._is_visible_match(item))
            self.render_tree()
            self.render_selection()
            self._update_action_states()
        return "break"

    def _clear_selection_event(self, _event=None) -> str:
        self.clear_selection()
        return "break"

    def _preview_focused_event(self, _event=None) -> str:
        self.preview_selected()
        return "break"

    def _toggle_checked(self, comp_id: int | None) -> None:
        if comp_id is None:
            return
        if comp_id in self.checked_ids:
            self.checked_ids.remove(comp_id)
        else:
            self.checked_ids.add(comp_id)
        self.render_tree()
        self.render_selection()
        self._update_action_states()

    def clear_selection(self) -> None:
        self.checked_ids.clear()
        self.render_tree()
        self.render_selection()
        self._update_action_states()

    def render_selection(self) -> None:
        selected = self._selected_compositions()
        self.selection_title_var.set(f"已选择 {len(selected)} 个交付对象" if selected else "还没有选择交付对象")
        self.selection_subtitle_var.set("子合成会随父级递归收集，不会自动生成独立 ZIP" if selected else "从结构树勾选需要独立提取的合成")
        for child in self.selection_chip_frame.winfo_children():
            child.destroy()
        for comp in selected[:7]:
            ttk.Label(self.selection_chip_frame, text=comp.name, style="Chip.TLabel").pack(side=tk.LEFT, padx=3, pady=2)
        if len(selected) > 7:
            ttk.Label(self.selection_chip_frame, text=f"+{len(selected) - 7} 项", style="Chip.TLabel").pack(side=tk.LEFT, padx=3, pady=2)
        self.selection_count_var.set(f"已选 {len(selected)}")
        if "queue" in self._workspace_tab_pills:
            self._workspace_tab_pills["queue"].configure(text=str(len(selected)))

    def _focused_composition(self) -> CompositionInfo | None:
        if self.project is None:
            return None
        if self.active_comp_id in self.comp_by_id:
            return self.comp_by_id[self.active_comp_id]
        selected = self._selected_compositions()
        return selected[0] if len(selected) == 1 else None

    def _selected_compositions(self) -> list[CompositionInfo]:
        if self.project is None:
            return []
        return [item for item in self.project.compositions if item.id in self.checked_ids]

    def _render_inspector(self) -> None:
        if not hasattr(self, "inspector"):
            return
        for child in self.inspector.winfo_children():
            child.destroy()
        comp = self._focused_composition()
        if comp is None:
            tk.Label(self.inspector, text="选择一个合成查看详情", bg=self.COLORS["panel"], fg=self.COLORS["ink_faint"], font=("Microsoft YaHei UI", 10)).pack(expand=True)
            return
        header = tk.Frame(self.inspector, bg=self.COLORS["panel"])
        header.pack(fill=tk.X)
        header_copy = tk.Frame(header, bg=self.COLORS["panel"])
        header_copy.pack(side=tk.LEFT, fill=tk.X, expand=True)
        tk.Label(header_copy, text=comp.name, bg=self.COLORS["panel"], fg=self.COLORS["ink"], font=("Microsoft YaHei UI", 14, "bold"), anchor="w").pack(fill=tk.X)
        tk.Label(header_copy, text=f"{self._node_role(comp)} · ID {comp.id}", bg=self.COLORS["panel"], fg=self.COLORS["ink_faint"], font=("Cascadia Code", 8), anchor="w").pack(fill=tk.X, pady=(3, 0))
        status = self._node_status(comp, len(comp.parent_ids) > 1)
        status_color = self.COLORS["purple"] if status == "共享引用" else self.COLORS["blue"] if status == "可能交付" else self.COLORS["amber"] if status == "含直属预合成" else self.COLORS["green"]
        tk.Label(header, text=status, bg=self.COLORS["blue_soft"] if status == "可能交付" else self.COLORS["panel_muted"], fg=status_color, padx=7, pady=4, font=("Microsoft YaHei UI", 8, "bold")).pack(side=tk.RIGHT, anchor="n")

        preview = tk.Canvas(self.inspector, height=174, bg="#d8d5cf", highlightbackground=self.COLORS["line_strong"], highlightthickness=1, bd=0)
        preview.pack(fill=tk.X, pady=(14, 0))
        preview_file = self.preview_files.get(comp.id)
        if preview_file and preview_file.is_file():
            try:
                image = Image.open(preview_file).convert("RGBA")
                image.thumbnail((310, 174), Image.Resampling.LANCZOS)
                self.inspector_photo = ImageTk.PhotoImage(image)
                preview.create_image(155, 87, image=self.inspector_photo, anchor=tk.CENTER)
                preview.create_text(10, 10, text="CONFIRMED PREVIEW", anchor="nw", fill="#34403c", font=("Cascadia Code", 8))
            except Exception:
                self._draw_preview_placeholder(preview, comp)
        else:
            self._draw_preview_placeholder(preview, comp)
        source = self.comp_by_id.get(self.preview_source_ids.get(comp.id, comp.id), comp)
        caption = tk.Frame(self.inspector, bg=self.COLORS["panel"])
        caption.pack(fill=tk.X, pady=(6, 0))
        caption_copy = tk.Frame(caption, bg=self.COLORS["panel"])
        caption_copy.pack(side=tk.LEFT, fill=tk.X, expand=True)
        tk.Label(caption_copy, text="代表帧预览", bg=self.COLORS["panel"], fg=self.COLORS["ink_soft"], font=("Microsoft YaHei UI", 9, "bold"), anchor="w").pack(anchor="w")
        tk.Label(caption_copy, text=f"来源：{source.name} · {self.preview_times.get(comp.id, 0):.3f}s", bg=self.COLORS["panel"], fg=self.COLORS["ink_faint"], font=("Cascadia Code", 8), anchor="w").pack(anchor="w", pady=(2, 0))
        preview_link = tk.Button(caption, text="预览 / 调整帧", command=self.preview_selected, relief="flat", bd=0, bg=self.COLORS["panel"], fg=self.COLORS["blue"], activebackground=self.COLORS["panel"], activeforeground=self.COLORS["blue_deep"], font=("Microsoft YaHei UI", 9), cursor="hand2")
        preview_link.pack(side=tk.RIGHT, anchor="n")

        self._inspector_section(self.inspector, "合成信息", (("尺寸", f"{comp.width}×{comp.height}"), ("时长", f"{comp.duration:.2f}s"), ("帧率", f"{comp.frame_rate:g} fps"), ("独立提取", "建议" if self._is_package_candidate(comp) else "按需")))
        parents = tuple((name, "父级使用") for name in comp.parent_names) or (("未被其他合成使用", "顶层"),)
        children = tuple((name, f"{self.comp_by_id[child_id].width}×{self.comp_by_id[child_id].height}") for child_id, name in zip(comp.child_ids, comp.child_names) if child_id in self.comp_by_id) or (("没有直属预合成", "—"),)
        self._inspector_section(self.inspector, "父级使用位置", parents)
        self._inspector_section(self.inspector, f"直属预合成 · {len(comp.child_ids)} 个", children)
        warning_title, warning_detail, warning_color = self._inspector_warning(comp)
        warning_box = tk.Frame(self.inspector, bg=warning_color, padx=9, pady=9)
        warning_box.pack(fill=tk.X, pady=(16, 0))
        tk.Label(warning_box, text="✓" if warning_color == self.COLORS["green_soft"] else "!", bg=warning_color, fg=self.COLORS["green"] if warning_color == self.COLORS["green_soft"] else self.COLORS["amber"], font=("Arial", 10, "bold")).pack(side=tk.LEFT, anchor="n")
        warning_copy = tk.Frame(warning_box, bg=warning_color)
        warning_copy.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(8, 0))
        tk.Label(warning_copy, text=warning_title, bg=warning_color, fg=self.COLORS["ink"], font=("Microsoft YaHei UI", 9, "bold"), anchor="w").pack(fill=tk.X)
        tk.Label(warning_copy, text=warning_detail, bg=warning_color, fg=self.COLORS["ink_soft"], justify=tk.LEFT, wraplength=250, font=("Microsoft YaHei UI", 9), anchor="w").pack(fill=tk.X, pady=(2, 0))

        action_frame = tk.Frame(self.inspector, bg=self.COLORS["panel"])
        action_frame.pack(fill=tk.X, pady=(14, 0))
        self.precomp_button = ttk.Button(action_frame, text="加入提取队列", command=lambda: self._toggle_checked(self.active_comp_id), style="Quiet.TButton")
        self.precomp_button.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 6))
        self.preview_button = ttk.Button(action_frame, text="预览当前合成", command=self.preview_selected, style="Primary.TButton")
        self.preview_button.pack(side=tk.LEFT, fill=tk.X, expand=True)
        self.children_button = ttk.Button(self.inspector, text="查看直属预合成", command=self.show_precompositions, style="Quiet.TButton")
        self.children_button.pack(fill=tk.X, pady=(7, 0))
        self.export_precomp_button = ttk.Button(self.inspector, text="分别导出直属预合成", command=self.export_precompositions, style="Quiet.TButton")
        self.export_precomp_button.pack(fill=tk.X, pady=(7, 0))
        self._update_action_states()

    def _inspector_warning(self, comp: CompositionInfo) -> tuple[str, str, str]:
        if "测试" in comp.name or "临时" in comp.name:
            return "阻止收集", "检测到测试或临时合成，请先确认依赖素材再决定是否提取。", self.COLORS["red_soft"]
        if self._has_review_signal(comp):
            return "需要复核", "当前合成的使用关系或预览来源需要在 AE 中人工确认。", self.COLORS["amber_soft"]
        return "依赖完整", "未发现当前结构中的阻止性问题。", self.COLORS["green_soft"]

    def _draw_preview_placeholder(self, canvas: tk.Canvas, comp: CompositionInfo) -> None:
        canvas.create_rectangle(25, 30, 285, 145, outline="#818a84", width=1)
        canvas.create_rectangle(82, 52, 228, 123, outline="#9aa39d", width=1)
        canvas.create_text(10, 10, text=f"PREVIEW PLACEHOLDER · {comp.width}×{comp.height}", anchor="nw", fill="#34403c", font=("Cascadia Code", 8))
        canvas.create_text(155, 87, text="尚未生成预览\n点击“预览 / 调整帧”", fill="#5e6963", font=("Microsoft YaHei UI", 9), justify=tk.CENTER)
        canvas.create_text(10, 158, text=f"默认 {self.preview_times.get(comp.id, 0):.3f}s · 帧 {self.preview_frames.get(comp.id, 0)}", anchor="sw", fill="#5e6963", font=("Cascadia Code", 8))

    def _inspector_section(self, parent: tk.Frame, title: str, rows: tuple[tuple[str, str], ...]) -> None:
        section = tk.Frame(parent, bg=self.COLORS["panel"])
        section.pack(fill=tk.X, pady=(16, 0))
        tk.Label(section, text=title.upper(), bg=self.COLORS["panel"], fg=self.COLORS["ink_faint"], font=("Microsoft YaHei UI", 8, "bold"), anchor="w").pack(fill=tk.X, pady=(0, 7))
        for label, value in rows:
            row = tk.Frame(section, bg=self.COLORS["panel"])
            row.pack(fill=tk.X, pady=2)
            tk.Label(row, text=label, bg=self.COLORS["panel"], fg=self.COLORS["ink_faint"], font=("Microsoft YaHei UI", 8), anchor="w").pack(side=tk.LEFT)
            tk.Label(row, text=value, bg=self.COLORS["panel"], fg=self.COLORS["ink_soft"], font=("Microsoft YaHei UI", 8), anchor="e", justify=tk.RIGHT, wraplength=190).pack(side=tk.RIGHT, fill=tk.X, expand=True)

    def preview_selected(self) -> None:
        comp = self._focused_composition()
        if comp is None or self.project is None:
            messagebox.showinfo("请选择一个合成", "请先在结构树中选择一个合成。")
            return
        source_id = self.preview_source_ids.get(comp.id, comp.id)
        cache_file = self.preview_cache_root / f"comp-{comp.id}-working.png"
        confirmed_file = self.preview_cache_root / f"comp-{comp.id}-confirmed.png"
        previous = self.preview_files.get(comp.id)
        if previous and previous.is_file():
            shutil.copy2(previous, cache_file)
        else:
            cache_file.unlink(missing_ok=True)

        def confirmed(source: CompositionInfo, time_value: float, frame_number: int, path: Path, renderer: str) -> None:
            shutil.copy2(path, confirmed_file)
            self.preview_times[comp.id] = time_value
            self.preview_frames[comp.id] = frame_number
            self.preview_source_ids[comp.id] = source.id
            self.preview_files[comp.id] = confirmed_file
            self.append_log(f"已选择“{comp.name}”预览：取景“{source.name}” {time_value:.3f} 秒（AE 帧号 {frame_number}，{renderer}）。")
            self._render_inspector()
            self.status_var.set(f"已保存“{comp.name}”代表帧")

        source_candidates = preview_source_candidates(self.project, comp)
        source_times = {candidate.id: preview_time_for_source(self.project, comp, candidate) for candidate in source_candidates}
        PreviewDialog(self.root, self.aep_var.get().strip(), comp, source_candidates, source_id, self.preview_times.get(comp.id, default_preview_time(comp.duration, comp.frame_rate)), cache_file, confirmed, source_times)

    def choose_output(self) -> None:
        path = filedialog.askdirectory(title="选择收集输出目录")
        if path:
            self.output_var.set(path)

    def _output_directory(self) -> str:
        output = self.output_var.get().strip()
        if not output:
            self.choose_output()
            output = self.output_var.get().strip()
        return output

    def show_precompositions(self) -> None:
        target = self._focused_composition()
        if target is None or self.project is None:
            messagebox.showinfo("请选择一个合成", "请先在结构树中选择一个合成。")
            return
        children = direct_precompositions(self.project, target)
        if not children:
            messagebox.showinfo("没有直属预合成", f"“{target.name}”没有直接作为图层源使用的预合成。")
            return
        PrecompositionDialog(self.root, target, children, lambda target=target, children=children: self._export_precomposition_items(target, children))

    def export_precompositions(self) -> None:
        target = self._focused_composition()
        if target is None or self.project is None:
            messagebox.showinfo("请选择一个合成", "请先在结构树中选择一个合成。")
            return
        children = list(direct_precompositions(self.project, target))
        if not children:
            messagebox.showinfo("没有直属预合成", f"“{target.name}”没有可分别导出的直属预合成。")
            return
        self._export_precomposition_items(target, children)

    def _export_precomposition_items(self, target: CompositionInfo, children: list[CompositionInfo] | tuple[CompositionInfo, ...]) -> None:
        output = self._output_directory()
        if not output:
            return
        names = "、".join(item.name for item in children)
        if not messagebox.askyesno("确认导出预合成", f"将把“{target.name}”的 {len(children)} 个直属预合成分别收集并打包：\n{names}\n\n每个预合成生成独立 AEP、素材目录、manifest、PNG 和 ZIP；不会导出上层包装合成，原 AEP 也不会被修改。继续吗？"):
            return
        self._start_collection(children, output, f"开始分别导出“{target.name}”的直属预合成：{names}", status_label="正在导出直属预合成…")

    def collect_selected(self) -> None:
        selected = self._selected_compositions()
        if not selected:
            messagebox.showinfo("请选择合成", "请在结构树中勾选至少一个独立交付对象。")
            return
        output = self._output_directory()
        if not output:
            return
        names = "、".join(item.name for item in selected)
        if not messagebox.askyesno("确认收集", f"将分别收集 {len(selected)} 个合成：\n{names}\n\n所有结果写入新目录，原 AEP 不会被修改。继续吗？"):
            return
        self._start_collection(selected, output, f"开始收集：{names}", status_label="正在收集所选合成…")

    def _prepare_queue(self, selected: list[CompositionInfo]) -> None:
        self.queue_tree.delete(*self.queue_tree.get_children())
        self.queue_status = {comp.id: "等待收集" for comp in selected}
        for comp in selected:
            self.queue_tree.insert("", tk.END, iid=str(comp.id), text=comp.name, values=(self._node_role(comp), "等待收集", "—"))
        if "queue" in self._workspace_tab_pills:
            self._workspace_tab_pills["queue"].configure(text=str(len(selected)))
        self._select_workspace("queue")

    def _set_queue_status(self, comp_id: int, status: str, result: str = "—") -> None:
        self.queue_status[comp_id] = status
        if not self.queue_tree.exists(str(comp_id)):
            return
        tag = "working" if "正在" in status else "done" if status.startswith("已完成") else "warning" if "警告" in status or "失败" in status else "blocked" if "缺失" in status else ()
        self.queue_tree.item(str(comp_id), values=(self._node_role(self.comp_by_id[comp_id]), status, result), tags=(tag,) if tag else ())

    def _start_collection(self, selected: list[CompositionInfo], output: str, log_label: str, status_label: str) -> None:
        self.set_busy(True, status_label)
        self.append_log(log_label)
        self._prepare_queue(selected)
        aep = self.aep_var.get().strip()
        project = self.project
        if project is None:
            self.set_busy(False, "尚未解析工程")
            return

        def worker() -> None:
            try:
                results: list[CollectionResult] = []
                by_id = {item.id: item for item in project.compositions}
                for index, comp in enumerate(selected, start=1):
                    self.root.after(0, lambda index=index, comp=comp: (self.status_var.set(f"正在导出 {index}/{len(selected)}：{comp.name}"), self._set_queue_status(comp.id, "正在收集", "生成独立 AEP 与 ZIP")))
                    result = collect_composition(aep, comp.id, output)
                    preview_target = Path(result.zip_file).with_suffix(".png")
                    try:
                        source = by_id.get(self.preview_source_ids.get(comp.id, comp.id), comp)
                        source_layer = preview_source_layer_usage(project, comp, source)
                        self.root.after(0, lambda comp=comp, source=source: (self.status_var.set(f"正在高质量渲染“{comp.name}”预览（取景：{source.name}）…"), self._set_queue_status(comp.id, "正在生成预览", "PNG + ZIP + manifest")))
                        rendered = render_preview(aep, source.name, source.duration, source.frame_rate, self.preview_times.get(comp.id, default_preview_time(comp.duration, comp.frame_rate)), preview_target, display_start_frame=source.display_start_frame)
                        result = attach_collection_preview(result, preview_target, rendered.time, rendered.frame_number, preview_source_id=source.id, preview_source_name=source.name, preview_source_relation=("self" if source.id == comp.id else "parent-display"), preview_renderer=rendered.renderer, preview_source_layer=source_layer)
                    except Exception as preview_error:
                        preview_target.unlink(missing_ok=True)
                        result = mark_collection_preview_error(result, preview_error)
                    results.append(result)
                    self.root.after(0, lambda result=result: self._set_queue_status(result.composition_id, "已完成 · 有警告" if result.warnings else "已完成", str(result.output_directory)))
                self.root.after(0, lambda: self._collection_done(results))
            except Exception as exc:
                self.root.after(0, lambda exc=exc: self._show_error("收集失败", exc))

        threading.Thread(target=worker, daemon=True).start()

    def _collection_done(self, results) -> None:
        blocked = 0
        previews = 0
        for result in results:
            status = "有缺失素材" if result.missing_files else ("有警告" if result.warnings else "完整")
            if result.missing_files:
                blocked += 1
            if result.preview_file:
                previews += 1
            queue_status = "已完成 · 缺失素材" if result.missing_files else "已完成 · 预览待补" if not result.preview_file else "已完成"
            self.root.after(0, lambda result=result, queue_status=queue_status: self._set_queue_status(result.composition_id, queue_status, str(result.output_directory)))
            self.append_log(f"完成“{result.composition_name}”：{result.composition_count} 个合成，{result.copied_file_count} 个素材，状态 {status}。\n  展开目录：{result.output_directory}\n  Eagle ZIP：{result.zip_file}（{result.zip_bytes / 1024 / 1024:.2f} MB）" + (f"\n  预览 PNG：{result.preview_file}（取景：{result.preview_source_name}，{result.preview_time:.3f} 秒）" if result.preview_file else f"\n  预览生成失败：{result.preview_error}"))
        self.set_busy(False, "收集完成")
        messagebox.showinfo("收集完成", f"已生成 {len(results)} 个独立收集目录、{len(results)} 个 ZIP 和 {previews} 张预览 PNG。" + (f"\n其中 {blocked} 项存在缺失素材，已在 manifest 中标记为阻止入库。" if blocked else "") + (f"\n有 {len(results) - previews} 项预览失败，ZIP 仍保留，但 Eagle 会等待补齐 PNG。" if previews < len(results) else "\nPNG 与 ZIP 已写入收集 manifest，可直接交给 Eagle 导入。"))

    def _show_error(self, title: str, error: Exception) -> None:
        message = str(error)
        self.append_log(f"{title}：{message}")
        self.set_busy(False, title)
        messagebox.showerror(title, message)

    def open_output(self) -> None:
        path = Path(self.output_var.get().strip())
        if not path.exists():
            messagebox.showinfo("目录不存在", "目录尚未创建。完成一次收集后，这里会显示结果目录。")
            return
        os.startfile(str(path))

    def close(self) -> None:
        shutil.rmtree(self.preview_cache_root, ignore_errors=True)
        self.root.destroy()


def launch() -> None:
    root = tk.Tk()
    try:
        ttk.Style(root).theme_use("vista")
    except tk.TclError:
        pass
    CollectorWindow(root)
    root.mainloop()
