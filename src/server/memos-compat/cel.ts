/**
 * Memos 兼容层的 CEL 过滤子集。
 *
 * 官方客户端（Web、移动端）只发送有限几种表达式，这里实现这些形态到 SQL 的
 * 翻译；不支持的语法一律返回 INVALID_ARGUMENT，绝不静默忽略条件。
 *
 * 已支持：
 *   creator == "users/xxx"
 *   visibility == "PUBLIC" / visibility in ["PUBLIC", "PRIVATE"]
 *   pinned / pinned == true / pinned != true
 *   content.contains("x") / content.startsWith("x") / content.endsWith("x")
 *   tag in ["a", "b"] / "a" in tags / tags.exists(t, t == "a")
 *   tags.exists(t, t.startsWith("a"))
 *   created_ts >= timestamp(1704067200) / updated_ts < now - duration("1h")
 *   size(content) > 100
 *   has_link / has_task_list / has_code / has_incomplete_tasks
 *   && || ! 与括号
 *
 * 不支持：matches()（RE2，避免 ReDoS）、宏、字段之间的比较、Mome 没有的字段
 * （space / has_location 恒为 false）。
 */
import { inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { db } from '#/db'
import { memos, memoTags, tags } from '#/db/schema'
import { Code, MemosError } from './errors'

type TokenType = 'ident' | 'string' | 'number' | 'op' | 'punct' | 'eof'

interface Token {
  type: TokenType
  value: string
  pos: number
}

const OPERATORS = [
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '<',
  '>',
  '!',
  '+',
  '-',
  '.',
]
const PUNCTUATION = ['(', ')', '[', ']', ',']

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      let value = ''
      i++
      let closed = false
      while (i < input.length) {
        const c = input[i]
        if (c === '\\' && i + 1 < input.length) {
          const next = input[i + 1]
          value +=
            next === 'n'
              ? '\n'
              : next === 't'
                ? '\t'
                : next === 'r'
                  ? '\r'
                  : next
          i += 2
          continue
        }
        if (c === quote) {
          closed = true
          i++
          break
        }
        value += c
        i++
      }
      if (!closed) {
        throw new MemosError(Code.INVALID_ARGUMENT, 'filter 中的字符串未闭合')
      }
      tokens.push({ type: 'string', value, pos: i })
      continue
    }
    if (/[0-9]/.test(ch)) {
      let value = ''
      while (i < input.length && /[0-9.eE+-]/.test(input[i])) {
        // 符号只在指数部分合法，避免把 `1-2` 吞成一个数字
        if (
          (input[i] === '+' || input[i] === '-') &&
          !/[eE]/.test(input[i - 1] ?? '')
        ) {
          break
        }
        value += input[i]
        i++
      }
      if (!/^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(value)) {
        throw new MemosError(
          Code.INVALID_ARGUMENT,
          `filter 中的数字不合法: ${value}`,
        )
      }
      tokens.push({ type: 'number', value, pos: i })
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = ''
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) {
        value += input[i]
        i++
      }
      tokens.push({ type: 'ident', value, pos: i })
      continue
    }
    const op = OPERATORS.find((candidate) => input.startsWith(candidate, i))
    if (op) {
      tokens.push({ type: 'op', value: op, pos: i })
      i += op.length
      continue
    }
    if (PUNCTUATION.includes(ch)) {
      tokens.push({ type: 'punct', value: ch, pos: i })
      i++
      continue
    }
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      `filter 中存在不支持的字符: ${ch}`,
    )
  }
  tokens.push({ type: 'eof', value: '', pos: i })
  return tokens
}

type Node =
  | { k: 'lit'; v: string | number | boolean | null }
  | { k: 'list'; items: Node[] }
  | { k: 'ident'; name: string }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'member'; obj: Node; name: string; args: Node[] | null }
  | { k: 'unary'; op: '!' | '-'; operand: Node }
  | { k: 'binary'; op: string; left: Node; right: Node }

