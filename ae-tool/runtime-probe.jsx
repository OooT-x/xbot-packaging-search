#target aftereffects
#include "./XbotPackagingOrganizer/manifest-core.js"

(function () {
  var result = {
    after_effects_version: String(app.version || ""),
    project_open: app.project !== null,
    selected_comp_count: 0,
    first_comp_name: "",
    save_frame_to_png_available: false,
    scriptui_available: typeof Window !== "undefined" && typeof Panel !== "undefined",
    manifest_core_loaded: typeof XbotManifestCore !== "undefined" && typeof XbotManifestCore.buildManifest === "function"
  };
  var i;
  var item;
  var output;

  if (app.project) {
    for (i = 0; i < app.project.selection.length; i += 1) {
      if (app.project.selection[i] instanceof CompItem) result.selected_comp_count += 1;
    }
    for (i = 1; i <= app.project.numItems; i += 1) {
      item = app.project.item(i);
      if (item instanceof CompItem) {
        result.first_comp_name = item.name;
        result.save_frame_to_png_available = typeof item.saveFrameToPng === "function";
        break;
      }
    }
  }

  output = new File(File($.fileName).parent.fsName + "/runtime-probe-result.json");
  output.encoding = "UTF-8";
  if (output.open("w")) {
    output.write(JSON.stringify(result, null, 2));
    output.close();
  }
}());
