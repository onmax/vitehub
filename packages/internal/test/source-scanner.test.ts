import { describe, expect, it } from "vitest"

import {
  createSourceScanner,
  findDefaultExportCall,
  findIdentifierCalls,
  readObjectProperty,
  readObjectPropertyNames,
  splitTopLevel,
  stripBoundaryComments,
} from "../src/source-scanner.ts"

const jsxScanner = createSourceScanner("source.tsx")

describe("source scanner", () => {
  it.each(['const text = "</Email>";', "/* </Email> */", "/* </Email> */\nconst pattern = /Email/;"])("preserves a definition between a type assertion and later JSX text: %s", (after) => {
    const source = `const first = <Email>value;\nexport default defineThing({ value: "real" });\n${after}`
    expect(findDefaultExportCall(source, ["defineThing"])?.argument).toBe('{ value: "real" }')
    expect(stripBoundaryComments(`${source} /* after */`)).toBe(after === "/* </Email> */" ? source.slice(0, source.lastIndexOf("\n")) : source)
  })

  it.each(["*", " * "])("preserves a regex operand after JSX multiplication: %s", (separator) => {
    const source = `const result = <Email></Email>${separator}/['"]/u;\nexport default defineThing({ value: "real" });`
    expect(jsxScanner.findDefaultExportCall(source, ["defineThing"])?.argument).toBe('{ value: "real" }')
    expect(jsxScanner.stripBoundaryComments(`${source} /* after */`)).toBe(source)
  })

  it.each(["/ /", "/a/*value", "/a/*value*/b/", "/a/*value + 1 /* after */"])("preserves a closed regex and its multiplication continuation after JSX: %s", (operand) => {
    const source = `const result = <Email></Email>*${operand};\nexport default defineThing({ value: "real" });`
    expect(jsxScanner.findDefaultExportCall(source, ["defineThing"])?.argument).toBe('{ value: "real" }')
    expect(jsxScanner.stripBoundaryComments(`${source} /* after */`)).toBe(source)
  })

  it.each(["/* </Email> */ /* after; */", '/* </Email> */ /* after" */'])("preserves a definition before punctuation in trailing comments: %s", (after) => {
    const source = `const definition = <Email>value;\nexport default defineThing({ value: "real" });`
    expect(findDefaultExportCall(`${source}\n${after}`, ["defineThing"])?.argument).toBe('{ value: "real" }')
    expect(stripBoundaryComments(`${source}\n${after}`)).toBe(source)
  })

  it("preserves a regex statement after a closing tag in a TypeScript comment", () => {
    const source = 'const first = <Email>value;\nexport default defineThing({ value: "real" });\n/* </Email> */ / /;'
    expect(findDefaultExportCall(source, ["defineThing"])?.argument).toBe('{ value: "real" }')
    expect(stripBoundaryComments(`${source} /* after */`)).toBe(source)
  })

  it("preserves a JSX expression before an automatic semicolon boundary", () => {
    const source = 'const first = <Email></Email>\n"after";\nexport default defineThing({ value: "real" });'
    expect(jsxScanner.findDefaultExportCall(source, ["defineThing"])?.argument).toBe('{ value: "real" }')
    expect(jsxScanner.stripBoundaryComments(`${source} /* after */`)).toBe(source)
  })

  it.each([
    "<T extends Email>(value: T) => value",
    "<T = Email>(value: T) => value",
    "<T extends () => Email>(value: T) => value",
    "<T extends Email>(value: T): Email => value",
    "<const T extends Email>(value: T) => value",
  ])("preserves a definition after a TSX generic arrow: %s", (arrow) => {
    const source = `const first = ${arrow};\nexport default defineThing({ value: "real" });\nconst text = "</T></const>";`
    expect(jsxScanner.findDefaultExportCall(source, ["defineThing"])?.argument).toBe('{ value: "real" }')
    expect(jsxScanner.stripBoundaryComments(`${source} /* after */`)).toBe(source)
  })

  it.each([
    "<Email></Email>",
    '<Email /* " */></Email>',
    '<Email></Email /* " */>',
    "<Email />",
    "<T extends />",
    "<Email<string>></Email>",
    "<Email <string>>import(fake)</Email>",
    "<Email\n<Array<string>> />",
    "<Email<Array<string>> />",
    "<Email<{ subject: string }>>{import(target)}</Email>",
    "<Email<() => string>>{import(target)}</Email>",
    "<T>(value) =&gt; value</T>",
    "<T extends={Email}>(value) {() => value}</T>",
    String.raw`<Email subject="C:\"></Email>`,
    "<>message, 'quoted' // text<Email /></>",
    '<Email subject="hello" {...props}>{value < /Email>/g ? <Email /> : null}</Email>',
    '<Email><Email />{`hello ${"x"}`}</Email>',
    `<Email>{(() => { function task() {} /['"]/u.test(value); return null })()}</Email>`,
  ])("preserves metadata after JSX in a definition: %s", (jsx) => {
    const object = `{ handler: () => ${jsx}, manual: true, allowRuntimeSchedules: true }`
    const source = `export default defineThing(${object})`
    const definition = jsxScanner.findDefaultExportCall(source, ["defineThing"])
    expect(definition?.argument).toBe(object)
    expect(jsxScanner.readObjectProperty(object, "manual")).toBe("true")
    expect(jsxScanner.readObjectPropertyNames(object)).toEqual(["handler", "manual", "allowRuntimeSchedules"])
    expect(jsxScanner.stripBoundaryComments(`${source} /* after */`)).toBe(source)
    const masked = jsxScanner.maskSourceLiterals(source)
    expect(masked).toHaveLength(source.length)
    expect(masked).toContain("manual: true, allowRuntimeSchedules: true")
    expect(masked).not.toContain("<Email")
  })

  it.each([
    ['<Email>{import(target)}</Email>', '{import(target)}'],
    ['<Email /* " */>{import(target)}</Email>', '{import(target)}'],
    ['<Email>{import(target)}</Email /* " */>', '{import(target)}'],
    ['<Email<() => string>>{import(target)}</Email>', '{import(target)}'],
    ['<Email value={import(target)} />', '{import(target)}'],
    ['<Email><Email>{import(target)}</Email></Email>', '{import(target)}'],
    ['<Email>{<Email>{import(target)}</Email>}</Email>', '{       {import(target)}        }'],
  ])("keeps executable JSX expressions while masking raw text: %s", (jsx, expression) => {
    const source = `const view = () => ${jsx};`
    const masked = jsxScanner.maskSourceLiterals(source)
    expect(masked).toHaveLength(source.length)
    expect(masked).toContain(expression)
    expect(masked).not.toContain("<Email")
  })

  it.each(['<Email label="{import(fake)}">import(fake)</Email>', '<Email<string>>import(fake)</Email>', '<Email /* " */>import(fake)</Email>', '<Email>import(fake)</Email /* " */>', `<Email label='/* " */'>import(fake)</Email>`])("masks raw JSX fake requests: %s", (source) => {
    expect(jsxScanner.maskSourceLiterals(source)).toBe(" ".repeat(source.length))
  })

  it("keeps JSX expression ranges after a control-flow regex prefix rescan", () => {
    const source = '<Email>{(() => { if (ready) {} /pattern/.test(value); return import(target) })()} import(fake)</Email>'
    const masked = jsxScanner.maskSourceLiterals(source)
    expect(masked).toHaveLength(source.length)
    expect(masked).toContain("return import(target)")
    expect(masked).not.toContain("pattern")
    expect(masked).not.toContain("import(fake)")
    expect(masked).not.toContain("<Email")
  })

  it.each(["value < /Email>/g", "value</Email>/g", "factory<Email>()", "<Email>value"])("preserves comparison regexes and type syntax: %s", (value) => {
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
    expect(findDefaultExportCall(`${value}\nexport default defineThing({ value: "real" })`, ["defineThing"])?.argument).toBe('{ value: "real" }')
  })

  it.each([
    ...["if", "for", "while", "with", "catch"].map(name => `class Task { #${name}(handler) {} run() { return this.#${name}(handler) / total } }`),
    "class Task { #extends = 1; run() { return this.#extends / total } }",
    'import value from "x" with { type: "json" }\n/[\'"]/u.test(value)',
    'export { value } from "x" with { type: "json" }\n/[\'"]/u.test(value)',
    'interface Task<T> {}\n/[\'"]/u.test(value)',
    'type Task<T> = {}\n/[\'"]/u.test(value)',
    "const Task = @factory<string>() class {} / total",
    "const Task = @factory<string>()\nclass {} / total",
    '@factory<string>() class Task {}\n/[\'"]/u.test(value)',
    '@factory<string>()\nclass Task {}\n/[\'"]/u.test(value)',
  ])("scans accepted private-name and generic declaration contexts: %s", (value) => {
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
    expect(findDefaultExportCall(`${value}\nexport default defineThing({ value: "real" })`, ["defineThing"])?.argument).toBe('{ value: "real" }')
  })

  it.each([
    'import "x"\n',
    'import value from "x"\n',
    'export { value } from "x"\n',
    'interface Task {} ',
    'enum Task {} ',
    'namespace Task {} ',
    'type Task = {}\n',
    'export @dec class Task {} ',
    'export default @dec class Task {} ',
    '@factory().dec\nclass Task {} ',
    '@factory.dec().next\nclass Task {} ',
  ])("scans regex statements after module and decorated declarations: %s", (statement) => {
    const value = `${statement}/['"]/u.test(value)`
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
    expect(findDefaultExportCall(`${value}\nexport default defineThing({ ok: true })`, ["defineThing"])?.argument).toBe("{ ok: true }")
  })

  it.each([
    "promise.catch(handler) / total",
    "object.for(handler) / total",
    "object.if(handler) / total",
    "object.with(handler) / total",
    "object?.while(handler) / total",
    "object. /* gap */ catch(handler) / total",
    "object.\tif(handler) / total",
    "const value = @(dec)\nclass Task {} / total",
    'import value from "x"\nconst other = "y"\n/ total',
    'const text = `import "x"`\n/ total',
    'import("x") / total',
    "class X extends /['\"]/u.constructor {}",
  ])("preserves reviewed expression slash contexts: %s", (value) => {
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
    expect(findDefaultExportCall(`${value}\nexport default defineThing({ ok: true })`, ["defineThing"])?.argument).toBe("{ ok: true }")
  })

  it.each([
    "fn(.../['\"]/u)",
    "fn(... /* gap */ /['\"]/u)",
    "value / /['\"]/u.test(text)",
    "value / /* gap */ /['\"]/u.test(text)",
    "value < /['\"]/u.source",
    "class X extends /['\"]/u.constructor {}",
  ])("scans regex operands after expression operators: %s", (value) => {
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
    expect(readObjectProperty(`{ value: ${value} /* after */ }`, "value")).toBe(value)
    const call = findDefaultExportCall(`${value}\nexport default defineThing({ value: "real" })`, ["defineThing"])
    expect(call?.argument).toBe(`{ value: "real" }`)
  })

  it("scans a regex operand after new", () => {
    const value = "new /['\"]/u.constructor()"
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
    expect(readObjectProperty(`{ value: ${value} /* after */ }`, "value")).toBe(value)
  })

  it.each(["count++ / total", "count-- / total"])("trims comments after postfix division: %s", (value) => {
    for (const comment of ["// after\n", "/* after */"]) {
      expect(readObjectProperty(`{ value: ${value} ${comment}}`, "value")).toBe(value)
    }
  })

  it.each(["count+++/['\"]/u", "count---/['\"]/u"])("scans a regex after a compact update and operator: %s", (value) => {
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
    const call = findDefaultExportCall(`const value = ${value}\nexport default defineThing({ value: "real" })`, ["defineThing"])
    expect(call?.argument).toBe(`{ value: "real" }`)
  })

  it.each(["break", "continue", "debugger"])("scans a regex statement after an automatic semicolon boundary: %s", (statement) => {
    const value = `while (ready) { ${statement}\n/['"]/u.test(value) }`
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
    const call = findDefaultExportCall(`${value}\nexport default defineThing({ value: "real" })`, ["defineThing"])
    expect(call?.argument).toBe(`{ value: "real" }`)
  })

  it.each(["break", "continue"])("scans a regex statement after a labeled %s", (statement) => {
    for (const label of ["outer", "é", "of"]) {
      for (const separator of ["\n", "\r", "\u2028", "\u2029", " /* next */\n", " // next\n"]) {
        const value = `${label}: while (ready) { ${statement} ${label}${separator}/['"]/u.test(value) }`
        expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
        const call = findDefaultExportCall(`${value}\nexport default defineThing({ value: "real" })`, ["defineThing"])
        expect(call?.argument).toBe(`{ value: "real" }`)
      }
    }
  })

  it.each([
    "if (ready) {}",
    "while (ready) {}",
    "for (; false;) {}",
    "try {} catch (error) {}",
    "try {} finally {}",
    "if (ready) {} else {}",
    "{}",
    "function task() {}",
    "function task<T>() {}",
    "function task<T = Array<string>>() {}",
    "function task<T extends { subject: string }>() {}",
    "function task<T extends () => string>() {}",
    "class Task<T> {}",
    "class Task<T> extends Base {}",
    'class Task<T> extends registry["class<U>"] {}',
    "class Task<T> extends registry.class<U> {}",
    "class Task<T = Array<string>> {}",
    "class Task<T extends { subject: string }> {}",
    "class Task<T extends () => string> {}",
    "const marker = 1\nfunction task() {}",
    "prepare()\nfunction task() {}",
    "function task(): void {}",
    "class Task {}",
    "obj . export\nclass Task {}",
    "obj /* gap */ . /* name */ declare\nclass Task {}",
    "@dec\nclass Task {}",
    "@dec()\nclass Task {}",
    "@factory().dec\nclass Task {}",
    "@factory.dec().next\nclass Task {}",
    "@(factory().dec)\nclass Task {}",
    "@(factory.dec().next)\nclass Task {}",
  ])("scans a regex statement after a closed block: %s", (statement) => {
    const value = `${statement} /['"]/u.test(value)`
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
    const call = findDefaultExportCall(`${value}\nexport default defineThing({ value: "real" })`, ["defineThing"])
    expect(call?.argument).toBe(`{ value: "real" }`)
  })

  it.each([
    `import "x"`,
    `import { value } from "x"`,
    `import{value}from"x"`,
    `import { "value" as value } from "x"`,
    `import "x" with { type: "json" }`,
    `export{value}from"x"`,
    `export*from"x"`,
    `export { value } from "x"`,
    `export * from "x"`,
    `const value = 1; export { value }`,
    "interface Task {}",
    "enum Task {}",
    "namespace Task {}",
    "type Task = {}",
  ])("scans a regex after module and TypeScript declarations: %s", (statement) => {
    const value = `${statement}\n/['"]/u.test(value)`
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
    const call = findDefaultExportCall(`${value}\nexport default defineThing({ value: "real" })`, ["defineThing"])
    expect(call?.argument).toBe(`{ value: "real" }`)
  })

  it.each([
    "export @dec class Task {}",
    "export default @dec class Task {}",
    "export @dec() class Task {}",
    "export @factory().dec class Task {}",
    "export default @(factory().dec) class Task {}",
  ])("scans a regex after an exported decorated class: %s", (statement) => {
    const value = `${statement}\n/['"]/u.test(value)`
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
    const calls = findIdentifierCalls(`${value}\nconst definition = defineThing({ value: "real" })`, "defineThing")
    expect(calls[0]?.arguments[0]).toBe(`{ value: "real" }`)
  })

  it.each([
    "const value = {} / total",
    `const value = "x"\n/ total`,
    `import "x"\nconst value = from\n"y"\n/ total`,
    `import "x"\n{ value }\nfrom\n"y"\n/ total`,
    `const value = 1; export { value }\n"y"\n/ total`,
    `obj.\nimport\n{ value }\nfrom\n"x"\n/ total`,
    `import("x")\n/ total`,
    `const value = {} as Task / total`,
    `const value = {} satisfies Task / total`,
    "const value = function task() {} / total",
    "const value = function task<T>() {} / total",
    "const value = class Task<T> {} / total",
    "const value = (() => {}) / total",
    "const value = class Task {} / total",
    "const value =\nfunction task() {} / total",
    "const value = function task(): void {} / total",
    "const value =\nclass Task {} / total",
    "const value = typeof\nfunction task() {} / total",
    "const docs = `example\nfunction fake(): type\n`\nconst value = {} / total",
    "const value = énew / total",
    "const value = 𐐀return / total",
    "const value = a\u200Cvoid / total",
    "const text = `x${{} / total}`",
    "const text = `x${ /* object */ {} / total}`",
    "const value = @dec\nclass Task {} / total",
    "const value =\n@dec\nclass Task {} / total",
    "const value = @(factory().dec)\nclass Task {} / total",
    "const value = @(factory.dec().next)\nclass Task {} / total",
    "promise.catch(handler) / total",
    "control.for(handler) / total",
    "control.if(handler) / total",
    "control.with(handler) / total",
    "control.while(handler) / total",
    "promise?.catch(handler) / total",
    "promise /* gap */ . /* name */ catch(handler) / total",
    "promise . catch(handler) / total",
    "obj.extends / total",
    "obj . extends / total",
    "obj /* gap */ . /* name */ extends / total",
  ])("preserves division after complete expressions: %s", (value) => {
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
    const call = findDefaultExportCall(`${value}\nexport default defineThing({ value: "real" })`, ["defineThing"])
    expect(call?.argument).toBe(`{ value: "real" }`)
  })

  it("preserves division in a default-exported expression", () => {
    const value = `export default "x"\n/ total`
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
    const calls = findIdentifierCalls(`${value}\nconst definition = defineThing({ value: "real" })`, "defineThing")
    expect(calls[0]?.arguments[0]).toBe(`{ value: "real" }`)
  })

  it("shares regex classifications across repeated declarations", () => {
    const value = Array.from({ length: 200 }, (_, index) => `function task${index}(): void {} /['"]/u.test(value)`).join("\n")
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
    const call = findDefaultExportCall(`${value}\nexport default defineThing({ value: "real" })`, ["defineThing"])
    expect(call?.argument).toBe(`{ value: "real" }`)
  }, 1_000)

  it("shares regex classifications inside large definition arguments", () => {
    const body = Array.from({ length: 200 }, (_, index) => `function f${index}() {} /x/.test('x')`).join("\n")
    const argument = `{ handler() {\n${body}\n}, value: "real" }`
    const call = findDefaultExportCall(`export default defineThing(${argument})`, ["defineThing"])
    expect(call?.argument).toBe(argument)
  }, 1_000)

  it.each([
    "for (é of /['\"]/u) {}",
    "for (const x of /['\"]/u) {}",
    "for await (const x of /['\"]/u) {}",
    "for // loop\n(const [x = f()] of // list\n /['\"]/u) {}",
  ])("preserves a regex in a for-of expression: %s", (value) => {
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
    const handler = `async () => { ${value} }`
    expect(readObjectProperty(`{ handler: ${handler} /* after */, manual: true }`, "handler")).toBe(handler)
  })

  it.each([
    "of / total",
    "for (of / total; false;) {}",
    "left + + /['\"]/u",
  ])("keeps identifier division and separated unary operators: %s", (value) => {
    expect(stripBoundaryComments(`${value} /* after */`)).toBe(value)
  })

  it.each([
    "for (typeof of / total; false;) {}",
    "for (void of / total; false;) {}",
    "for (éof / total; false;) {}",
    "for (𐐀of / total; false;) {}",
    "for (a\u0301of / total; false;) {}",
    "for (a\u200Cof / total; false;) {}",
    "for (a\u200Dof / total; false;) {}",
    "type of = number; for (value as of / total; false;) {}",
    "type of = number; for (value satisfies of / total; false;) {}",
    "for (left + of / total; false;) {}",
    "for (const value = of / total; false;) {}",
    "for (const value in of / total) {}",
  ])("finds default exports after division from of in loop expressions: %s", (loop) => {
    const call = findDefaultExportCall(`${loop}\nexport default defineThing({ value: "real" })`, ["defineThing"])
    expect(call?.argument).toBe(`{ value: "real" }`)
  })

  it.each([
    "`value: ${count++ / total}`",
    "`value: ${(async () => { for (const x of /['\"]/u) {} })()}`",
  ])("scans contextual slashes inside template expressions: %s", (value) => {
    expect(readObjectProperty(`{ value: ${value} /* after */ }`, "value")).toBe(value)
  })

  it("finds identifier calls outside comments and strings", () => {
    const calls = findIdentifierCalls([
      `const docs = "defineThing('docs')"`,
      `const pattern = /defineThing\\)/`,
      `// defineThing('line-comment')`,
      `/* defineThing('block-comment') */`,
      `export default defineThing<string>("real", { ok: true })`,
    ].join("\n"), "defineThing")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.arguments).toEqual(["\"real\"", "{ ok: true }"])
  })

  it("ignores function declarations with matching names", () => {
    const defineCalls = findIdentifierCalls([
      `function defineThing(value: string) { return value }`,
      `const first = defineThing("real")`,
    ].join("\n"), "defineThing")
    const createCalls = findIdentifierCalls([
      `async function createThing<T>(value: T) { return value }`,
      `const second = createThing<string>("generic")`,
    ].join("\n"), "createThing")
    const streamCalls = findIdentifierCalls([
      `function* streamThing() { yield "ok" }`,
      `const third = streamThing()`,
    ].join("\n"), "streamThing")

    expect(defineCalls).toHaveLength(1)
    expect(defineCalls[0]?.arguments).toEqual(["\"real\""])
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.arguments).toEqual(["\"generic\""])
    expect(streamCalls).toHaveLength(1)
    expect(streamCalls[0]?.arguments).toEqual([""])
  })

  it("ignores method declarations with matching names", () => {
    const calls = findIdentifierCalls([
      `class Fixture {`,
      `  defineThing(value: string) { return value }`,
      `  defineThingWithComment(value: string) /* hint */ { return value }`,
      `}`,
      `const real = defineThing("real")`,
      `const commented = defineThingWithComment("real")`,
    ].join("\n"), "defineThing")
    const commentedCalls = findIdentifierCalls([
      `class Fixture {`,
      `  defineThingWithComment(value: string) /* hint */ { return value }`,
      `}`,
      `const real = defineThingWithComment("real")`,
    ].join("\n"), "defineThingWithComment")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.arguments).toEqual(["\"real\""])
    expect(commentedCalls).toHaveLength(1)
    expect(commentedCalls[0]?.arguments).toEqual(["\"real\""])
  })

  it("keeps generic arrow function commas inside one argument", () => {
    expect(splitTopLevel(`<T, U>(ctx: T) => ctx, { id: "daily" }`)).toEqual([
      `<T, U>(ctx: T) => ctx`,
      `{ id: "daily" }`,
    ])
    expect(splitTopLevel(`<T, U>/* hint */(ctx: T) => ctx, { id: "daily" }`)).toEqual([
      `<T, U>/* hint */(ctx: T) => ctx`,
      `{ id: "daily" }`,
    ])
  })

  it("keeps comparison operators structural while splitting arguments", () => {
    expect(splitTopLevel(`() => a < b, { id: "daily" }`)).toEqual([
      `() => a < b`,
      `{ id: "daily" }`,
    ])
    expect(splitTopLevel(`() => a > b, { id: "daily" }`)).toEqual([
      `() => a > b`,
      `{ id: "daily" }`,
    ])
  })

  it("keeps regex literals non-structural while splitting arguments", () => {
    expect(splitTopLevel(`() => { return /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { return /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`async () => { await /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `async () => { await /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`() => { const ok = foo + /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { const ok = foo + /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`() => { if (ready) /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { if (ready) /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`() => { if ((ready)) /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { if ((ready)) /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`() => { return await /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { return await /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`() => { if /* hint */ (ready) /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { if /* hint */ (ready) /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`() => { if (url === "http://x") /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { if (url === "http://x") /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`() => { if (ready) /* hint */ /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { if (ready) /* hint */ /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`() => { try {} catch (error) /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { try {} catch (error) /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])
  })

  it("ignores member calls with matching names", () => {
    const calls = findIdentifierCalls([
      `logger.defineThing("member")`,
      `logger?.defineThing("optional-member")`,
      `const real = defineThing("real")`,
    ].join("\n"), "defineThing")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.arguments).toEqual(["\"real\""])
  })

  it("finds identifier calls separated from parentheses by comments", () => {
    const calls = findIdentifierCalls([
      `const first = defineThing/* @__PURE__ */("commented")`,
      `const second = defineThing<string>// generic hint`,
      `("generic")`,
    ].join("\n"), "defineThing")

    expect(calls).toHaveLength(2)
    expect(calls[0]?.arguments).toEqual(["\"commented\""])
    expect(calls[1]?.arguments).toEqual(["\"generic\""])
  })

  it("does not treat division operators as regex literals after identifiers", () => {
    expect(splitTopLevel(`() => { const ratio = a / b }, { id: "daily" }`)).toEqual([
      `() => { const ratio = a / b }`,
      `{ id: "daily" }`,
    ])
  })

  it("keeps nested template literals non-structural while splitting arguments", () => {
    expect(splitTopLevel("() => `x ${`y)`}` , { id: \"daily\" }")).toEqual([
      "() => `x ${`y)`}`",
      "{ id: \"daily\" }",
    ])
  })

  it("keeps regex literals inside template expressions non-structural", () => {
    const call = findDefaultExportCall([
      `export default defineThing({`,
      "  handler: () => `${/}``/.test(\"}\")}` ,",
      `  value: "real",`,
      `})`,
    ].join("\n"), ["defineThing"])

    expect(call).toMatchObject({
      name: "defineThing",
    })
    expect(readObjectProperty(call!.argument, "value")).toBe(`"real"`)
  })

  it("scans control-flow regex literals inside template expressions without recursion", () => {
    const call = findDefaultExportCall([
      `export default defineThing({`,
      "  handler: () => `${(() => { if (ready) /\\}/.test(\"}\") })()}` ,",
      `  value: "real",`,
      `})`,
    ].join("\n"), ["defineThing"])

    expect(call).toMatchObject({ name: "defineThing" })
    expect(readObjectProperty(call!.argument, "value")).toBe(`"real"`)
  })

  it("does not repeatedly rescan control-flow regex literals inside template expressions", () => {
    const checks = Array.from({ length: 12 }, (_, index) => `if (ready${index}) /\\}/.test("}")`).join("; ")
    const call = findDefaultExportCall([
      `export default defineThing({`,
      `  handler: () => \`${"${"}(() => { ${checks} })()}\` ,`,
      `  value: "real",`,
      `})`,
    ].join("\n"), ["defineThing"])

    expect(call).toMatchObject({ name: "defineThing" })
    expect(readObjectProperty(call!.argument, "value")).toBe(`"real"`)
  })

  it("shares regex classifications while matching nested template conditions", () => {
    const call = findDefaultExportCall([
      `export default defineThing({`,
      "  handler: () => `${(() => { if (`${(() => { if (inner) /\\}/.test(\"}\") })()}`) /\\}/.test(\"}\") })()}` ,",
      `  value: "real",`,
      `})`,
    ].join("\n"), ["defineThing"])

    expect(call).toMatchObject({ name: "defineThing" })
    expect(readObjectProperty(call!.argument, "value")).toBe(`"real"`)
  })

  it("finds default-exported definition calls", () => {
    const call = findDefaultExportCall([
      `const ignored = defineThing({ value: "ignored" })`,
      `export default (defineThing<{ value: string }>({`,
      `  value: "real",`,
      `}))`,
    ].join("\n"), ["defineThing"])

    expect(call).toMatchObject({
      argument: `{\n  value: "real",\n}`,
      name: "defineThing",
    })
  })

  it("preserves source offsets after astral Unicode characters", () => {
    const call = findDefaultExportCall([
      `// 😀`,
      `export default defineThing({ value: "real" })`,
    ].join("\n"), ["defineThing"])

    expect(call).toMatchObject({
      argument: `{ value: "real" }`,
      name: "defineThing",
    })
  })

  it("finds default exports after regex literals followed by division", () => {
    const call = findDefaultExportCall([
      `const value = /x/ / parts`,
      `export default defineThing({ value: "real" })`,
    ].join("\n"), ["defineThing"])

    expect(call?.argument).toBe(`{ value: "real" }`)
  })

  it("finds default exports after division from keyword-named members", () => {
    const call = findDefaultExportCall([
      `const value = metrics.return / total`,
      `export default defineThing({ value: "real" })`,
    ].join("\n"), ["defineThing"])

    expect(call?.argument).toBe(`{ value: "real" }`)
  })

  it("finds default exports with division after literals", () => {
    const call = findDefaultExportCall([
      `export default defineThing({`,
      `  handler: () => "ok" / total,`,
      `  value: "real",`,
      `})`,
    ].join("\n"), ["defineThing"])

    expect(readObjectProperty(call!.argument, "value")).toBe(`"real"`)
  })

  it("finds default-exported object literals with TypeScript assertions", () => {
    for (const suffix of ["as const", "satisfies ThingOptions"]) {
      const call = findDefaultExportCall(
        `export default defineThing({ value: "real" } ${suffix})`,
        ["defineThing"],
      )

      expect(call?.argument).toBe(`{ value: "real" }`)
    }
  })

  it("finds positional options with nested parentheses and assertions", () => {
    for (const suffix of ["as const", "satisfies ThingOptions", "as Types.Options", "as const satisfies ThingOptions"]) {
      for (const argument of [
        `{ manual: true } ${suffix}`,
        `({ manual: true } ${suffix})`,
        `(({ manual: true }) ${suffix})`,
        `(/* options */ ({ manual: true }) /* assertion */ ${suffix} /* end */)`,
      ]) {
        const call = findDefaultExportCall(
          `export default defineThing("cron", handler, ${argument})`,
          ["defineThing"],
          { positionalOptionsIndex: 2 },
        )
        expect(call?.argument, argument).toBe("{ manual: true }")
      }
    }
  })

  it("rejects positional options with trailing expression material", () => {
    for (const suffix of [
      "as const && false",
      "as const || false",
      "as const ?? false",
      "as const + 1",
      "as const - 1",
      "as Options - Other",
      "as const * 2",
      "as const / 2",
      "as const > false",
      "as const === false",
      "as const instanceof Options",
      "as const & false",
      "as const | false",
      "as const ? false : true",
      "as Options()",
      "satisfies Options, false",
      "as",
      "satisfies",
    ]) {
      for (const argument of [
        `{ manual: true } ${suffix}`,
        `({ manual: true } ${suffix})`,
        `(({ manual: true }) ${suffix})`,
      ]) {
        const call = findDefaultExportCall(
          `export default defineThing("cron", handler, (${argument}))`,
          ["defineThing"],
          { positionalOptionsIndex: 2 },
        )
        expect(call, argument).toBeUndefined()
      }
    }
  })

  it("reads top-level object properties without matching nested values", () => {
    expect(readObjectProperty(`{ nested: { cron: "wrong" }, cron: "0 8 * * *" }`, "cron"))
      .toBe(`"0 8 * * *"`)
  })

  it.each([
    '"https://example.com"',
    "'/* marker */'",
    String.raw`/https?:\/\//`,
    "`https://${host}/**`",
    '"start" /* keep */ + "https://example.com"',
  ])("preserves literal comment markers in definition values: %s", (value) => {
    const object = `{ value: /* before */ ${value} /* after */ }`
    expect(readObjectProperty(object, "value")).toBe(value)

    const definition = findDefaultExportCall(
      `export default defineThing(/* options */ ${object} /* end */)`,
      ["defineThing"],
    )
    expect(definition?.argument).toBe(object)
  })

  it.each(["\r", "\u2028", "\u2029"])("ends boundary line comments at %j", (lineEnding) => {
    const object = `{ value: // before${lineEnding} "real" // after${lineEnding}}`
    const definition = findDefaultExportCall(
      `export default defineThing(// options${lineEnding}${object} // end${lineEnding})`,
      ["defineThing"],
    )
    expect(definition?.argument).toBe(object)
    expect(readObjectProperty(`// options${lineEnding}${object} // end`, "value")).toBe('"real"')

    const withControlFlow = findDefaultExportCall([
      "export default defineThing({",
      "  handler: () => { // condition hint",
      '    if (ready) /\\)/.test(")")',
      "  },",
      '  value: "real",',
      "})",
    ].join(lineEnding), ["defineThing"])
    expect(readObjectProperty(withControlFlow?.argument || "", "value")).toBe('"real"')
  })

  it.each([
    "manual: true",
    "manual",
    "get /* option */ 'manual'() { return true }",
    'set "manual"(value) {}',
    'async "manual"() {}',
    "*'manual'() {}",
  ])("finds a property regardless of member syntax: %s", (member) => {
    expect(readObjectPropertyNames(`{ ${member} }`)).toEqual(["manual"])
  })

  it("does not report properties inside another member", () => {
    expect(readObjectPropertyNames(`{ nested: { manual: true }, handler() { const manual = true }, /* trailing */ }`)).toEqual(["nested", "handler"])
    expect(readObjectProperty(`{ get manual() { return true }, manual: false }`, "manual")).toBe("false")
  })

  it.each(["é", "𐐀", "a\u0301", "manualé", "manual\u200C", "allowRuntimeSchedules\u200D"])("reads a Unicode identifier key: %s", (name) => {
    expect(readObjectPropertyNames(`{ ${name}: true }`)).toEqual([name])
    expect(readObjectProperty(`{ ${name}: true }`, name)).toBe("true")
    expect(readObjectPropertyNames(`{ get ${name}() {}, async ${name}() {} }`)).toEqual([name, name])
  })

  it.each(["0x2a", "1e2", "1_000", ".5", "1.5", "1e+2", "1e-2", "1.", "1_000.5_2", "0b1010", "0o52", "42n"])("preserves numeric key spelling: %s", (name) => {
    expect(readObjectPropertyNames(`{ ${name}: true }`)).toEqual([name])
    expect(readObjectProperty(`{ ${name}: true }`, name)).toBe("true")
    expect(readObjectPropertyNames(`{ get ${name}() {}, async ${name}() {} }`)).toEqual([name, name])
  })

  it.each(["1manual", "1e+", "1__0", "0xg"])("reports an unresolved numeric key spelling: %s", (name) => {
    expect(readObjectPropertyNames(`{ ${name}: true }`)).toEqual([undefined])
  })

  it("reports unresolved keys without evaluating them", () => {
    expect(readObjectPropertyNames(String.raw`{ get ["manual"]() {}, "manu\u0061l": true, ...options }`)).toEqual([undefined, undefined, undefined])
  })
})
