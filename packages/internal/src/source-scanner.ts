export interface IdentifierCall {
  arguments: string[]
  closeParen: number
  name: string
  openParen: number
  start: number
}

export interface DefaultExportCall extends IdentifierCall {
  argument: string
}

function isQuote(char: string | undefined) {
  return char === "\"" || char === "'" || char === "`"
}

type ControlFlowRegexCache = Map<number, boolean | undefined>

function skipQuoted(source: string, index: number, controlFlowRegexes = new Map<number, boolean | undefined>()) {
  const quote = source[index]
  if (quote === "`") return skipTemplateLiteral(source, index, controlFlowRegexes)
  index += 1
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2
      continue
    }
    if (source[index] === quote) {
      return index + 1
    }
    index += 1
  }
  return index
}

function skipTemplateLiteral(source: string, index: number, controlFlowRegexes: ControlFlowRegexCache): number {
  index += 1
  let expressionDepth = 0
  let previousSignificant = ""
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === "\\") {
      index += 2
      continue
    }
    if (expressionDepth === 0) {
      if (char === "`") return index + 1
      if (char === "$" && next === "{") {
        expressionDepth = 1
        previousSignificant = "{"
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (char === "\"" || char === "'") {
      index = skipQuoted(source, index, controlFlowRegexes)
      previousSignificant = "literal"
      continue
    }
    if (char === "`") {
      index = skipTemplateLiteral(source, index, controlFlowRegexes)
      previousSignificant = "literal"
      continue
    }
    if (char === "/" && next === "/") {
      index = skipLineComment(source, index)
      continue
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(source, index)
      continue
    }
    if (char === "/" && (isRegexLiteralStart(source, index, previousSignificant, controlFlowRegexes) || isControlFlowRegexStart(source, index, controlFlowRegexes))) {
      index = skipRegexLiteral(source, index)
      previousSignificant = "literal"
      continue
    }
    if (char === "{") expressionDepth += 1
    if (char === "}") expressionDepth -= 1
    previousSignificant = trackSignificant(previousSignificant, char)
    index += 1
  }
  return index
}

function isLineTerminator(char: string | undefined) {
  return char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029"
}

function skipLineComment(source: string, index: number) {
  for (let current = index + 2; current < source.length; current++) {
    if (isLineTerminator(source[current])) return current + 1
  }
  return source.length
}

function skipBlockComment(source: string, index: number) {
  const end = source.indexOf("*/", index + 2)
  return end === -1 ? source.length : end + 2
}

function isIdentifierChar(char: string | undefined) {
  return !!char && /[\w$]/.test(char)
}