class Parser {
  private index = 0

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.parseOr()
    if (this.peek().type !== 'eof') {
      throw new MemosError(
        Code.INVALID_ARGUMENT,
        `filter 在 ${this.peek().pos} 处存在多余内容`,
      )
    }
    return node
  }

  private peek(): Token {
    return this.tokens[this.index]
  }

  private eat(value: string): boolean {
    const token = this.peek()
    if (
      (token.type === 'op' ||
        token.type === 'punct' ||
        token.type === 'ident') &&
      token.value === value
    ) {
      this.index++
      return true
    }
    return false
  }

  private expect(value: string): void {
    if (!this.eat(value)) {
      throw new MemosError(
        Code.INVALID_ARGUMENT,
        `filter 在 ${this.peek().pos} 处期望 ${value}`,
      )
    }
  }

  private parseOr(): Node {
    let left = this.parseAnd()
    while (this.eat('||')) {
      left = { k: 'binary', op: '||', left, right: this.parseAnd() }
    }
    return left
  }

  private parseAnd(): Node {
    let left = this.parseComparison()
    while (this.eat('&&')) {
      left = { k: 'binary', op: '&&', left, right: this.parseComparison() }
    }
    return left
  }

  private parseComparison(): Node {
    const left = this.parseAdditive()
    const token = this.peek()
    if (
      token.type === 'op' &&
      ['==', '!=', '<', '<=', '>', '>='].includes(token.value)
    ) {
      this.index++
      return {
        k: 'binary',
        op: token.value,
        left,
        right: this.parseAdditive(),
      }
    }
    if (token.type === 'ident' && token.value === 'in') {
      this.index++
      return { k: 'binary', op: 'in', left, right: this.parseAdditive() }
    }
    return left
  }

  private parseAdditive(): Node {
    let left = this.parseUnary()
    for (;;) {
      const token = this.peek()
      if (token.type === 'op' && (token.value === '+' || token.value === '-')) {
        this.index++
        left = {
          k: 'binary',
          op: token.value,
          left,
          right: this.parseUnary(),
        }
        continue
      }
      return left
    }
  }

  private parseUnary(): Node {
    const token = this.peek()
    if (token.type === 'op' && (token.value === '!' || token.value === '-')) {
      this.index++
      return { k: 'unary', op: token.value, operand: this.parseUnary() }
    }
    return this.parsePrimary()
  }

  private parseArgs(): Node[] {
    this.expect('(')
    const args: Node[] = []
    if (!this.eat(')')) {
      do {
        args.push(this.parseOr())
      } while (this.eat(','))
      this.expect(')')
    }
    return args
  }

  private parsePrimary(): Node {
    const token = this.peek()
    if (token.type === 'string') {
      this.index++
      return { k: 'lit', v: token.value }
    }
    if (token.type === 'number') {
      this.index++
      return { k: 'lit', v: Number(token.value) }
    }
    if (token.type === 'punct' && token.value === '(') {
      this.index++
      const node = this.parseOr()
      this.expect(')')
      return node
    }
    if (token.type === 'punct' && token.value === '[') {
      this.index++
      const items: Node[] = []
      if (!this.eat(']')) {
        do {
          items.push(this.parseOr())
        } while (this.eat(','))
        this.expect(']')
      }
      return { k: 'list', items }
    }
    if (token.type === 'ident') {
      this.index++
      const name = token.value
      if (name === 'true') return { k: 'lit', v: true }
      if (name === 'false') return { k: 'lit', v: false }
      if (name === 'null') return { k: 'lit', v: null }

      if (this.peek().type === 'punct' && this.peek().value === '(') {
        return { k: 'call', name, args: this.parseArgs() }
      }
      let node: Node = { k: 'ident', name }
      while (this.peek().type === 'op' && this.peek().value === '.') {
        this.index++
        const memberToken = this.peek()
        if (memberToken.type !== 'ident') {
          throw new MemosError(
            Code.INVALID_ARGUMENT,
            `filter 在 ${memberToken.pos} 处期望方法名`,
          )
        }
        this.index++
        const args =
          this.peek().type === 'punct' && this.peek().value === '('
            ? this.parseArgs()
            : null
        node = { k: 'member', obj: node, name: memberToken.value, args }
      }
      return node
    }
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      `filter 在 ${token.pos} 处存在无法解析的 token`,
    )
  }
}

type ValueKind = 'string' | 'number' | 'bool' | 'timestamp' | 'tag'

type Value =
  | { t: 'const'; v: string | number | boolean | null }
  | { t: 'sql'; sql: SQL; kind: ValueKind }

function fail(message: string): never {
  throw new MemosError(
    Code.INVALID_ARGUMENT,
    `不支持的 filter 表达式: ${message}`,
  )
}

function likePattern(
  value: string,
  mode: 'contains' | 'startsWith' | 'endsWith',
): string {
  const escaped = value.replace(/[\\%_]/g, (match) => `\\${match}`)
  switch (mode) {
    case 'contains':
      return `%${escaped}%`
    case 'startsWith':
      return `${escaped}%`
    case 'endsWith':
      return `%${escaped}`
  }
}

