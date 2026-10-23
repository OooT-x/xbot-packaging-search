const fs = require("fs");
const path = require("path");

// Retain a crash-torn line for diagnostics, but never concatenate a new event to it.
function appendDurably(file, event) {
  const line = JSON.stringify(event) + "\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a+", 0o600);
  try {
    const size = fs.fstatSync(fd).size;
    if (size) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 10) fs.writeFileSync(fd, "\n");
    }
    fs.writeFileSync(fd, line);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

module.exports = { appendDurably };