function isRegexLiteralStart(source: string, index: number, previousSignificant: string, controlFlowRegexes: ControlFlowRegexCache = new Map()): boolean {
  const token = previousSignificant.trimEnd()
  if (/^\.[\w$]+$/.test(token)) return false
  if (token === "+" || token === "-" || token === "of") {
    const cached = controlFlowRegexes.get(index)
    if (cached !== undefined) return cached
    if (controlFlowRegexes.has(index)) return true
    controlFlowRegexes.set(index, undefined)
    try {
      const previous = previousCodeIndex(source, index - 1, controlFlowRegexes)
      const result = token === "of"
        ? isLabeledStatementRegexStart(source, index, previous, controlFlowRegexes) || isForOfRegexStart(source, index, controlFlowRegexes)
        : !endsWithPostfixUpdate(source, previous, token)
      controlFlowRegexes.set(index, result)
      return result
    }
    catch (error) {
      controlFlowRegexes.delete(index)
      throw error
    }
  }
  if (!token || token === "/" || /[({[=,:!&|?;<>+\-*%^~]/.test(token)) return true
  if (token === ".") {
    const end = previousCodeIndex(source, index - 1, controlFlowRegexes)
    return source.slice(end - 2, end + 1) === "..."
  }
  const keyword = /\b(?:await|break|case|continue|debugger|delete|do|else|extends|in|instanceof|new|return|throw|typeof|void|yield)$/.exec(token)?.[0]
  if (!keyword) return false
  const end = previousCodeIndex(source, index - 1, controlFlowRegexes)
  const start = end - keyword.length + 1
  return source.slice(start, end + 1) === keyword && !/[$\p{ID_Continue}\u200C\u200D]$/u.test(source.slice(0, start))
}

function endsWithPostfixUpdate(source: string, index: number, sign: string) {
  let count = 0
  while (source[index - count] === sign) count += 1
  // Update operators consume pairs; an odd trailing sign starts a new expression.
  return count > 0 && count % 2 === 0
}

function isForOfRegexStart(source: string, index: number, controlFlowRegexes: ControlFlowRegexCache): boolean {
  const operatorEnd = previousCodeIndex(source, index - 1, controlFlowRegexes)
  if (!/(?:^|[^$\p{ID_Continue}\u200C\u200D])of$/u.test(source.slice(0, operatorEnd + 1))) return false
  let current = previousCodeIndex(source, operatorEnd - 2, controlFlowRegexes)
  if (!/(?:[$\p{ID_Continue}\])}]|\u200C|\u200D)$/u.test(source.slice(0, current + 1))) return false
  const word = /[$\p{ID_Continue}\u200C\u200D]+$/u.exec(source.slice(0, current + 1))?.[0]
  if (word && /^(?:as|satisfies|const|let|var|in|instanceof|typeof|void|delete|await|yield|new)$/.test(word)
    && source[previousCodeIndex(source, current - word.length, controlFlowRegexes)] !== ".") return false

  while (current >= 0) {
    const char = source[current]
    if (char === ";" || char === "{") return false
    if (char === "(") {
      let headEnd = previousCodeIndex(source, current - 1, controlFlowRegexes)
      if (/\bawait$/.test(source.slice(0, headEnd + 1))) {
        headEnd = previousCodeIndex(source, headEnd - 5, controlFlowRegexes)
      }
      return /(?:^|[^$\p{ID_Continue}\u200C\u200D])for$/u.test(source.slice(0, headEnd + 1))
    }
    const open = char === ")" ? "(" : char === "]" ? "[" : char === "}" ? "{" : undefined
    if (open) {
      let start = current - 1
      while (start >= 0 && (source[start] !== open || findMatching(source, start, open, char, controlFlowRegexes) !== current)) start -= 1
      if (start < 0) return false
      current = start
    }
    current = previousCodeIndex(source, current - 1, controlFlowRegexes)
  }
  return false
}

function findLineCommentStart(source: string, start: number, end: number, controlFlowRegexes: ControlFlowRegexCache) {
  for (let index = start; index <= end;) {
    const char = source[index]
    const next = source[index + 1]
    if (isQuote(char)) {
      index = skipQuoted(source, index, controlFlowRegexes)
      continue
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(source, index)
      continue
    }
    if (char === "/" && next === "/") return index
    index += 1
  }
  return -1
}

function previousCodeIndex(source: string, index: number, controlFlowRegexes: ControlFlowRegexCache) {
  let current = index
  while (current >= 0) {
    while (/\s/.test(source[current] ?? "")) current--
    if (source[current] === "/" && source[current - 1] === "*") {
      const start = source.lastIndexOf("/*", current - 2)
      if (start === -1) return current
      current = start - 1
      continue
    }
    let lineStart = current
    while (lineStart > 0 && !isLineTerminator(source[lineStart - 1])) lineStart -= 1
    const lineComment = findLineCommentStart(source, lineStart, current, controlFlowRegexes)
    if (lineComment !== -1 && lineComment <= current) {
      current = lineComment - 1
      continue
    }
    return current
  }
  return current
}

