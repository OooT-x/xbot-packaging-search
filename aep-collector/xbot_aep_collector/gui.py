from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

if getattr(sys, "frozen", False):
    bundle_root = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    os.environ.setdefault("TCL_LIBRARY", str(bundle_root / "_tcl_data"))
    os.environ.setdefault("TK_LIBRARY", str(bundle_root / "_tk_data"))

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from .core import CollectorError, CompositionInfo, ProjectInfo, collect_many, inspect_project


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

        self._build_ui()

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

        columns = ("role", "size", "duration", "fps", "parents", "children")
        self.tree = ttk.Treeview(comps_frame, columns=columns, show="tree headings", selectmode="extended")
        self.tree.heading("#0", text="合成名称")
        self.tree.heading("role", text="关系")
        self.tree.heading("size", text="尺寸")
        self.tree.heading("duration", text="时长")
        self.tree.heading("fps", text="帧率")
        self.tree.heading("parents", text="被哪些合成使用")
        self.tree.heading("children", text="内部预合成")
        self.tree.column("#0", width=230, minwidth=160)
        self.tree.column("role", width=105, anchor=tk.CENTER)
        self.tree.column("size", width=105, anchor=tk.CENTER)
        self.tree.column("duration", width=80, anchor=tk.E)
        self.tree.column("fps", width=70, anchor=tk.E)
        self.tree.column("parents", width=210)
        self.tree.column("children", width=270)
        scroll_y = ttk.Scrollbar(comps_frame, orient=tk.VERTICAL, command=self.tree.yview)
        scroll_x = ttk.Scrollbar(comps_frame, orient=tk.HORIZONTAL, command=self.tree.xview)
        self.tree.configure(yscrollcommand=scroll_y.set, xscrollcommand=scroll_x.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        scroll_y.grid(row=0, column=1, sticky="ns")
        scroll_x.grid(row=1, column=0, sticky="ew")

        output_frame = ttk.LabelFrame(outer, text="安全收集并打包 ZIP", padding=10)
        output_frame.pack(fill=tk.X)
        output_frame.columnconfigure(0, weight=1)
        ttk.Entry(output_frame, textvariable=self.output_var).grid(row=0, column=0, sticky="ew", padx=(0, 8))
        ttk.Button(output_frame, text="选择输出目录", command=self.choose_output).grid(row=0, column=1)
        self.collect_button = ttk.Button(output_frame, text="收集所选合成", command=self.collect_selected)
        self.collect_button.grid(row=0, column=2, padx=(8, 0))
        ttk.Button(output_frame, text="打开输出目录", command=self.open_output).grid(row=0, column=3, padx=(8, 0))
        ttk.Label(
            output_frame,
            text="每个合成生成独立 AEP、素材目录、manifest 和同名 ZIP；原工程不会被修改。",
        ).grid(row=1, column=0, columnspan=4, sticky="w", pady=(8, 0))

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
        self.status_var.set(status)

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
                self.root.after(0, lambda: self._show_error("解析失败", exc))

        threading.Thread(target=worker, daemon=True).start()

    def _show_project(self, project: ProjectInfo) -> None:
        self.project = project
        self.tree.delete(*self.tree.get_children())
        for comp in project.compositions:
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
                    "、".join(comp.parent_names) or "—",
                    "、".join(comp.child_names) or "—",
                ),
            )
        self.summary_var.set(
            f"AE {project.ae_version} · 项目项 {project.item_count} · 已显示全部 {len(project.compositions)} 个合成"
        )
        self.append_log(f"解析完成：识别 {len(project.compositions)} 个合成。")
        self.set_busy(False, "解析完成")

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
                results = collect_many(aep, [item.id for item in selected], output)
                self.root.after(0, lambda: self._collection_done(results))
            except Exception as exc:
                self.root.after(0, lambda: self._show_error("收集失败", exc))

        threading.Thread(target=worker, daemon=True).start()

    def _collection_done(self, results) -> None:
        blocked = 0
        for result in results:
            status = "有缺失素材" if result.missing_files else ("有警告" if result.warnings else "完整")
            if result.missing_files:
                blocked += 1
            self.append_log(
                f"完成“{result.composition_name}”：{result.composition_count} 个合成，"
                f"{result.copied_file_count} 个素材，状态 {status}。"
                f"\n  展开目录：{result.output_directory}"
                f"\n  Eagle ZIP：{result.zip_file}（{result.zip_bytes / 1024 / 1024:.2f} MB）"
            )
        self.set_busy(False, "收集完成")
        messagebox.showinfo(
            "收集完成",
            f"已生成 {len(results)} 个独立收集目录和 {len(results)} 个 ZIP，可交给 Eagle 入库。"
            + (f"\n其中 {blocked} 项存在缺失素材，已在 manifest 中标记为阻止入库。" if blocked else ""),
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


def launch() -> None:
    root = tk.Tk()
    try:
        ttk.Style(root).theme_use("vista")
    except tk.TclError:
        pass
    CollectorWindow(root)
    root.mainloop()
