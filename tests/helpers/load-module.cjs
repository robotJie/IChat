const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const ts = require("typescript")

// Run actual TS modules with controlled Chrome API and storage boundaries.
function loadModule(filename, globals = {}, mocks = {}, cache = new Map()) {
  const fullPath = path.resolve(__dirname, "../../src/lib", filename)
  if (cache.has(fullPath)) return cache.get(fullPath)
  const module = { exports: {} }
  cache.set(fullPath, module.exports)
  const code = ts.transpileModule(fs.readFileSync(fullPath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  vm.runInNewContext(code, {
    module, exports: module.exports, URL, Blob, console, crypto: require("node:crypto").webcrypto,
    require: (name) => {
      if (mocks[name]) return mocks[name]
      if (name.startsWith(".")) {
        return loadModule(path.resolve(path.dirname(fullPath), `${name}.ts`), globals, mocks, cache)
      }
      return require(name)
    },
    ...globals
  }, { filename: fullPath })
  return module.exports
}

module.exports = { loadModule }