const CONTENT = sql`${memos.content}`

function like(column: SQL, pattern: string): SQL {
  return sql`${column} LIKE ${pattern} ESCAPE '\\'`
}

function field(name: string): Value | null {
  switch (name) {
    case 'content':
      return { t: 'sql', sql: CONTENT, kind: 'string' }
    case 'creator':
      return {
        t: 'sql',
        sql: sql`('users/' || ${memos.userId})`,
        kind: 'string',
      }
    case 'name':
      return { t: 'sql', sql: sql`('memos/' || ${memos.id})`, kind: 'string' }
    case 'visibility':
      return {
        t: 'sql',
        sql: sql`(case when ${memos.visibility} = 'public' then 'PUBLIC' else 'PRIVATE' end)`,
        kind: 'string',
      }
    case 'pinned':
      return { t: 'sql', sql: sql`(${memos.pinned} = 1)`, kind: 'bool' }
    case 'created_ts':
      return { t: 'sql', sql: sql`${memos.createdAt}`, kind: 'timestamp' }
    case 'updated_ts':
      return { t: 'sql', sql: sql`${memos.updatedAt}`, kind: 'timestamp' }
    case 'tags':
    case 'tag':
      return { t: 'sql', sql: sql`1`, kind: 'tag' }
    case 'has_link':
      return {
        t: 'sql',
        sql: sql`((${CONTENT} LIKE '%http://%') OR (${CONTENT} LIKE '%https://%') OR (${CONTENT} LIKE '%](%'))`,
        kind: 'bool',
      }
    case 'has_task_list':
      return {
        t: 'sql',
        sql: sql`((${CONTENT} LIKE '%[ ]%') OR (${CONTENT} LIKE '%[x]%') OR (${CONTENT} LIKE '%[X]%'))`,
        kind: 'bool',
      }
    case 'has_incomplete_tasks':
      return { t: 'sql', sql: like(CONTENT, '%[ ]%'), kind: 'bool' }
    case 'has_code':
      return {
        t: 'sql',
        sql: sql`((${CONTENT} LIKE '%\`\`\`%') OR (${CONTENT} LIKE '%\`%'))`,
        kind: 'bool',
      }
    case 'has_location':
      return { t: 'sql', sql: sql`0`, kind: 'bool' }
    default:
      return null
  }
}

function parseDuration(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d|w)$/.exec(value.trim())
  if (!match) fail(`duration("${value}") 无法解析`)
  const amount = Number(match[1])
  const factor: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  }
  return amount * factor[match[2]]
}

/** 标签路径匹配：查询 tags 表并还原层级路径（标签表很小，单次全量可接受） */
async function tagIdsMatching(
  matcher: (path: string) => boolean,
): Promise<string[]> {
  const rows = await db
    .select({ id: tags.id, name: tags.name, parentId: tags.parentId })
    .from(tags)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const pathCache = new Map<string, string>()
  const pathOf = (id: string): string => {
    const cached = pathCache.get(id)
    if (cached !== undefined) return cached
    const row = byId.get(id)
    if (!row) return ''
    const parentPath = row.parentId ? pathOf(row.parentId) : ''
    const path = parentPath ? `${parentPath}/${row.name}` : row.name
    pathCache.set(id, path)
    return path
  }
  return rows.filter((row) => matcher(pathOf(row.id))).map((row) => row.id)
}

function memoHasTagIds(tagIds: string[]): SQL {
  if (tagIds.length === 0) return sql`0`
  const subquery = db
    .select({ memoId: memoTags.memoId })
    .from(memoTags)
    .where(inArray(memoTags.tagId, tagIds))
  return inArray(memos.id, subquery)
}

interface TagPredicate {
  op: 'exact' | 'startsWith' | 'endsWith' | 'contains'
  value: string
}

function matchesTagPath(path: string, predicate: TagPredicate): boolean {
  switch (predicate.op) {
    case 'exact':
      return path === predicate.value
    case 'startsWith':
      return path.startsWith(predicate.value)
    case 'endsWith':
      return path.endsWith(predicate.value)
    case 'contains':
      return path.includes(predicate.value)
  }
}

async function tagCondition(predicates: TagPredicate[]): Promise<SQL> {
  const tagIds = await tagIdsMatching((path) =>
    predicates.some((predicate) => matchesTagPath(path, predicate)),
  )
  return memoHasTagIds(tagIds)
}

