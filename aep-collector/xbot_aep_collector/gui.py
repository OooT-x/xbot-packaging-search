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
    inspect_project,
    mark_collection_preview_error,
)
from .preview import PreviewError, default_preview_time, render_preview, select_preview_frame


class PreviewDialog:
    def __init__(
        self,
        parent: tk.Tk,
        aep_path: str,
        composition: CompositionInfo,
        initial_time: float,
        cache_file: Path,
        on_confirm,
    ) -> None:
        self.parent = parent
        self.aep_path = aep_path
        self.composition = composition
        self.cache_file = cache_file
        self.on_confirm = on_confirm
        self.busy = False
        self.photo: ImageTk.PhotoImage | None = None
        self.rendered_frame_index: int | None = None

        selection = select_preview_frame(
            composition.duration,
            composition.frame_rate,
            requested_time=initial_time,
            display_start_frame=composition.display_start_frame,
        )
        self.window = tk.Toplevel(parent)
        self.window.title(f"预览 / 调整帧 · {composition.name}")
        self.window.geometry("980x760")
        self.window.minsize(760, 620)
        self.window.transient(parent)
        self.window.protocol("WM_DELETE_WINDOW", self.window.destroy)

        self.time_var = tk.StringVar(value=f"{selection.time:.3f}")
        self.frame_var = tk.DoubleVar(value=selection.frame_index)
        self.frame_label_var = tk.StringVar()
        self.status_var = tk.StringVar(value="默认选择第 2 秒的帧。")

        self._build_ui()
        self._sync_frame_label(selection.frame_index)
        if cache_file.is_file():
            self._show_image(cache_file)
            self.rendered_frame_index = selection.frame_index
            self.confirm_button.configure(state=tk.NORMAL)
            self.status_var.set(f"已生成 {selection.time:.3f} 秒预览，可继续调整。")
        else:
            self.window.after(100, self.render_from_time)

    def _build_ui(self) -> None:
        outer = ttk.Frame(self.window, padding=12)
        outer.pack(fill=tk.BOTH, expand=True)

        title = ttk.Label(
            outer,
            text=(
                f"{self.composition.name}  ·  {self.composition.width}×{self.composition.height}  ·  "
                f"{self.composition.duration:.2f}s  ·  {self.composition.frame_rate:g} fps"
            ),
        )
        title.pack(fill=tk.X)

        preview_frame = ttk.Frame(outer, relief=tk.SUNKEN, borderwidth=1)
        preview_frame.pack(fill=tk.BOTH, expand=True, pady=(10, 10))
        self.image_label = ttk.Label(preview_frame, text="正在生成预览…", anchor=tk.CENTER)
        self.image_label.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)

        controls = ttk.LabelFrame(outer, text="预览帧", padding=10)
        controls.pack(fill=tk.X)
        controls.columnconfigure(1, weight=1)

        ttk.Label(controls, text="时间（秒）").grid(row=0, column=0, sticky="w")
        self.time_entry = ttk.Entry(controls, textvariable=self.time_var, width=12)
        self.time_entry.grid(row=0, column=1, sticky="w", padx=(8, 8))
        self.time_entry.bind("<Return>", lambda _event: self.render_from_time())
        ttk.Button(controls, text="上一帧", command=lambda: self.step_frame(-1)).grid(row=0, column=2)
        ttk.Button(controls, text="下一帧", command=lambda: self.step_frame(1)).grid(row=0, column=3, padx=(8, 0))
        self.render_button = ttk.Button(controls, text="刷新预览", command=self.render_from_time)
        self.render_button.grid(row=0, column=4, padx=(8, 0))

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
        self.scale.grid(row=1, column=0, columnspan=5, sticky="ew", pady=(12, 4))
        self.scale.bind("<ButtonRelease-1>", lambda _event: self.render_from_slider())
        ttk.Label(controls, textvariable=self.frame_label_var).grid(row=2, column=0, columnspan=5, sticky="w")

        footer = ttk.Frame(outer)
        footer.pack(fill=tk.X, pady=(10, 0))
        ttk.Label(footer, textvariable=self.status_var).pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(footer, text="取消", command=self.window.destroy).pack(side=tk.RIGHT)
        self.confirm_button = ttk.Button(footer, text="使用当前帧", command=self.confirm)
        self.confirm_button.pack(side=tk.RIGHT, padx=(0, 8))
        self.confirm_button.configure(state=tk.DISABLED)

    def _scale_changed(self, value: str) -> None:
        frame_index = int(round(float(value)))
        self._sync_frame_label(frame_index)
        self.time_var.set(f"{frame_index / self.composition.frame_rate:.3f}")
        if not self.busy:
            self.confirm_button.configure(
                state=tk.NORMAL if frame_index == self.rendered_frame_index else tk.DISABLED
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
        self.busy = True
        self.render_button.configure(state=tk.DISABLED)
        self.confirm_button.configure(state=tk.DISABLED)
        self.status_var.set(
            f"正在后台生成 {selection.time:.3f} 秒（AE 帧号 {selection.frame_number}）…"
        )

        def worker() -> None:
            try:
                result = render_preview(
                    self.aep_path,
                    self.composition.name,
                    self.composition.duration,
                    self.composition.frame_rate,
                    selection.time,
                    self.cache_file,
                    display_start_frame=self.composition.display_start_frame,
                )
                self.window.after(0, lambda: self._render_done(result))
            except Exception as exc:
                self.window.after(0, lambda exc=exc: self._render_failed(exc))

        threading.Thread(target=worker, daemon=True).start()

    def _render_done(self, result) -> None:
        if not self.window.winfo_exists():
            return
        self.busy = False
        self.render_button.configure(state=tk.NORMAL)
        self.confirm_button.configure(state=tk.NORMAL)
        self.rendered_frame_index = result.frame_index
        self.time_var.set(f"{result.time:.3f}")
        self.frame_var.set(result.frame_index)
        self._sync_frame_label(result.frame_index)
        self._show_image(Path(result.output_file))
        self.status_var.set(f"已生成 {result.time:.3f} 秒预览，可继续调整或直接确认。")

    def _render_failed(self, error: Exception) -> None:
        if not self.window.winfo_exists():
            return
        self.busy = False
        self.render_button.configure(state=tk.NORMAL)
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
        self.on_confirm(selection.time, selection.frame_number, self.cache_file)
        self.window.destroy()


class CollectorWindow:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("X.bot AEP 收集工具")
        self.root.geometry("1180x760")
        self.root.minsize(920, 620)

        self.project: ProjectInfo | None = None
        self.aep_var = tk.StringVar()
        self.output_var = tk.StringVar()
        self.summary_var = tk.StringVar(value="打开 AEP 后会在这里显示全部合成。")
        self.status_var = tk.StringVar(value="就绪")
        self.preview_times: dict[int, float] = {}
        self.preview_frames: dict[int, int] = {}
        self.preview_files: dict[int, Path] = {}
        self.preview_cache_root = Path(tempfile.mkdtemp(prefix="xbot-aep-preview-session-"))
        self.root.protocol("WM_DELETE_WINDOW", self.close)

        self._build_ui()
        self._update_action_states()

    def _build_ui(self) -> None:
        outer = ttk.Frame(self.root, padding=12)
        outer.pack(fill=tk.BOTH, expand=True)

        file_frame = ttk.LabelFrame(outer, text="AE 工程", padding=10)
        file_frame.pack(fill=tk.X)
        file_frame.columnconfigure(0, weight=1)
        ttk.Entry(file_frame, textvariable=self.aep_var).grid(row=0, column=0, sticky="ew", padx=(0, 8))
        ttk.Button(file_frame, text="打开 AEP", command=self.choose_aep).grid(row=0, column=1)
        ttk.Button(file_frame, text="重新解析", command=self.load_aep).grid(row=0, column=2, padx=(8, 0))
        ttk.Label(file_frame, textvariable=self.summary_var).grid(row=1, column=0, columnspan=3, sticky="w", pady=(8, 0))

        comps_frame = ttk.LabelFrame(outer, text="工程内全部合成（可多选）", padding=8)
        comps_frame.pack(fill=tk.BOTH, expand=True, pady=10)
        comps_frame.rowconfigure(0, weight=1)
        comps_frame.columnconfigure(0, weight=1)

        columns = ("role", "size", "duration", "fps", "preview", "parents", "children")
        self.tree = ttk.Treeview(comps_frame, columns=columns, show="tree headings", selectmode="extended")
        self.tree.heading("#0", text="合成名称")
        self.tree.heading("role", text="关系")
        self.tree.heading("size", text="尺寸")
        self.tree.heading("duration", text="时长")
        self.tree.heading("fps", text="帧率")
        self.tree.heading("preview", text="预览帧")
        self.tree.heading("parents", text="被哪些合成使用")
        self.tree.heading("children", text="内部预合成")
        self.tree.column("#0", width=230, minwidth=160)
        self.tree.column("role", width=105, anchor=tk.CENTER)
        self.tree.column("size", width=105, anchor=tk.CENTER)
        self.tree.column("duration", width=80, anchor=tk.E)
        self.tree.column("fps", width=70, anchor=tk.E)
        self.tree.column("preview", width=90, anchor=tk.E)
        self.tree.column("parents", width=210)
        self.tree.column("children", width=270)
        scroll_y = ttk.Scrollbar(comps_frame, orient=tk.VERTICAL, command=self.tree.yview)
        scroll_x = ttk.Scrollbar(comps_frame, orient=tk.HORIZONTAL, command=self.tree.xview)
        self.tree.configure(yscrollcommand=scroll_y.set, xscrollcommand=scroll_x.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        self.tree.bind("<<TreeviewSelect>>", lambda _event: self._update_action_states())
        scroll_y.grid(row=0, column=1, sticky="ns")
        scroll_x.grid(row=1, column=0, sticky="ew")

        output_frame = ttk.LabelFrame(outer, text="安全收集并打包 ZIP", padding=10)
        output_frame.pack(fill=tk.X)
        output_frame.columnconfigure(0, weight=1)
        ttk.Entry(output_frame, textvariable=self.output_var).grid(row=0, column=0, sticky="ew", padx=(0, 8))
        ttk.Button(output_frame, text="选择输出目录", command=self.choose_output).grid(row=0, column=1)
        self.preview_button = ttk.Button(output_frame, text="预览 / 调整帧", command=self.preview_selected)
        self.preview_button.grid(row=0, column=2, padx=(8, 0))
        self.collect_button = ttk.Button(output_frame, text="收集所选合成", command=self.collect_selected)
        self.collect_button.grid(row=0, column=3, padx=(8, 0))
        ttk.Button(output_frame, text="打开输出目录", command=self.open_output).grid(row=0, column=4, padx=(8, 0))
        ttk.Label(
            output_frame,
            text="每个合成生成独立 AEP、素材目录、manifest 和同名 ZIP；原工程不会被修改。",
        ).grid(row=1, column=0, columnspan=5, sticky="w", pady=(8, 0))

        log_frame = ttk.LabelFrame(outer, text="运行记录", padding=8)
        log_frame.pack(fill=tk.BOTH, pady=(10, 0))
        self.log = tk.Text(log_frame, height=7, wrap="word", state=tk.DISABLED)
        self.log.pack(fill=tk.BOTH, expand=True)
        ttk.Label(outer, textvariable=self.status_var, anchor="w").pack(fill=tk.X, pady=(6, 0))

    def append_log(self, text: str) -> None:
        self.log.configure(state=tk.NORMAL)
        self.log.insert(tk.END, text.rstrip() + "\n")
        self.log.see(tk.END)
        self.log.configure(state=tk.DISABLED)

    def set_busy(self, busy: bool, status: str) -> None:
        self.collect_button.configure(state=tk.DISABLED if busy else tk.NORMAL)
        self.preview_button.configure(state=tk.DISABLED if busy else tk.NORMAL)
        self.status_var.set(status)
        if not busy:
            self._update_action_states()

    def _update_action_states(self) -> None:
        selected_count = len(self.tree.selection())
        self.preview_button.configure(state=tk.NORMAL if selected_count == 1 else tk.DISABLED)
        self.collect_button.configure(state=tk.NORMAL if selected_count > 0 else tk.DISABLED)

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
        self.set_busy(True, "正在离线解析 AEP…")
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
        self.preview_times.clear()
        self.preview_frames.clear()
        self.preview_files.clear()
        self.tree.delete(*self.tree.get_children())
        for comp in project.compositions:
            preview_time = default_preview_time(comp.duration, comp.frame_rate)
            preview_selection = select_preview_frame(
                comp.duration,
                comp.frame_rate,
                preview_time,
                display_start_frame=comp.display_start_frame,
            )
            self.preview_times[comp.id] = preview_time
            self.preview_frames[comp.id] = preview_selection.frame_number
            self.tree.insert(
                "",
                tk.END,
                iid=str(comp.id),
                text=comp.name,
                values=(
                    comp.role,
                    f"{comp.width}×{comp.height}",
                    f"{comp.duration:.2f}s",
                    f"{comp.frame_rate:g}",
                    f"{preview_time:.3f}s",
                    "、".join(comp.parent_names) or "—",
                    "、".join(comp.child_names) or "—",
                ),
            )
        self.summary_var.set(
            f"AE {project.ae_version} · 项目项 {project.item_count} · 已显示全部 {len(project.compositions)} 个合成"
        )
        self.append_log(f"解析完成：识别 {len(project.compositions)} 个合成。")
        self.set_busy(False, "解析完成")

    def preview_selected(self) -> None:
        selected = self._selected_compositions()
        if len(selected) != 1:
            messagebox.showinfo("请选择一个合成", "预览调整时请只选择一个合成。")
            return
        comp = selected[0]
        cache_file = self.preview_cache_root / f"comp-{comp.id}-working.png"
        confirmed_file = self.preview_cache_root / f"comp-{comp.id}-confirmed.png"
        previous = self.preview_files.get(comp.id)
        if previous and previous.is_file():
            shutil.copy2(previous, cache_file)
        else:
            cache_file.unlink(missing_ok=True)

        def confirmed(time_value: float, frame_number: int, path: Path) -> None:
            shutil.copy2(path, confirmed_file)
            self.preview_times[comp.id] = time_value
            self.preview_frames[comp.id] = frame_number
            self.preview_files[comp.id] = confirmed_file
            self.tree.set(str(comp.id), "preview", f"{time_value:.3f}s")
            self.append_log(
                f"已选择“{comp.name}”预览：{time_value:.3f} 秒（AE 帧号 {frame_number}）。"
            )

        PreviewDialog(
            self.root,
            self.aep_var.get().strip(),
            comp,
            self.preview_times.get(comp.id, default_preview_time(comp.duration, comp.frame_rate)),
            cache_file,
            confirmed,
        )

    def choose_output(self) -> None:
        path = filedialog.askdirectory(title="选择收集输出目录")
        if path:
            self.output_var.set(path)

    def _selected_compositions(self) -> list[CompositionInfo]:
        if self.project is None:
            return []
        selected_ids = {int(item) for item in self.tree.selection()}
        return [item for item in self.project.compositions if item.id in selected_ids]

    def collect_selected(self) -> None:
        selected = self._selected_compositions()
        if not selected:
            messagebox.showinfo("请选择合成", "请在合成列表中选择至少一个合成。")
            return
        output = self.output_var.get().strip()
        if not output:
            self.choose_output()
            output = self.output_var.get().strip()
        if not output:
            return
        names = "、".join(item.name for item in selected)
        if not messagebox.askyesno(
            "确认收集",
            f"将分别收集 {len(selected)} 个合成：\n{names}\n\n所有结果写入新目录，原 AEP 不会被修改。继续吗？",
        ):
            return

        self.set_busy(True, "正在收集所选合成…")
        self.append_log(f"开始收集：{names}")
        aep = self.aep_var.get().strip()

        def worker() -> None:
            try:
                results: list[CollectionResult] = []
                for index, comp in enumerate(selected, start=1):
                    self.root.after(
                        0,
                        lambda index=index, comp=comp: self.status_var.set(
                            f"正在收集 {index}/{len(selected)}：{comp.name}"
                        ),
                    )
                    result = collect_composition(aep, comp.id, output)
                    preview_target = Path(result.zip_file).with_suffix(".png")
                    try:
                        cached = self.preview_files.get(comp.id)
                        if cached and cached.is_file():
                            shutil.copy2(cached, preview_target)
                            selection = select_preview_frame(
                                comp.duration,
                                comp.frame_rate,
                                self.preview_times[comp.id],
                                display_start_frame=comp.display_start_frame,
                            )
                            preview_time = selection.time
                            preview_frame = selection.frame_number
                        else:
                            self.root.after(
                                0,
                                lambda comp=comp: self.status_var.set(
                                    f"正在生成“{comp.name}”第 {self.preview_times[comp.id]:.3f} 秒预览…"
                                ),
                            )
                            rendered = render_preview(
                                result.output_project,
                                comp.name,
                                comp.duration,
                                comp.frame_rate,
                                self.preview_times[comp.id],
                                preview_target,
                                display_start_frame=comp.display_start_frame,
                            )
                            preview_time = rendered.time
                            preview_frame = rendered.frame_number
                        result = attach_collection_preview(
                            result,
                            preview_target,
                            preview_time,
                            preview_frame,
                        )
                    except Exception as preview_error:
                        preview_target.unlink(missing_ok=True)
                        result = mark_collection_preview_error(result, preview_error)
                    results.append(result)
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
            self.append_log(
                f"完成“{result.composition_name}”：{result.composition_count} 个合成，"
                f"{result.copied_file_count} 个素材，状态 {status}。"
                f"\n  展开目录：{result.output_directory}"
                f"\n  Eagle ZIP：{result.zip_file}（{result.zip_bytes / 1024 / 1024:.2f} MB）"
                + (
                    f"\n  预览 PNG：{result.preview_file}（{result.preview_time:.3f} 秒）"
                    if result.preview_file
                    else f"\n  预览生成失败：{result.preview_error}"
                )
            )
        self.set_busy(False, "收集完成")
        messagebox.showinfo(
            "收集完成",
            f"已生成 {len(results)} 个独立收集目录、{len(results)} 个 ZIP 和 {previews} 张预览 PNG。"
            + (f"\n其中 {blocked} 项存在缺失素材，已在 manifest 中标记为阻止入库。" if blocked else "")
            + (f"\n有 {len(results) - previews} 项预览失败，ZIP 仍保留，但 Eagle 会等待补齐 PNG。" if previews < len(results) else "\nPNG 与 ZIP 已写入收集 manifest，可直接交给 Eagle 导入。"),
        )

    def _show_error(self, title: str, error: Exception) -> None:
        message = str(error)
        self.append_log(f"{title}：{message}")
        self.set_busy(False, title)
        messagebox.showerror(title, message)

    def open_output(self) -> None:
        path = Path(self.output_var.get().strip())
        if not path.exists():
            messagebox.showinfo("目录不存在", "输出目录尚未创建。")
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
