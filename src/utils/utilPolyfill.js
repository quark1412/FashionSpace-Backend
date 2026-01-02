import { createRequire } from "module";
const require = createRequire(import.meta.url);

const Module = require("module");
const originalRequire = Module.prototype.require;

Module.prototype.require = function (id) {
  const mod = originalRequire.apply(this, arguments);
  if (id === "util" && mod && !mod.isNullOrUndefined) {
    mod.isNullOrUndefined = (val) => val === null || val === undefined;
  }
  return mod;
};