function isControlFlowRegexStart(source: string, index: number, controlFlowRegexes = new Map<number, boolean | undefined>()) {
  const cached = controlFlowRegexes.get(index)
  if (cached !== undefined) return cached
  // A template rescan can revisit the slash whose classification initiated it; treating that candidate as a regex breaks the cycle while completed classifications prevent repeated rescans.
  if (controlFlowRegexes.has(index)) return true
  controlFlowRegexes.set(index, undefined)
  try {
    const closeParen = previousCodeIndex(source, index - 1, controlFlowRegexes)
    if (isModuleDeclarationRegexStart(source, index, closeParen, controlFlowRegexes)
      || isLabeledStatementRegexStart(source, index, closeParen, controlFlowRegexes)) {
      controlFlowRegexes.set(index, true)
      return true
    }
    if (source[closeParen] === "}") {
      const result = isStatementBlockRegexStart(source, closeParen, controlFlowRegexes)
      controlFlowRegexes.set(index, result)
      return result
    }
    if (source[closeParen] !== ")") {
      controlFlowRegexes.set(index, false)
      return false
    }

    for (let current = closeParen; current >= 0; current--) {
      if (source[current] !== "(") continue
      if (findMatching(source, current, "(", ")", controlFlowRegexes) !== closeParen) continue
      const head = source.slice(0, current).replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*/g, " ")
      const control = /(?:catch|for|if|while|with)\s*$/.exec(head)
      const controlPrefix = control ? head.slice(0, control.index) : ""
      const result = !!control && !/[$\p{ID_Continue}\u200C\u200D]$/u.test(controlPrefix) && !controlPrefix.trimEnd().endsWith(".")
        || source[index] === "{" && (/(?:^|[^\w$])switch\s*$/.test(head)
          || /(?:^|[;{}])\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*(?:[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*)?\s*$/u.test(head))
      controlFlowRegexes.set(index, result)
      return result
    }

    controlFlowRegexes.set(index, false)
    return false
  }
  catch (error) {
    controlFlowRegexes.delete(index)
    throw error
  }
}

function isStatementBlockRegexStart(source: string, closeBrace: number, controlFlowRegexes: ControlFlowRegexCache): boolean {
  for (let openBrace = closeBrace - 1; openBrace >= 0; openBrace--) {
    if (source[openBrace] !== "{" || findMatching(source, openBrace, "{", "}", controlFlowRegexes) !== closeBrace) continue
    const previous = previousCodeIndex(source, openBrace - 1, controlFlowRegexes)
    if (source[previous] === "{" && source[previous - 1] === "$") return false
    if (previous < 0 || /[;{}]/.test(source[previous] ?? "")) return true
    const head = source.slice(0, previous + 1)
    if (/(?:^|[^$\p{ID_Continue}\u200C\u200D])(?:do|else|finally|try)$/u.test(head)) return true
    if (isDeclarationBlockStart(source, openBrace, controlFlowRegexes)) return true
    return isControlFlowRegexStart(source, openBrace, controlFlowRegexes)
  }
  return false
}