/** 把 `tags.exists(t, <pred>)` 的谓词体翻译成标签路径谓词列表 */
function compileTagPredicate(
  node: Node,
  variable: string,
  out: TagPredicate[],
): void {
  if (node.k === 'binary' && node.op === '&&') {
    compileTagPredicate(node.left, variable, out)
    compileTagPredicate(node.right, variable, out)
    return
  }
  if (node.k === 'binary' && node.op === '==') {
    const value = literalTagValue(node.left, node.right, variable)
    if (value === null) fail('tags.exists 只支持与字符串字面量比较')
    out.push({ op: 'exact', value })
    return
  }
  if (
    node.k === 'member' &&
    node.obj.k === 'ident' &&
    node.obj.name === variable
  ) {
    const arg = node.args?.[0]
    if (!arg || arg.k !== 'lit' || typeof arg.v !== 'string') {
      fail(`tags.exists 的 ${node.name}() 只接受字符串字面量`)
    }
    if (
      node.name !== 'startsWith' &&
      node.name !== 'endsWith' &&
      node.name !== 'contains'
    ) {
      fail(`tags.exists 不支持 ${node.name}()`)
    }
    out.push({ op: node.name, value: arg.v })
    return
  }
  fail('tags.exists 只支持 t == "x" / t.startsWith("x") 等谓词')
}

function literalTagValue(
  left: Node,
  right: Node,
  variable: string,
): string | null {
  const pick = (node: Node): string | null =>
    node.k === 'lit' && typeof node.v === 'string' ? node.v : null
  const isVar = (node: Node): boolean =>
    node.k === 'ident' && node.name === variable
  if (isVar(left)) return pick(right)
  if (isVar(right)) return pick(left)
  return null
}

class Evaluator {
  async eval(node: Node): Promise<Value> {
    switch (node.k) {
      case 'lit':
        return { t: 'const', v: node.v }
      case 'list':
        fail('列表只能出现在 in 的右值位置')
        break
      case 'ident': {
        if (node.name === 'now') return { t: 'const', v: Date.now() }
        const value = field(node.name)
        if (!value) fail(`未知字段 ${node.name}`)
        return value
      }
      case 'unary': {
        const operand = await this.eval(node.operand)
        if (node.op === '!') return this.not(operand)
        if (operand.t === 'const' && typeof operand.v === 'number') {
          return { t: 'const', v: -operand.v }
        }
        fail('一元 - 只支持常量')
        break
      }
      case 'call':
        return this.evalCall(node)
      case 'member':
        return this.evalMember(node)
      case 'binary':
        return this.evalBinary(node)
    }
  }

  private async evalCall(node: {
    k: 'call'
    name: string
    args: Node[]
  }): Promise<Value> {
    switch (node.name) {
      case 'timestamp': {
        if (node.args.length !== 1) fail('timestamp() 需要一个参数')
        const arg = node.args[0]
        if (
          arg.k !== 'lit' ||
          typeof arg.v !== 'number' ||
          !Number.isInteger(arg.v)
        ) {
          fail('timestamp() 只接受整数秒字面量')
        }
        return { t: 'const', v: arg.v * 1000 }
      }
      case 'duration': {
        if (node.args.length !== 1) fail('duration() 需要一个参数')
        const arg = node.args[0]
        if (arg.k !== 'lit' || typeof arg.v !== 'string') {
          fail('duration() 只接受字符串字面量')
        }
        return { t: 'const', v: parseDuration(arg.v) }
      }
      case 'size': {
        if (node.args.length !== 1) fail('size() 需要一个参数')
        const value = await this.eval(node.args[0])
        if (value.t === 'const') {
          if (typeof value.v !== 'string') fail('size() 只支持字符串')
          return { t: 'const', v: value.v.length }
        }
        if (value.kind !== 'string') fail('size() 只支持字符串字段')
        return { t: 'sql', sql: sql`length(${value.sql})`, kind: 'number' }
      }
      default:
        fail(`不支持的函数 ${node.name}()`)
    }
  }

