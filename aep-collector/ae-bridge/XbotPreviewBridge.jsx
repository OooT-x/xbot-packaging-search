/*
 * X.bot AEP Collector - live preview bridge for After Effects.
 * Keeps AE warm and accepts one local saveFrameToPng request at a time.
 */
(function XbotPreviewBridge(thisObj) {
    var BRIDGE_VERSION = "1.0";
    var POLL_MS = 250;
    var STATUS_MS = 1000;

    if (!$._xbotAepPreviewBridge) {
        $._xbotAepPreviewBridge = {};
    }
    var bridge = $._xbotAepPreviewBridge;

    bridge.root = new Folder(Folder.userData.fullName + "/XbotAepPreviewBridge");
    if (!bridge.root.exists) {
        bridge.root.create();
    }
    bridge.requestFile = new File(bridge.root.fullName + "/request.json");
    bridge.responseFile = new File(bridge.root.fullName + "/response.json");
    bridge.statusFile = new File(bridge.root.fullName + "/status.json");
    bridge.lastRequestId = bridge.lastRequestId || "";
    bridge.lastStatusMs = 0;
    bridge.running = bridge.running === true;
    bridge.taskId = bridge.taskId || 0;

    bridge.writeJson = function (file, payload) {
        file.encoding = "UTF-8";
        if (!file.open("w")) {
            return false;
        }
        file.write(JSON.stringify(payload));
        file.close();
        return true;
    };

    bridge.readJson = function (file) {
        if (!file.exists) {
            return null;
        }
        file.encoding = "UTF-8";
        if (!file.open("r")) {
            return null;
        }
        var text = file.read();
        file.close();
        try {
            return JSON.parse(text);
        } catch (_error) {
            return null;
        }
    };

    bridge.projectPath = function () {
        if (!app.project || !app.project.file) {
            return "";
        }
        return app.project.file.fsName;
    };

    bridge.normalizedPath = function (value) {
        try {
            return new File(value).fsName.toLowerCase().replace(/\\/g, "/");
        } catch (_error) {
            return String(value || "").toLowerCase().replace(/\\/g, "/");
        }
    };

    bridge.findComposition = function (itemId, itemName) {
        var fallback = null;
        var nameMatches = 0;
        for (var index = 1; index <= app.project.numItems; index += 1) {
            var item = app.project.item(index);
            if (!(item instanceof CompItem)) {
                continue;
            }
            if (Number(item.id) === Number(itemId)) {
                return item;
            }
            if (String(item.name) === String(itemName)) {
                fallback = item;
                nameMatches += 1;
            }
        }
        return nameMatches === 1 ? fallback : null;
    };

    bridge.writeStatus = function (force) {
        var now = (new Date()).getTime();
        if (!force && now - bridge.lastStatusMs < STATUS_MS) {
            return;
        }
        bridge.lastStatusMs = now;
        bridge.writeJson(bridge.statusFile, {
            bridge_version: BRIDGE_VERSION,
            running: bridge.running,
            heartbeat_ms: now,
            project_path: bridge.projectPath(),
            after_effects_version: String(app.version || "")
        });
        if (bridge.statusLabel) {
            bridge.statusLabel.text = bridge.running
                ? (bridge.projectPath() ? "已连接：" + bridge.projectPath() : "已启动，请打开 AEP 工程")
                : "已停止";
        }
    };

    bridge.respond = function (requestId, ok, message) {
        bridge.writeJson(bridge.responseFile, {
            bridge_version: BRIDGE_VERSION,
            request_id: requestId,
            ok: ok,
            message: ok ? message : "",
            error: ok ? "" : message,
            responded_at_ms: (new Date()).getTime()
        });
    };

    bridge.processRequest = function () {
        var request = bridge.readJson(bridge.requestFile);
        if (!request || !request.request_id || request.request_id === bridge.lastRequestId) {
            return;
        }
        bridge.lastRequestId = request.request_id;
        if (String(request.bridge_version || "") !== BRIDGE_VERSION) {
            bridge.respond(request.request_id, false, "快速预览桥接版本不匹配");
            return;
        }
        var openProject = bridge.projectPath();
        if (!openProject) {
            bridge.respond(request.request_id, false, "AE 中没有打开工程");
            return;
        }
        if (bridge.normalizedPath(openProject) !== bridge.normalizedPath(request.project_path)) {
            bridge.respond(request.request_id, false, "AE 中打开的不是当前 AEP");
            return;
        }
        var composition = bridge.findComposition(request.composition_id, request.composition_name);
        if (!composition) {
            bridge.respond(request.request_id, false, "找不到请求的预览合成");
            return;
        }
        try {
            var output = new File(request.output_file);
            if (!output.parent.exists) {
                output.parent.create();
            }
            if (output.exists) {
                output.remove();
            }
            composition.saveFrameToPng(Number(request.time_seconds), output);
            bridge.respond(request.request_id, true, "AE 已生成快速预览");
        } catch (error) {
            bridge.respond(request.request_id, false, "快速预览失败：" + error.toString());
        }
    };

    bridge.tick = function () {
        if (!bridge.running) {
            return;
        }
        try {
            bridge.writeStatus(false);
            bridge.processRequest();
        } catch (error) {
            bridge.writeStatus(true);
        }
    };

    bridge.start = function () {
        bridge.running = true;
        if (bridge.taskId) {
            try {
                app.cancelTask(bridge.taskId);
            } catch (_error) {}
        }
        bridge.taskId = app.scheduleTask("$._xbotAepPreviewBridge.tick()", POLL_MS, true);
        bridge.writeStatus(true);
    };

    bridge.stop = function () {
        bridge.running = false;
        if (bridge.taskId) {
            try {
                app.cancelTask(bridge.taskId);
            } catch (_error) {}
            bridge.taskId = 0;
        }
        bridge.writeStatus(true);
    };

    var panel = (thisObj instanceof Panel)
        ? thisObj
        : new Window("palette", "X.bot 快速预览桥接", undefined, {resizeable: true});
    panel.orientation = "column";
    panel.alignChildren = ["fill", "top"];
    panel.spacing = 8;
    panel.margins = 12;
    panel.add("statictext", undefined, "保持此面板和当前 AEP 打开，可加速收集器的预览调帧。", {multiline: true});
    bridge.statusLabel = panel.add("statictext", undefined, "正在启动…", {multiline: true});
    var buttons = panel.add("group");
    buttons.orientation = "row";
    var startButton = buttons.add("button", undefined, "启动桥接");
    var stopButton = buttons.add("button", undefined, "停止桥接");
    startButton.onClick = bridge.start;
    stopButton.onClick = bridge.stop;
    panel.onResizing = panel.onResize = function () {
        this.layout.resize();
    };

    bridge.start();
    if (panel instanceof Window) {
        panel.center();
        panel.show();
    } else {
        panel.layout.layout(true);
    }
})(this);
