#target aftereffects
#targetengine "xbot_packaging_organizer"
#include "./XbotPackagingOrganizer/manifest-core.js"

(function XbotPackagingOrganizer(thisObj) {
  var CORE = XbotManifestCore;
  var state = {
    records: [],
    outputFolder: null,
    batchId: "",
    createdAt: ""
  };
  var ui = {};

  function pad(value, length) {
    var result = String(value);
    while (result.length < length) result = "0" + result;
    return result;
  }

  function isoNow() {
    var date = new Date();
    var offset = -date.getTimezoneOffset();
    var sign = offset >= 0 ? "+" : "-";
    var absolute = Math.abs(offset);
    return date.getFullYear() + "-" +
      pad(date.getMonth() + 1, 2) + "-" +
      pad(date.getDate(), 2) + "T" +
      pad(date.getHours(), 2) + ":" +
      pad(date.getMinutes(), 2) + ":" +
      pad(date.getSeconds(), 2) + sign +
      pad(Math.floor(absolute / 60), 2) + ":" +
      pad(absolute % 60, 2);
  }

  function timeLabel() {
    var date = new Date();
    return pad(date.getHours(), 2) + ":" + pad(date.getMinutes(), 2) + ":" + pad(date.getSeconds(), 2);
  }

  function appendLog(message) {
    var current = ui.logText.text || "";
    var next = "[" + timeLabel() + "] " + message;
    ui.logText.text = current ? current + "\n" + next : next;
    try {
      ui.logText.active = true;
      ui.logText.active = false;
    } catch (ignore) {}
  }

  function sourceProjectName() {
    if (app.project && app.project.file) return app.project.file.name;
    return "未保存工程.aep";
  }

  function inferredProjectName() {
    var name = sourceProjectName();
    return name.replace(/\.(aep|aepx|aet)$/i, "").replace(/[_\- ]?(master|main|工程|项目)$/i, "");
  }

  function isCompItem(item) {
    try {
      return item instanceof CompItem;
    } catch (error) {
      return false;
    }
  }

  function selectedRecord() {
    if (!ui.packageList.selection) return null;
    return state.records[ui.packageList.selection.recordIndex];
  }

  function typeSelection(typeName) {
    var i;
    for (i = 0; i < ui.typeList.items.length; i += 1) {
      if (ui.typeList.items[i].text === typeName) return ui.typeList.items[i];
    }
    return ui.typeList.items[0];
  }

  function riskSummary(record) {
    if (!record.risk) return "未扫描";
    return CORE.dependencyStatus(record.risk);
  }

  function refreshList(preferredIndex) {
    var i;
    var record;
    var item;
    ui.packageList.removeAll();
    for (i = 0; i < state.records.length; i += 1) {
      record = state.records[i];
      item = ui.packageList.add("item", record.compName);
      item.recordIndex = i;
      item.subItems[0].text = record.packageName || "";
      item.subItems[1].text = record.packageType || "请选择";
      item.subItems[2].text = record.version || "";
      item.subItems[3].text = String(record.previewTime);
      item.subItems[4].text = riskSummary(record);
    }
    if (state.records.length > 0) {
      if (typeof preferredIndex !== "number" || preferredIndex < 0 || preferredIndex >= state.records.length) preferredIndex = 0;
      ui.packageList.selection = ui.packageList.items[preferredIndex];
      loadRecordEditor(state.records[preferredIndex]);
    } else {
      clearRecordEditor();
    }
    updateActionState();
  }

  function loadRecordEditor(record) {
    if (!record) return;
    ui.nameText.text = record.packageName || "";
    ui.typeList.selection = typeSelection(record.packageType);
    ui.versionText.text = record.version || "v01";
    ui.previewTimeText.text = String(record.previewTime);
    ui.alphaCheck.value = record.alphaRequired === true;
  }

  function clearRecordEditor() {
    ui.nameText.text = "";
    ui.typeList.selection = ui.typeList.items[0];
    ui.versionText.text = "v01";
    ui.previewTimeText.text = "0";
    ui.alphaCheck.value = false;
  }

  function updateActionState() {
    var hasRecords = state.records.length > 0;
    var hasSelection = selectedRecord() !== null;
    ui.scanButton.enabled = hasRecords;
    ui.generateButton.enabled = hasRecords && state.outputFolder !== null;
    ui.collectButton.enabled = hasSelection;
    ui.zipButton.enabled = hasSelection && state.outputFolder !== null;
    ui.verifyButton.enabled = hasRecords && state.outputFolder !== null;
    ui.applyButton.enabled = hasSelection;
  }

  function readSelectedComps() {
    var selection;
    var comps = [];
    var i;
    var comp;
    var inferredType;
    if (!app.project) {
      alert("请先打开一个 After Effects 工程。");
      return;
    }
    selection = app.project.selection || [];
    for (i = 0; i < selection.length; i += 1) {
      if (isCompItem(selection[i])) comps.push(selection[i]);
    }
    if (comps.length === 0) {
      alert("请先在 Project（项目）面板中选择至少一个包装合成。");
      return;
    }
    if (state.records.length > 0 && !confirm("重新读取会覆盖面板中尚未导出的包装元数据，是否继续？")) return;

    state.records = [];
    for (i = 0; i < comps.length; i += 1) {
      comp = comps[i];
      inferredType = CORE.inferPackageType(comp.name);
      state.records.push({
        comp: comp,
        compName: comp.name,
        packageName: comp.name,
        packageType: inferredType,
        version: "v01",
        previewTime: Math.round(Math.max(0, Math.min(comp.time, comp.duration)) * 1000) / 1000,
        alphaRequired: inferredType === "信息条" || inferredType === "视频框",
        risk: null,
        collectedFolder: null,
        reportFiles: []
      });
    }
    if (!CORE.trim(ui.projectText.text)) ui.projectText.text = inferredProjectName();
    state.createdAt = isoNow();
    state.batchId = CORE.makeBatchId(state.createdAt, Math.random());
    refreshList(0);
    appendLog("已读取 " + state.records.length + " 个用户选择的包装合成。未识别的包装类型需要手动补充。");
  }

  function applyRecordEditor() {
    var record = selectedRecord();
    var previewTime;
    var selectedType;
    var index;
    if (!record) return;
    previewTime = Number(ui.previewTimeText.text);
    if (isNaN(previewTime) || previewTime < 0 || previewTime > record.comp.duration) {
      alert("预览时间必须位于 0 到 " + record.comp.duration + " 秒之间。");
      return;
    }
    selectedType = ui.typeList.selection ? ui.typeList.selection.text : "";
    if (selectedType === "请选择") selectedType = "";
    record.packageName = CORE.trim(ui.nameText.text);
    record.packageType = selectedType;
    record.version = CORE.normalizeVersion(ui.versionText.text) || CORE.trim(ui.versionText.text);
    record.previewTime = previewTime;
    record.alphaRequired = ui.alphaCheck.value === true;
    index = ui.packageList.selection.recordIndex;
    refreshList(index);
    appendLog("已更新合成“" + record.compName + "”的包装元数据。");
  }

  function collectCompGraph(rootComp) {
    var result = [];
    var visited = {};

    function visit(comp) {
      var key = String(comp.id || comp.name);
      var i;
      var layer;
      var source;
      if (visited[key]) return;
      visited[key] = true;
      result.push(comp);
      for (i = 1; i <= comp.numLayers; i += 1) {
        layer = comp.layer(i);
        try {
          source = layer.source;
          if (source && isCompItem(source)) visit(source);
        } catch (ignore) {}
      }
    }

    visit(rootComp);
    return result;
  }

  function addUnique(target, value) {
    var i;
    value = CORE.trim(value);
    if (!value) return;
    for (i = 0; i < target.length; i += 1) {
      if (target[i] === value) return;
    }
    target.push(value);
  }

  function compactExpression(expression) {
    return CORE.trim(String(expression || "").replace(/[\r\n\t]+/g, " ")).slice(0, 180);
  }

  function inspectExpression(property, context, graphNames, risk) {
    var expression;
    var regex;
    var match;
    var targetName;
    var i;
    var insideGraph;
    try {
      if (!property.canSetExpression || !property.expressionEnabled) return;
      expression = property.expression || "";
      regex = /comp\s*\(\s*["']([^"']+)["']\s*\)/g;
      match = regex.exec(expression);
      while (match) {
        targetName = match[1];
        insideGraph = false;
        for (i = 0; i < graphNames.length; i += 1) {
          if (graphNames[i] === targetName) {
            insideGraph = true;
            break;
          }
        }
        if (!insideGraph) {
          risk.crossCompExpressions.push({
            comp: context.comp,
            layer: context.layer,
            property: property.name,
            target_comp: targetName,
            expression_preview: compactExpression(expression)
          });
        }
        match = regex.exec(expression);
      }
      if (/thisProject\s*\.\s*item\s*\(/.test(expression)) {
        risk.crossCompExpressions.push({
          comp: context.comp,
          layer: context.layer,
          property: property.name,
          target_comp: "thisProject.item(...)（需人工确认）",
          expression_preview: compactExpression(expression)
        });
      }
      try {
        if (property.expressionError) addUnique(risk.scanErrors, context.comp + " / " + context.layer + " / " + property.name + "：" + property.expressionError);
      } catch (ignoreError) {}
    } catch (error) {
      addUnique(risk.scanErrors, context.comp + " / " + context.layer + "：表达式扫描失败：" + error.toString());
    }
  }

  function inspectProperties(group, context, graphNames, risk) {
    var i;
    var property;
    if (!group || typeof group.numProperties === "undefined") return;
    for (i = 1; i <= group.numProperties; i += 1) {
      try {
        property = group.property(i);
        if (!property) continue;
        if (property.propertyType === PropertyType.PROPERTY) {
          inspectExpression(property, context, graphNames, risk);
        } else {
          inspectProperties(property, context, graphNames, risk);
        }
      } catch (error) {
        addUnique(risk.scanErrors, context.comp + " / " + context.layer + "：属性扫描失败：" + error.toString());
      }
    }
  }

  function inspectLayer(layer, comp, graphNames, risk) {
    var source;
    var sourceText;
    var textDocument;
    var effects;
    var effect;
    var effectName;
    var matchName;
    var i;
    try {
      source = layer.source;
      if (source && source instanceof FootageItem) {
        try {
          if (source.footageMissing === true) {
            addUnique(risk.missingFootage, source.name);
          } else if (source.file && !source.file.exists) {
            addUnique(risk.missingFootage, source.file.fsName || source.name);
          }
        } catch (missingError) {}
      }
    } catch (sourceError) {}

    try {
      sourceText = layer.property("ADBE Text Properties");
      if (sourceText) sourceText = sourceText.property("ADBE Text Document");
      if (sourceText) {
        textDocument = sourceText.value;
        if (textDocument && textDocument.font) addUnique(risk.fonts, textDocument.font);
      }
    } catch (fontError) {
      addUnique(risk.scanErrors, comp.name + " / " + layer.name + "：字体扫描失败：" + fontError.toString());
    }

    try {
      effects = layer.property("ADBE Effect Parade");
      if (effects) {
        for (i = 1; i <= effects.numProperties; i += 1) {
          effect = effects.property(i);
          effectName = effect.name || "未命名效果";
          matchName = effect.matchName || "";
          addUnique(risk.effects, effectName + (matchName ? " [" + matchName + "]" : ""));
          if (matchName && matchName.indexOf("ADBE") !== 0) addUnique(risk.thirdPartyEffects, effectName + " [" + matchName + "]");
        }
      }
    } catch (effectError) {
      addUnique(risk.scanErrors, comp.name + " / " + layer.name + "：效果扫描失败：" + effectError.toString());
    }

    inspectProperties(layer, { comp: comp.name, layer: layer.name }, graphNames, risk);
  }

  function scanRecord(record) {
    var graph = collectCompGraph(record.comp);
    var graphNames = [];
    var risk = {
      missingFootage: [],
      fonts: [],
      effects: [],
      thirdPartyEffects: [],
      crossCompExpressions: [],
      scanErrors: []
    };
    var i;
    var j;
    var comp;
    for (i = 0; i < graph.length; i += 1) graphNames.push(graph[i].name);
    for (i = 0; i < graph.length; i += 1) {
      comp = graph[i];
      for (j = 1; j <= comp.numLayers; j += 1) inspectLayer(comp.layer(j), comp, graphNames, risk);
    }
    record.risk = risk;
    return risk;
  }

  function scanAllRisks() {
    var i;
    var risk;
    var status;
    if (state.records.length === 0) return;
    for (i = 0; i < state.records.length; i += 1) {
      risk = scanRecord(state.records[i]);
      status = CORE.dependencyStatus(risk);
      appendLog("“" + state.records[i].compName + "”风险扫描：" + status + "；字体 " + risk.fonts.length + "，效果 " + risk.effects.length + "，缺失素材 " + risk.missingFootage.length + "，跨合成引用 " + risk.crossCompExpressions.length + "。");
    }
    refreshList(ui.packageList.selection ? ui.packageList.selection.recordIndex : 0);
  }

  function chooseOutputFolder() {
    var folder = Folder.selectDialog("选择待入库交付目录（PNG、ZIP、manifest 将放在这里）", state.outputFolder || Folder.myDocuments);
    if (!folder) return;
    state.outputFolder = folder;
    ui.outputText.text = folder.fsName;
    updateActionState();
    appendLog("交付目录：" + folder.fsName);
  }

  function recordMeta(record) {
    return {
      sourceProjectName: sourceProjectName(),
      projectName: CORE.trim(ui.projectText.text),
      packageName: record.packageName,
      packageType: record.packageType,
      version: record.version,
      compName: record.compName,
      previewTime: record.previewTime,
      alphaRequired: record.alphaRequired,
      reportFiles: record.reportFiles || []
    };
  }

  function validateAll(requireRisk) {
    var errors = [];
    var i;
    var record;
    var recordErrors;
    if (!CORE.trim(ui.projectText.text)) errors.push("缺少项目名称");
    for (i = 0; i < state.records.length; i += 1) {
      record = state.records[i];
      recordErrors = CORE.validatePackageMeta(recordMeta(record));
      if (requireRisk && !record.risk) recordErrors.push("尚未执行风险扫描");
      if (recordErrors.length > 0) errors.push("“" + record.compName + "”：" + recordErrors.join("、"));
    }
    return errors;
  }

  function fileFor(name) {
    return new File(state.outputFolder.fsName + "/" + name);
  }

  function freshFileExists(file, waitMilliseconds) {
    var deadline = (new Date()).getTime() + (waitMilliseconds || 0);
    do {
      if ((new File(file.fsName)).exists) return true;
      if ((new Date()).getTime() >= deadline) break;
      $.sleep(50);
    } while (true);
    return false;
  }

  function packageStem(record) {
    return CORE.makePackageStem({
      projectName: CORE.trim(ui.projectText.text),
      packageType: record.packageType,
      packageName: record.packageName,
      version: record.version
    });
  }

  function writeUtf8(file, content) {
    file.encoding = "UTF-8";
    file.lineFeed = "Windows";
    if (!file.open("w")) throw new Error("无法写入 " + file.fsName + "。请在 AE 设置中允许脚本写入文件。");
    try {
      file.write(content);
    } finally {
      file.close();
    }
  }

  function createManifestEntries() {
    var entries = [];
    var i;
    var record;
    var meta;
    var stem;
    for (i = 0; i < state.records.length; i += 1) {
      record = state.records[i];
      meta = recordMeta(record);
      stem = packageStem(record);
      meta.previewFile = stem + ".png";
      meta.sourceFile = stem + ".zip";
      entries.push(CORE.createPackageEntry(meta, record.risk || { scanErrors: ["尚未执行风险扫描"] }, state.createdAt || isoNow()));
    }
    return entries;
  }

  function writeManifest() {
    var manifest = CORE.buildManifest(
      CORE.trim(ui.projectText.text),
      createManifestEntries(),
      state.createdAt || isoNow(),
      state.batchId || CORE.makeBatchId(isoNow(), Math.random())
    );
    var manifestFile = fileFor("manifest.json");
    writeUtf8(manifestFile, JSON.stringify(manifest, null, 2));
    return manifestFile;
  }

  function generatePreviewsAndManifest() {
    var errors = validateAll(true);
    var existing = [];
    var i;
    var record;
    var preview;
    var manifestFile;
    if (errors.length > 0) {
      alert("请先修正：\n\n" + errors.join("\n"));
      return;
    }
    for (i = 0; i < state.records.length; i += 1) {
      preview = fileFor(packageStem(state.records[i]) + ".png");
      if (preview.exists) existing.push(preview.name);
    }
    if (fileFor("manifest.json").exists) existing.push("manifest.json");
    if (existing.length > 0 && !confirm("以下文件已存在，将覆盖：\n\n" + existing.join("\n") + "\n\n是否继续？")) return;

    state.createdAt = isoNow();
    if (!state.batchId) state.batchId = CORE.makeBatchId(state.createdAt, Math.random());
    for (i = 0; i < state.records.length; i += 1) {
      record = state.records[i];
      preview = fileFor(packageStem(record) + ".png");
      try {
        if (typeof record.comp.saveFrameToPng !== "function") throw new Error("当前 AE 未提供 saveFrameToPng 脚本接口");
        record.comp.saveFrameToPng(record.previewTime, preview);
        if (!freshFileExists(preview, 2000)) throw new Error("AE 未生成预览文件");
        appendLog("已生成预览：" + preview.name + (record.alphaRequired ? "（需复核透明通道）" : ""));
      } catch (error) {
        alert("生成“" + record.compName + "”预览失败：\n" + error.toString());
        appendLog("预览生成失败：" + record.compName + "；" + error.toString());
        return;
      }
    }
    try {
      manifestFile = writeManifest();
      appendLog("已生成 manifest：" + manifestFile.fsName + "。ZIP 未就位前，Eagle 会按缺少源文件阻止入库。");
    } catch (manifestError) {
      alert(manifestError.toString());
      appendLog("manifest 写入失败：" + manifestError.toString());
    }
  }

  function selectOnlyComp(comp) {
    var i;
    if (!app.project) return;
    for (i = 1; i <= app.project.numItems; i += 1) {
      try {
        app.project.item(i).selected = false;
      } catch (ignore) {}
    }
    try {
      comp.selected = true;
    } catch (error) {}
  }

  function findCollectFilesCommand() {
    var labels = ["Collect Files...", "Collect Files…", "收集文件...", "收集文件…"];
    var i;
    var commandId;
    for (i = 0; i < labels.length; i += 1) {
      try {
        commandId = app.findMenuCommandId(labels[i]);
        if (commandId) return commandId;
      } catch (ignore) {}
    }
    return 0;
  }

  function openCollectFiles() {
    var record = selectedRecord();
    var commandId;
    if (!record) return;
    selectOnlyComp(record.comp);
    alert("即将为“" + record.compName + "”准备收集。\n\n在 Collect Files（收集文件）中请选择 For Selected Comps（选中的合成）。第一版默认不要启用 Reduce Project；请保留 AE 生成的 Report。收集完成后回到本面板，点击“关联并压缩收集目录”。");
    commandId = findCollectFilesCommand();
    if (commandId) {
      app.executeCommand(commandId);
      appendLog("已为“" + record.compName + "”打开 AE 原生 Collect Files。");
    } else {
      alert("当前语言版本未能自动定位菜单。请手动执行 File > Dependencies > Collect Files（文件 > 依赖项 > 收集文件）。合成已在 Project 面板中选中。");
      appendLog("未能自动打开 Collect Files；已保留目标合成选择，等待手动执行。");
    }
  }

  function powershellLiteral(value) {
    return String(value).replace(/'/g, "''");
  }

  function collectReportNames(folder) {
    var result = [];

    function visit(current, depth) {
      var files;
      var i;
      var entry;
      if (depth > 6) return;
      try {
        files = current.getFiles();
      } catch (error) {
        return;
      }
      for (i = 0; i < files.length; i += 1) {
        entry = files[i];
        if (entry instanceof Folder) {
          visit(entry, depth + 1);
        } else if (/report|报告|依赖/i.test(entry.name)) {
          addUnique(result, entry.name);
        }
      }
    }

    visit(folder, 0);
    return result;
  }

  function zipCollectedFolder() {
    var record = selectedRecord();
    var folder;
    var destination;
    var script;
    var command;
    var output;
    var manifestFile;
    if (!record || !state.outputFolder) return;
    folder = Folder.selectDialog("选择“" + record.compName + "”刚生成的 AE 收集文件夹");
    if (!folder) return;
    destination = fileFor(packageStem(record) + ".zip");
    if (destination.exists && !confirm(destination.name + " 已存在，是否覆盖？")) return;
    if (String($.os).toLowerCase().indexOf("windows") < 0) {
      alert("当前第一版自动压缩仅支持 Windows。请手动把收集目录压缩为：\n" + destination.fsName);
      return;
    }
    script = "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath '" +
      powershellLiteral(folder.fsName) + "' -DestinationPath '" +
      powershellLiteral(destination.fsName) + "' -Force; Write-Output '__XBOT_ZIP_OK__'";
    command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"" + script + "\"";
    appendLog("正在压缩收集目录；大型工程可能需要一些时间……");
    try {
      output = system.callSystem(command);
      if (!freshFileExists(destination, 2000) || String(output).indexOf("__XBOT_ZIP_OK__") < 0) throw new Error(output || "未生成 ZIP");
      record.collectedFolder = folder;
      record.reportFiles = collectReportNames(folder);
      manifestFile = writeManifest();
      appendLog("已生成源文件：" + destination.name + "；Report " + record.reportFiles.length + " 个；manifest 已刷新。");
      alert("压缩完成：\n" + destination.fsName + "\n\n请点击“检查交付”。");
    } catch (error) {
      alert("压缩失败：\n" + error.toString() + "\n\n可以手动把收集目录压缩为：\n" + destination.fsName);
      appendLog("压缩失败：" + error.toString());
    }
  }

  function verifyDelivery() {
    var errors = validateAll(true);
    var warnings = [];
    var ready = [];
    var i;
    var record;
    var preview;
    var source;
    var status;
    var manifest;
    if (errors.length > 0) {
      alert("元数据仍不完整：\n\n" + errors.join("\n"));
      return;
    }
    manifest = fileFor("manifest.json");
    if (!manifest.exists) errors.push("缺少 manifest.json");
    for (i = 0; i < state.records.length; i += 1) {
      record = state.records[i];
      preview = fileFor(packageStem(record) + ".png");
      source = fileFor(packageStem(record) + ".zip");
      status = CORE.dependencyStatus(record.risk);
      if (!preview.exists) errors.push("“" + record.packageName + "”缺少 PNG 预览");
      if (!source.exists) errors.push("“" + record.packageName + "”缺少 ZIP 源文件");
      if (status === "阻止入库") errors.push("“" + record.packageName + "”存在阻止入库风险");
      if (status === "警告") warnings.push("“" + record.packageName + "”需要人工复核字体或第三方效果");
      if (preview.exists && source.exists && status !== "阻止入库") ready.push(record.packageName);
    }
    try {
      writeManifest();
    } catch (writeError) {
      errors.push("manifest 刷新失败：" + writeError.toString());
    }
    if (errors.length > 0) {
      alert("交付检查未通过：\n\n" + errors.join("\n") + (warnings.length ? "\n\n警告：\n" + warnings.join("\n") : ""));
      appendLog("交付检查未通过，共 " + errors.length + " 项阻止问题。");
      return;
    }
    alert("交付检查通过：" + ready.length + " 个包装可进入 Eagle 待入库。" + (warnings.length ? "\n\n仍需人工复核：\n" + warnings.join("\n") : ""));
    appendLog("交付检查通过：" + ready.length + " 个包装，警告 " + warnings.length + " 项。");
  }

  function addLabeledField(parent, label, characters) {
    var group = parent.add("group");
    var field;
    group.orientation = "row";
    group.alignChildren = ["left", "center"];
    group.add("statictext", undefined, label).preferredSize.width = 76;
    field = group.add("edittext", undefined, "");
    field.characters = characters || 24;
    return field;
  }

  function buildUI(host) {
    var palette = host instanceof Panel ? host : new Window("palette", "X.bot AE 包装整理", undefined, { resizeable: true });
    var intro;
    var projectPanel;
    var outputGroup;
    var toolbar;
    var detailPanel;
    var typeGroup;
    var timeGroup;
    var deliveryPanel;
    var deliveryButtons;
    var logPanel;

    palette.orientation = "column";
    palette.alignChildren = ["fill", "top"];
    palette.spacing = 8;
    palette.margins = 12;

    intro = palette.add("statictext", undefined, "选择包装合成 → 风险扫描 → PNG / manifest → AE Collect Files → ZIP → Eagle 待入库", { multiline: true });
    intro.alignment = ["fill", "top"];

    projectPanel = palette.add("panel", undefined, "1. 项目与输出");
    projectPanel.orientation = "column";
    projectPanel.alignChildren = ["fill", "top"];
    projectPanel.margins = 10;
    ui.projectText = addLabeledField(projectPanel, "项目名称", 34);
    ui.projectText.text = inferredProjectName();
    outputGroup = projectPanel.add("group");
    outputGroup.orientation = "row";
    outputGroup.alignChildren = ["fill", "center"];
    outputGroup.add("statictext", undefined, "交付目录").preferredSize.width = 76;
    ui.outputText = outputGroup.add("edittext", undefined, "", { readonly: true });
    ui.outputText.alignment = ["fill", "center"];
    ui.outputButton = outputGroup.add("button", undefined, "选择…");

    toolbar = palette.add("group");
    toolbar.orientation = "row";
    ui.readButton = toolbar.add("button", undefined, "读取所选合成");
    ui.scanButton = toolbar.add("button", undefined, "扫描风险");
    ui.generateButton = toolbar.add("button", undefined, "生成 PNG + manifest");

    ui.packageList = palette.add("listbox", undefined, "", {
      numberOfColumns: 6,
      showHeaders: true,
      columnTitles: ["AE 合成", "包装名称", "类型", "版本", "预览秒", "依赖状态"],
      columnWidths: [150, 150, 80, 55, 65, 80]
    });
    ui.packageList.preferredSize = [630, 170];
    ui.packageList.alignment = ["fill", "fill"];

    detailPanel = palette.add("panel", undefined, "2. 当前包装元数据");
    detailPanel.orientation = "column";
    detailPanel.alignChildren = ["fill", "top"];
    detailPanel.margins = 10;
    ui.nameText = addLabeledField(detailPanel, "包装名称", 34);
    typeGroup = detailPanel.add("group");
    typeGroup.orientation = "row";
    typeGroup.add("statictext", undefined, "包装类型").preferredSize.width = 76;
    ui.typeList = typeGroup.add("dropdownlist", undefined, ["请选择", "信息条", "视频框", "背景", "分镜排版"]);
    ui.typeList.selection = 0;
    ui.typeList.preferredSize.width = 150;
    typeGroup.add("statictext", undefined, "版本");
    ui.versionText = typeGroup.add("edittext", undefined, "v01");
    ui.versionText.characters = 7;
    timeGroup = detailPanel.add("group");
    timeGroup.orientation = "row";
    timeGroup.add("statictext", undefined, "预览时间").preferredSize.width = 76;
    ui.previewTimeText = timeGroup.add("edittext", undefined, "0");
    ui.previewTimeText.characters = 9;
    timeGroup.add("statictext", undefined, "秒");
    ui.alphaCheck = timeGroup.add("checkbox", undefined, "预览需要透明通道");
    ui.applyButton = timeGroup.add("button", undefined, "应用到当前项");

    deliveryPanel = palette.add("panel", undefined, "3. 依赖收集与交付");
    deliveryPanel.orientation = "column";
    deliveryPanel.alignChildren = ["fill", "top"];
    deliveryPanel.margins = 10;
    deliveryPanel.add("statictext", undefined, "逐个包装使用 AE 原生 Collect Files；默认不执行 Reduce Project。收集后把目录关联到当前包装并压缩。", { multiline: true });
    deliveryButtons = deliveryPanel.add("group");
    deliveryButtons.orientation = "row";
    ui.collectButton = deliveryButtons.add("button", undefined, "打开 Collect Files");
    ui.zipButton = deliveryButtons.add("button", undefined, "关联并压缩收集目录");
    ui.verifyButton = deliveryButtons.add("button", undefined, "检查交付");

    logPanel = palette.add("panel", undefined, "运行记录");
    logPanel.orientation = "column";
    logPanel.alignChildren = ["fill", "fill"];
    logPanel.margins = 8;
    ui.logText = logPanel.add("edittext", undefined, "", { multiline: true, readonly: true, scrolling: true });
    ui.logText.preferredSize = [630, 120];
    ui.logText.alignment = ["fill", "fill"];

    ui.outputButton.onClick = chooseOutputFolder;
    ui.readButton.onClick = readSelectedComps;
    ui.scanButton.onClick = scanAllRisks;
    ui.generateButton.onClick = generatePreviewsAndManifest;
    ui.applyButton.onClick = applyRecordEditor;
    ui.collectButton.onClick = openCollectFiles;
    ui.zipButton.onClick = zipCollectedFolder;
    ui.verifyButton.onClick = verifyDelivery;
    ui.packageList.onChange = function () {
      loadRecordEditor(selectedRecord());
      updateActionState();
    };

    palette.onResizing = palette.onResize = function () {
      this.layout.resize();
    };
    updateActionState();
    appendLog("面板已就绪。请在 Project 面板选择用户明确确认的包装合成。");
    return palette;
  }

  var palette = buildUI(thisObj);
  if (palette instanceof Window) {
    palette.center();
    palette.show();
  } else {
    palette.layout.layout(true);
  }
}(this));
