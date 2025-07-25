"use strict";

const { writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { processKill, runAndGetProcess } = require("../../utils/test-utils");

const wordsInStatsv5 = ["asset", "index.js", "compiled successfully"];

describe("watch variable", () => {
  it("should pass `WEBPACK_WATCH` env variable and recompile upon file change using the `watch` command", (done) => {
    const proc = runAndGetProcess(__dirname, ["watch", "--mode", "development"]);

    let modified = false;

    proc.stdout.on("data", (chunk) => {
      const data = chunk.toString();

      expect(data).not.toContain("FAIL");

      if (data.includes("index.js")) {
        for (const word of wordsInStatsv5) {
          expect(data).toContain(word);
        }

        if (!modified) {
          process.nextTick(() => {
            writeFileSync(resolve(__dirname, "./src/index.js"), "console.log('watch flag test');");
          });

          modified = true;
        } else {
          processKill(proc);
          done();
        }
      }
    });
  });

  it("should pass `WEBPACK_WATCH` env variable and recompile upon file change using the `--watch` option", (done) => {
    const proc = runAndGetProcess(__dirname, ["--watch", "--mode", "development"]);

    let modified = false;

    proc.stdout.on("data", (chunk) => {
      const data = chunk.toString();

      expect(data).not.toContain("FAIL");

      if (data.includes("index.js")) {
        for (const word of wordsInStatsv5) {
          expect(data).toContain(word);
        }

        if (!modified) {
          process.nextTick(() => {
            writeFileSync(resolve(__dirname, "./src/index.js"), "console.log('watch flag test');");
          });

          modified = true;
        } else {
          processKill(proc);
          done();
        }
      }
    });
  });
});