  private async evalMember(node: {
    k: 'member'
    obj: Node
    name: string
    args: Node[] | null
  }): Promise<Value> {
    if (
      node.obj.k === 'ident' &&
      node.obj.name === 'tags' &&
      node.name === 'exists'
    ) {
      const args = node.args ?? []
      if (args.length !== 2) fail('tags.exists(t, predicate) 需要两个参数')
      const variable = args[0]
      if (variable.k !== 'ident') fail('tags.exists 的第一个参数必须是变量名')
      const predicates: TagPredicate[] = []
      compileTagPredicate(args[1], variable.name, predicates)
      return { t: 'sql', sql: await tagCondition(predicates), kind: 'bool' }
    }

    const target = await this.eval(node.obj)
    const arg = node.args?.[0]
    if (!arg) fail(`${node.name}() 需要一个参数`)
    const raw = await this.eval(arg)
    if (raw.t !== 'const' || typeof raw.v !== 'string') {
      fail(`${node.name}() 只接受字符串字面量`)
    }
    if (node.name === 'matches') {
      fail('content.matches()（RE2 正则）未实现')
    }
    if (
      node.name !== 'contains' &&
      node.name !== 'startsWith' &&
      node.name !== 'endsWith'
    ) {
      fail(`不支持的方法 ${node.name}()`)
    }
    if (target.t === 'const') {
      if (typeof target.v !== 'string') fail(`${node.name}() 只能作用于字符串`)
      const text = target.v
      const matched =
        node.name === 'contains'
          ? text.includes(raw.v)
          : node.name === 'startsWith'
            ? text.startsWith(raw.v)
            : text.endsWith(raw.v)
      return { t: 'const', v: matched }
    }
    if (target.kind !== 'string') fail(`${node.name}() 只能作用于字符串字段`)
    return {
      t: 'sql',
      sql: like(target.sql, likePattern(raw.v, node.name)),
      kind: 'bool',
    }
  }

  private not(value: Value): Value {
    if (value.t === 'const') {
      if (typeof value.v !== 'boolean') fail('! 只能作用于布尔表达式')
      return { t: 'const', v: !value.v }
    }
    if (value.kind !== 'bool') fail('! 只能作用于布尔表达式')
    return { t: 'sql', sql: sql`NOT (${value.sql})`, kind: 'bool' }
  }

  private async evalBinary(node: {
    k: 'binary'
    op: string
    left: Node
    right: Node
  }): Promise<Value> {
    if (node.op === '&&' || node.op === '||') {
      const left = this.asBoolSql(await this.eval(node.left))
      const right = this.asBoolSql(await this.eval(node.right))
      return {
        t: 'sql',
        sql:
          node.op === '&&'
            ? sql`(${left} AND ${right})`
            : sql`(${left} OR ${right})`,
        kind: 'bool',
      }
    }
    if (node.op === '+' || node.op === '-') {
      const left = await this.eval(node.left)
      const right = await this.eval(node.right)
      if (
        left.t === 'const' &&
        right.t === 'const' &&
        typeof left.v === 'number' &&
        typeof right.v === 'number'
      ) {
        return {
          t: 'const',
          v: node.op === '+' ? left.v + right.v : left.v - right.v,
        }
      }
      fail('时间/数值运算只支持常量之间')
    }
    if (node.op === 'in') return this.evalIn(node.left, node.right)
    return this.compare(
      node.op,
      await this.eval(node.left),
      await this.eval(node.right),
    )
  }

  private async evalIn(leftNode: Node, rightNode: Node): Promise<Value> {
    // `"x" in tags`：右值是 tags 字段本身
    if (
      rightNode.k === 'ident' &&
      (rightNode.name === 'tags' || rightNode.name === 'tag')
    ) {
      const left = await this.eval(leftNode)
      if (left.t !== 'const' || typeof left.v !== 'string') {
        fail('"x" in tags 左侧必须是字符串字面量')
      }
      return {
        t: 'sql',
        sql: await tagCondition([{ op: 'exact', value: left.v }]),
        kind: 'bool',
      }
    }
    const left = await this.eval(leftNode)
    const values = this.literalList(rightNode)
    if (left.t !== 'sql') fail('in 左侧必须是字段')
    if (left.kind === 'tag') {
      return {
        t: 'sql',
        sql: await tagCondition(
          values.map((value) => ({ op: 'exact' as const, value })),
        ),
        kind: 'bool',
      }
    }
    if (values.length === 0) return { t: 'const', v: false }
    const bindings = values.map((value) => this.coerce(left, value))
    return {
      t: 'sql',
      sql: sql`${left.sql} IN (${sql.join(
        bindings.map((value) => sql`${value}`),
        sql`, `,
      )})`,
      kind: 'bool',
    }
  }