function isDeclarationBlockStart(source: string, openBrace: number, controlFlowRegexes: ControlFlowRegexCache) {
  const head = source.slice(0, openBrace).replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*/g, comment => comment.replace(/[^\r\n\u2028\u2029]/g, " "))
  const declaration = /(?:^|[;{}\s])\s*(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function\s*\*?\s*(?:[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*)?\s*\([^{}]*\)(?:\s*:[^;{}]+)?|(?:interface|enum|namespace)\s+[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*(?:\s+extends\s+[^;{}]+)?|type\s+[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*\s*=\s*|class(?:\s+[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*)?(?:\s+extends\s+[^;{}]+)?)\s*$/u.exec(head)
  if (!declaration) return false
  const before = declarationPrefix(source, head, declaration.index, controlFlowRegexes).replace(/(?:^|\s)export(?:\s+default)?$/, "").trimEnd()
  if (/[=([,:?!&|+\-*/%^~<>.]$/.test(before)) return false
  if (/(?:^|[^.$\p{ID_Continue}\u200C\u200D])(?:await|delete|in|instanceof|new|typeof|void)$/u.test(before)) return false
  const keyword = /\b(?:class|function|interface|enum|namespace|type)\b/.exec(declaration[0])
  if (!keyword) return false
  const keywordStart = declaration.index + keyword.index
  return maskSourceLiteralsWithContext(source.slice(0, keywordStart + keyword[0].length), controlFlowRegexes).slice(keywordStart) === keyword[0]
}

function declarationPrefix(source: string, head: string, offset: number, controlFlowRegexes: ControlFlowRegexCache) {
  let end = previousCodeIndex(source, offset - 1, controlFlowRegexes) + 1
  while (end > 0) {
    let decoratorEnd = end
    let decoratorStart = -1
    while (decoratorEnd > 0) {
      if (source[decoratorEnd - 1] === "@") {
        decoratorStart = decoratorEnd - 1
        break
      }
      if (source[decoratorEnd - 1] === ")") {
        let openParen = decoratorEnd - 2
        while (openParen >= 0 && (source[openParen] !== "(" || findMatching(source, openParen, "(", ")", controlFlowRegexes) !== decoratorEnd - 1)) openParen -= 1
        if (openParen < 0) break
        decoratorEnd = previousCodeIndex(source, openParen - 1, controlFlowRegexes) + 1
        continue
      }
      const identifier = /[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*$/u.exec(head.slice(0, decoratorEnd))
      if (!identifier) break
      const previous = previousCodeIndex(source, identifier.index - 1, controlFlowRegexes)
      if (source[previous] === "@") {
        decoratorStart = previous
        break
      }
      if (source[previous] !== ".") break
      decoratorEnd = previousCodeIndex(source, previous - 1, controlFlowRegexes) + 1
    }
    if (decoratorStart < 0) break
    end = previousCodeIndex(source, decoratorStart - 1, controlFlowRegexes) + 1
  }
  return head.slice(0, end).trimEnd()
}

function isModuleDeclarationRegexStart(source: string, index: number, end: number, controlFlowRegexes: ControlFlowRegexCache) {
  if (source[end] !== "'" && source[end] !== "\"") return false
  if (!/[\r\n\u2028\u2029]/.test(source.slice(end + 1, index))) return false
  const head = source.slice(0, end + 1)
  const declaration = /(?:^|[;{}\r\n\u2028\u2029])\s*(?:import\s*(?:(?:[^;'"=()]*?)\s+from\s*)?|export\s+[^;'"=()]*?\s+from\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/u.exec(head)
  if (!declaration) return false
  const keyword = /\b(?:import|export)\b/.exec(declaration[0])!
  const start = declaration.index + keyword.index
  return maskSourceLiteralsWithContext(source.slice(0, start + keyword[0].length), controlFlowRegexes).slice(start) === keyword[0]
}

function isLabeledStatementRegexStart(source: string, index: number, labelEnd: number, controlFlowRegexes: ControlFlowRegexCache) {
  if (!/[\r\n\u2028\u2029]/.test(source.slice(labelEnd + 1, index))) return false
  const label = /[$\p{ID_Continue}\u200C\u200D]+$/u.exec(source.slice(0, labelEnd + 1))?.[0]
  if (!label) return false
  const labelStart = labelEnd - label.length + 1
  const statementEnd = previousCodeIndex(source, labelStart - 1, controlFlowRegexes)
  if (/[\r\n\u2028\u2029]/.test(source.slice(statementEnd + 1, labelStart))) return false
  return /(?:^|[^$\p{ID_Continue}\u200C\u200D])(?:break|continue)$/u.test(source.slice(0, statementEnd + 1))
}

function skipRegexLiteral(source: string, index: number) {
  index += 1
  while (index < source.length) {
    const char = source[index]
    if (char === "\\") {
      index += 2
      continue
    }
    if (char === "[") {
      index += 1
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2
          continue
        }
        if (source[index] === "]") break
        index += 1
      }
    }
    if (char === "/") {
      index += 1
      while (/[a-z]/i.test(source[index] ?? "")) index += 1
      return index
    }
    index += 1
  }
  return index
}

function trackSignificant(previousSignificant: string, char: string | undefined) {
  if (/[a-z$]/i.test(char ?? "")) {
    return /[\w$]$/.test(previousSignificant) || previousSignificant === "."
      ? previousSignificant + char
      : char ?? ""
  }
  if (/\s/.test(char ?? "")) {
    return /[\w$]$/.test(previousSignificant) ? `${previousSignificant} ` : previousSignificant
  }
  if (!/\s/.test(char ?? "")) {
    return char ?? ""
  }
  return previousSignificant
}

function isFunctionDeclarationName(source: string, index: number) {
  return /(?:^|[^\w$])(?:async\s+)?function\s*\*?\s*$/.test(source.slice(0, index))
}

function previousNonWhitespace(source: string, index: number) {
  let current = index - 1
  while (/\s/.test(source[current] ?? "")) current -= 1
  return source[current]
}

function nextNonWhitespace(source: string, index: number) {
  return source[skipWhitespaceAndComments(source, index)]
}

function skipWhitespaceAndComments(source: string, index: number) {
  while (index < source.length) {
    if (/\s/.test(source[index] ?? "")) {
      index += 1
      continue
    }
    if (source[index] === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index)
      continue
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index)
      continue
    }
    return index
  }
  return index
}

export function stripBoundaryComments(source: string): string {
  const start = skipWhitespaceAndComments(source, 0)
  const controlFlowRegexes: ControlFlowRegexCache = new Map()
  let end = start
  let previousSignificant = ""
  for (let index = start; index < source.length;) {
    const char = source[index]
    const next = source[index + 1]
    if (/\s/.test(char ?? "")) {
      previousSignificant = trackSignificant(previousSignificant, char)
      index += 1
      continue
    }
    if (char === "/" && next === "/") {
      index = skipLineComment(source, index)
      continue
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(source, index)
      continue
    }
    if (isQuote(char)) {
      index = skipQuoted(source, index, controlFlowRegexes)
      previousSignificant = "literal"
    }
    else if (char === "/" && (isRegexLiteralStart(source, index, previousSignificant, controlFlowRegexes) || isControlFlowRegexStart(source, index, controlFlowRegexes))) {
      index = skipRegexLiteral(source, index)
      previousSignificant = "literal"
    }
    else {
      previousSignificant = trackSignificant(previousSignificant, char)
      index += 1
    }
    end = index
  }
  return source.slice(start, end)
}

export function maskSourceLiterals(source: string): string {
  return maskSourceLiteralsWithContext(source, new Map<number, boolean | undefined>())
}

function maskSourceLiteralsWithContext(source: string, controlFlowRegexes: ControlFlowRegexCache): string {
  const output = source.split("")
  let previousSignificant = ""
  const mask = (start: number, end: number) => {
    for (let index = start; index < end; index++) {
      if (!isLineTerminator(output[index])) output[index] = " "
    }
  }

  for (let index = 0; index < source.length;) {
    const char = source[index]
    const next = source[index + 1]
    let end: number | undefined
    if (isQuote(char)) {
      end = skipQuoted(source, index, controlFlowRegexes)
      previousSignificant = "literal"
    }
    else if (char === "/" && next === "/") end = skipLineComment(source, index)
    else if (char === "/" && next === "*") end = skipBlockComment(source, index)
    else if (char === "/" && (isRegexLiteralStart(source, index, previousSignificant, controlFlowRegexes) || isControlFlowRegexStart(source, index, controlFlowRegexes))) {
      end = skipRegexLiteral(source, index)
      previousSignificant = "literal"
    }
    if (end !== undefined) {
      mask(index, end)
      index = end
      continue
    }
    previousSignificant = trackSignificant(previousSignificant, char)
    index += 1
  }
  return output.join("")
}

function isMethodDeclarationName(source: string, index: number, closeParen: number) {
  const previous = previousNonWhitespace(source, index)
  return source[skipWhitespaceAndComments(source, closeParen + 1)] === "{"
    && previous !== "("
    && previous !== "="
    && previous !== ","
    && previous !== ":"
}

function isMemberAccessName(source: string, index: number) {
  return previousNonWhitespace(source, index) === "."
}

export function findMatching(source: string, index: number, open: string, close: string, controlFlowRegexes = new Map<number, boolean | undefined>()): number | undefined {
  let depth = 0
  let previousSignificant = ""
  for (let current = index; current < source.length; current++) {
    const char = source[current]
    const next = source[current + 1]
    if (isQuote(char)) {
      current = skipQuoted(source, current, controlFlowRegexes) - 1
      previousSignificant = "literal"
      continue
    }
    if (char === "/" && next === "/") {
      current = skipLineComment(source, current) - 1
      continue
    }
    if (char === "/" && next === "*") {
      current = skipBlockComment(source, current) - 1
      continue
    }
    if (char === "/" && (isRegexLiteralStart(source, current, previousSignificant, controlFlowRegexes) || isControlFlowRegexStart(source, current, controlFlowRegexes))) {
      current = skipRegexLiteral(source, current) - 1
      previousSignificant = "literal"
      continue
    }
    if (char === open) {
      depth += 1
      previousSignificant = char
      continue
    }
    if (char === close && !(open === "<" && close === ">" && source[current - 1] === "=")) {
      depth -= 1
      if (depth === 0) return current
      previousSignificant = char
      continue
    }
    previousSignificant = trackSignificant(previousSignificant, char)
  }
}

export function splitTopLevel(source: string, separator = ",") {
  const parts: string[] = []
  const controlFlowRegexes: ControlFlowRegexCache = new Map()
  let depth = 0
  let previousSignificant = ""
  let start = 0
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]
    if (isQuote(char)) {
      index = skipQuoted(source, index, controlFlowRegexes) - 1
      previousSignificant = "literal"
      continue
    }
    if (char === "/" && next === "/") {
      index = skipLineComment(source, index) - 1
      continue
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(source, index) - 1
      continue
    }
    if (char === "/" && (isRegexLiteralStart(source, index, previousSignificant, controlFlowRegexes) || isControlFlowRegexStart(source, index, controlFlowRegexes))) {
      index = skipRegexLiteral(source, index) - 1
      previousSignificant = "literal"
      continue
    }
    if (char === "<") {
      const genericEnd = findMatching(source, index, "<", ">", controlFlowRegexes)
      if (genericEnd !== undefined && nextNonWhitespace(source, genericEnd + 1) === "(") {
        index = genericEnd
        previousSignificant = ">"
        continue
      }
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1
      previousSignificant = char
      continue
    }
    if (char === ")" || char === "}" || char === "]") {
      depth -= 1
      previousSignificant = char
      continue
    }
    if (char === separator && depth === 0) {
      parts.push(source.slice(start, index).trim())
      start = index + 1
      continue
    }
    previousSignificant = trackSignificant(previousSignificant, char)
  }
  parts.push(source.slice(start).trim())
  return parts
}

export function findIdentifierCalls(source: string, name: string): IdentifierCall[] {
  const calls: IdentifierCall[] = []
  const controlFlowRegexes: ControlFlowRegexCache = new Map()
  let previousSignificant = ""
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]
    if (isQuote(char)) {
      index = skipQuoted(source, index, controlFlowRegexes) - 1
      previousSignificant = "literal"
      continue
    }
    if (char === "/" && next === "/") {
      index = skipLineComment(source, index) - 1
      continue
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(source, index) - 1
      continue
    }
    if (char === "/" && (isRegexLiteralStart(source, index, previousSignificant, controlFlowRegexes) || isControlFlowRegexStart(source, index, controlFlowRegexes))) {
      index = skipRegexLiteral(source, index) - 1
      previousSignificant = "literal"
      continue
    }
    if (
      !source.startsWith(name, index)
      || isIdentifierChar(source[index - 1])
      || isIdentifierChar(source[index + name.length])
      || isFunctionDeclarationName(source, index)
      || isMemberAccessName(source, index)
    ) {
      previousSignificant = trackSignificant(previousSignificant, char)
      continue
    }

    let openParen = skipWhitespaceAndComments(source, index + name.length)
    if (source[openParen] === "<") {
      const genericEnd = findMatching(source, openParen, "<", ">", controlFlowRegexes)
      if (genericEnd === undefined) {
        previousSignificant = trackSignificant(previousSignificant, char)
        continue
      }
      openParen = skipWhitespaceAndComments(source, genericEnd + 1)
    }
    if (source[openParen] !== "(") {
      previousSignificant = trackSignificant(previousSignificant, char)
      continue
    }

    const closeParen = findMatching(source, openParen, "(", ")", controlFlowRegexes)
    if (closeParen === undefined) {
      previousSignificant = trackSignificant(previousSignificant, char)
      continue
    }
    if (isMethodDeclarationName(source, index, closeParen)) {
      previousSignificant = trackSignificant(previousSignificant, char)
      continue
    }
    calls.push({
      arguments: splitTopLevel(source.slice(openParen + 1, closeParen)),
      closeParen,
      name,
      openParen,
      start: index,
    })
    previousSignificant = ")"
    index = closeParen
  }
  return calls
}

export function findDefaultExportCall(source: string, names: string[], options: { positionalOptionsIndex?: number } = {}): DefaultExportCall | undefined {
  const masked = maskSourceLiterals(source)
  const calls = names
    .flatMap(name => findIdentifierCalls(source, name))
    .sort((left, right) => left.start - right.start)

  for (const call of calls) {
    // Validate the assertion boundary while leaving TypeScript's type grammar
    // unrestricted (generic, union, indexed-access, `typeof`, etc.). Runtime
    // expression operators after the assertion remain unsupported.
    const isCompleteAssertion = (value: string) => {
      const assertion = /^(?:as|satisfies)\b\s+.+$/is.test(value)
      // Reject runtime operators that can follow an assertion, while allowing
      // punctuation that is valid inside TypeScript type expressions (for
      // example generic arguments and tuple types).
      if (!assertion) return false
      // `const` is a complete assertion type by itself. Any operator after it
      // therefore belongs to the runtime expression (including operators whose
      // right-hand side is an identifier rather than a literal).
      if (/^(?:as\s+const|satisfies\s+const)\b/i.test(value)) {
        const afterConst = value.slice(value.indexOf("const") + 5).trim()
        // `as const satisfies T` is the only suffix permitted after a
        // const assertion; everything else is runtime expression material.
        if (afterConst && !/^satisfies\s+\S[\s\S]*$/i.test(afterConst)) return false
        // A const assertion may only be followed by a complete `satisfies`
        // clause. Any arithmetic (including subtraction with an identifier)
        // changes the runtime value and must remain unsupported.
        if (/(?:&&|\|\||\?\?|=>|\?\.|[+*/?;%=<>-]|,|\||&|\^|\b(?:instanceof|in)\b)/.test(afterConst)) return false
      }
      // Operators and call syntax after an assertion change the runtime value;
      // reject them while retaining union/intersection punctuation in types.
      if (/(?:&&|\|\||\?\?|=>|\?\.|[+*/?;%=]|,)/.test(value)) return false
      // A spaced subtraction after an assertion is runtime syntax. Hyphens
      // inside template-literal types remain allowed because they are not
      // surrounded by operator whitespace.
      if (/\s-\s/.test(value)) return false
      // Identifier operands may omit operator whitespace; this is still
      // runtime subtraction rather than punctuation in a TypeScript type.
      // A subtraction may also use a numeric or otherwise literal operand;
      // reject the operator whenever it follows an identifier in the
      // assertion suffix. Hyphens embedded in template-literal types do not
      // have an identifier directly before the operator boundary.
      if (/\b[A-Za-z_$][\w$]*\s*-\s*(?:[A-Za-z_$\d"'`])/.test(value)) return false
      // Relational operators are spaced; generic/type delimiters are not.
      if (/(?:^|\s)(?:<<|>>>|>>|[<>])(?:=)?(?=\s|[A-Za-z_$\d])/.test(value)) return false
      if (/\b(?:instanceof|in)\b/.test(value)) return false
      // Bitwise operators are runtime expressions; retain type unions and
      // intersections whose right side is a type name, but reject literals.
      if (/(?:\||&|\^)\s*(?:true|false|null|undefined|\d+(?:\.\d+)?|["'`])/.test(value)) return false
      if (/\b[A-Za-z_$][\w$]*\s*\(/.test(value)) return false
      return true
    }
    const firstArgument = stripBoundaryComments(call.arguments[0] || "")
    let callArgument = !firstArgument.startsWith("{") && options.positionalOptionsIndex !== undefined
      ? stripBoundaryComments(call.arguments[options.positionalOptionsIndex] || "{}")
      : firstArgument
    // Positional options are often wrapped in parentheses (and may contain a
    // trailing type assertion). Unwrap only complete boundary parentheses so
    // nested expressions remain intact for object matching below.
    while (callArgument.startsWith("(")) {
      const boundaryEnd = findMatching(callArgument, 0, "(", ")")
      if (boundaryEnd === undefined) break
      const trailing = stripBoundaryComments(callArgument.slice(boundaryEnd + 1))
      if (trailing && !isCompleteAssertion(trailing)) break
      callArgument = stripBoundaryComments(callArgument.slice(1, boundaryEnd))
    }
    if (!callArgument.startsWith("{")) continue
    const objectEnd = findMatching(callArgument, 0, "{", "}")
    if (objectEnd === undefined) continue
    const suffix = stripBoundaryComments(callArgument.slice(objectEnd + 1))
    if (suffix && !isCompleteAssertion(suffix)) continue
    const argument = callArgument.slice(0, objectEnd + 1)
    if (/\bexport\s+default\s*(?:\(\s*)*$/.test(masked.slice(0, call.start))) {
      return { ...call, argument }
    }
  }
}

export function readObjectProperty(objectSource: string, propertyName: string): string | undefined {
  const normalized = stripBoundaryComments(objectSource)
  if (!normalized.startsWith("{") || !normalized.endsWith("}")) return
  for (const property of splitTopLevel(normalized.slice(1, -1))) {
    const parts = splitTopLevel(property, ":")
    if (parts.length < 2) continue
    const key = stripBoundaryComments(parts.shift()!).replace(/^["'`](.*)["'`]$/s, "$1")
    if (key === propertyName) return stripBoundaryComments(parts.join(":"))
  }
}
