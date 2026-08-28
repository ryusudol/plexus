import fs from "node:fs";

/** Follow a JSONL file, emitting complete lines as they appear. */
export class FileTail {
  filePath: string;
  onLine: (line: string) => void;
  offset = 0;
  buf = "";
  watcher: fs.FSWatcher | null = null;

  constructor(filePath: string, onLine: (line: string) => void) {
    this.filePath = filePath;
    this.onLine = onLine;
  }

  replay(): void {
    this.offset = 0;
    this.buf = "";
    this.readNew();
  }

  readNew(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.filePath);
    } catch {
      return;
    }
    if (st.size < this.offset) {
      this.offset = 0;
      this.buf = "";
    }
    if (st.size === this.offset) return;
    const length = st.size - this.offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(this.filePath, "r");
    fs.readSync(fd, buffer, 0, length, this.offset);
    fs.closeSync(fd);
    this.offset = st.size;
    this.buf += buffer.toString("utf8");
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    for (const line of parts) {
      if (line.trim()) this.onLine(line);
    }
  }

  start(): void {
    this.stop();
    try {
      this.watcher = fs.watch(this.filePath, () => this.readNew());
    } catch {
      this.watcher = null;
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