  private literalList(node: Node): string[] {
    if (node.k !== 'list') fail('in 的右值必须是字面量列表')
    return node.items.map((item) => {
      if (item.k !== 'lit' || typeof item.v !== 'string') {
        fail('in 列表只支持字符串字面量')
      }
      return item.v
    })
  }

  private coerce(
    target: { kind: ValueKind },
    value: string | number | boolean | null,
  ): string | number {
    if (target.kind === 'bool') {
      if (typeof value !== 'boolean') fail('布尔字段只能与 true/false 比较')
      return value ? 1 : 0
    }
    if (target.kind === 'number' || target.kind === 'timestamp') {
      if (typeof value !== 'number') fail('数值字段只能与数字比较')
      return value
    }
    if (typeof value !== 'string') fail('字符串字段只能与字符串比较')
    return value
  }

  private asBoolSql(value: Value): SQL {
    if (value.t === 'const') {
      if (typeof value.v !== 'boolean') fail('逻辑运算只能作用于布尔表达式')
      return value.v ? sql`1` : sql`0`
    }
    if (value.kind !== 'bool') fail('逻辑运算只能作用于布尔表达式')
    return value.sql
  }

  private compare(op: string, left: Value, right: Value): Value {
    if (left.t === 'const' && right.t === 'const') {
      const l = left.v
      const r = right.v
      if (op === '==') return { t: 'const', v: l === r }
      if (op === '!=') return { t: 'const', v: l !== r }
      if (typeof l !== typeof r) fail('比较两侧类型不一致')
      if (typeof l === 'number' && typeof r === 'number') {
        if (op === '<') return { t: 'const', v: l < r }
        if (op === '<=') return { t: 'const', v: l <= r }
        if (op === '>') return { t: 'const', v: l > r }
        if (op === '>=') return { t: 'const', v: l >= r }
      }
      if (typeof l === 'string' && typeof r === 'string') {
        if (op === '<') return { t: 'const', v: l < r }
        if (op === '<=') return { t: 'const', v: l <= r }
        if (op === '>') return { t: 'const', v: l > r }
        if (op === '>=') return { t: 'const', v: l >= r }
      }
      fail(`不支持的比较运算符 ${op}`)
    }

    // 常量在左时翻转比较方向，统一成「字段 op 常量」
    if (left.t === 'const' && right.t === 'sql') {
      const flipped: Record<string, string> = {
        '<': '>',
        '<=': '>=',
        '>': '<',
        '>=': '<=',
        '==': '==',
        '!=': '!=',
      }
      return this.compare(flipped[op] ?? op, right, left)
    }
    if (right.t === 'sql') fail('不支持字段之间的比较')
    const target = left as { t: 'sql'; sql: SQL; kind: ValueKind }
    if (target.kind === 'tag') fail('tag 字段请使用 tag in [...]')
    const bound = this.coerce(target, right.v)
    switch (op) {
      case '==':
        return { t: 'sql', sql: sql`${target.sql} = ${bound}`, kind: 'bool' }
      case '!=':
        return { t: 'sql', sql: sql`${target.sql} <> ${bound}`, kind: 'bool' }
      case '<':
        return { t: 'sql', sql: sql`${target.sql} < ${bound}`, kind: 'bool' }
      case '<=':
        return { t: 'sql', sql: sql`${target.sql} <= ${bound}`, kind: 'bool' }
      case '>':
        return { t: 'sql', sql: sql`${target.sql} > ${bound}`, kind: 'bool' }
      case '>=':
        return { t: 'sql', sql: sql`${target.sql} >= ${bound}`, kind: 'bool' }
      default:
        fail(`不支持的比较运算符 ${op}`)
    }
  }
}

/** filter 表达式长度上限：解析前先挡住超长输入的 CPU/内存开销 */
const MAX_FILTER_LENGTH = 2000

/** 把 CEL 子集编译成 SQL 条件；表达式为空返回 null */
export async function compileMemosFilter(
  expression: string,
): Promise<SQL | null> {
  const trimmed = expression.trim()
  if (!trimmed) return null
  if (trimmed.length > MAX_FILTER_LENGTH) {
    fail(`filter 表达式不能超过 ${MAX_FILTER_LENGTH} 个字符`)
  }
  const node = new Parser(tokenize(trimmed)).parse()
  const value = await new Evaluator().eval(node)
  if (value.t === 'const') {
    if (typeof value.v !== 'boolean') fail('filter 必须是布尔表达式')
    return value.v ? sql`1` : sql`0`
  }
  if (value.kind !== 'bool') fail('filter 必须是布尔表达式')
  return value.sql
}
