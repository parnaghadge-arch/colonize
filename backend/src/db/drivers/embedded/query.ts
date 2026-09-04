import type { Document, Filter, Pipeline, Projection, SortSpec, Update } from '../types.js';

/**
 * Mongo-compatible query semantics for the embedded driver.
 *
 * Implemented (the subset the platform actually uses):
 *   operators : $eq $ne $gt $gte $lt $lte $in $nin $exists $regex $options $not $and $or $nor
 *               $elemMatch $size $all $mod $type
 *   updates   : $set $setOnInsert $unset $inc $mul $min $max $currentDate $push $pushEach
 *               $addToSet $pull $pullAll $rename $pop
 *   paths     : dot notation, arrays of scalars, arrays of sub-documents
 *   aggregate : $match $project $group $sort $limit $skip $unwind $count $addFields $set
 *               $facet $replaceRoot $sortByCount $unset $lookup(same-db, equality only)
 *
 * Anything outside this subset throws loudly rather than silently returning wrong data —
 * a quiet divergence between drivers would be far worse than a visible failure.
 */

/* --------------------------------- paths --------------------------------- */

export function getPath(doc: unknown, path: string): unknown {
  if (!path) return doc;
  const parts = path.split('.');
  let current: unknown = doc;
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts[i] as string;
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      // Mongo semantics: `a.b` on an array maps over its elements.
      const rest = parts.slice(i).join('.');
      const mapped = current.map((item) => getPath(item, rest));
      return mapped.some((v) => v !== undefined) ? mapped.flat(Infinity).filter((v) => v !== undefined) : undefined;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function setPath(doc: Document, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Document = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i] as string;
    const nextKey = parts[i + 1] as string;
    if (current[key] === undefined || current[key] === null) {
      current[key] = /^\d+$/.test(nextKey) ? [] : {};
    }
    if (typeof current[key] !== 'object') {
      throw new Error(`Cannot set path "${path}": "${parts.slice(0, i + 1).join('.')}" is not an object`);
    }
    current = current[key] as Document;
  }
  const last = parts[parts.length - 1] as string;
  if (Array.isArray(current) && /^\d+$/.test(last)) {
    (current as unknown[])[Number(last)] = value;
    return;
  }
  (current as Document)[last] = value;
}

export function unsetPath(doc: Document, path: string): void {
  const parts = path.split('.');
  let current: Document = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i] as string;
    if (current[key] === undefined || typeof current[key] !== 'object') return;
    current = current[key] as Document;
  }
  delete current[parts[parts.length - 1] as string];
}

/* ------------------------------- comparison ------------------------------ */

function typeOrder(value: unknown): number {
  if (value === null) return 1;
  if (typeof value === 'number') return 2;
  if (typeof value === 'string') return 3;
  if (typeof value === 'boolean') return 4;
  if (value instanceof Date) return 5;
  if (Array.isArray(value)) return 6;
  if (typeof value === 'object') return 7;
  return 0;
}

function normaliseForCompare(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

export function compareValues(a: unknown, b: unknown): number {
  const ta = typeOrder(a);
  const tb = typeOrder(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  const na = normaliseForCompare(a);
  const nb = normaliseForCompare(b);
  if (na === nb) return 0;
  if (na === null || na === undefined) return -1;
  if (nb === null || nb === undefined) return 1;
  return na < nb ? -1 : 1;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date || b instanceof Date) return false;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      Object.prototype.hasOwnProperty.call(b as object, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/* -------------------------------- matching ------------------------------- */

const QUERY_OPERATORS = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$regex', '$options',
  '$not', '$elemMatch', '$size', '$all', '$mod', '$type',
]);

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) return false;
  return Object.keys(value as object).some((k) => k.startsWith('$'));
}

function matchesOperator(fieldValue: unknown, operator: string, operand: unknown): boolean {
  switch (operator) {
    case '$eq':
      return valueEquals(fieldValue, operand);
    case '$ne':
      return !valueEquals(fieldValue, operand);
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte': {
      const candidates = Array.isArray(fieldValue) && !(operand instanceof Date) ? fieldValue : [fieldValue];
      return candidates.some((candidate) => {
        if (candidate === undefined || candidate === null) return false;
        const cmp = compareValues(candidate, operand);
        if (operator === '$gt') return cmp > 0;
        if (operator === '$gte') return cmp >= 0;
        if (operator === '$lt') return cmp < 0;
        return cmp <= 0;
      });
    }
    case '$in': {
      if (!Array.isArray(operand)) throw new Error('$in requires an array');
      if (Array.isArray(fieldValue)) return fieldValue.some((v) => operand.some((o) => valueEquals(v, o)));
      return operand.some((o) => valueEquals(fieldValue, o));
    }
    case '$nin': {
      if (!Array.isArray(operand)) throw new Error('$nin requires an array');
      return !matchesOperator(fieldValue, '$in', operand);
    }
    case '$exists':
      return Boolean(operand) ? fieldValue !== undefined : fieldValue === undefined;
    case '$regex': {
      if (fieldValue === undefined || fieldValue === null) return false;
      const re = operand instanceof RegExp ? operand : new RegExp(String(operand));
      const candidates = Array.isArray(fieldValue) ? fieldValue : [fieldValue];
      return candidates.some((c) => typeof c === 'string' && re.test(c));
    }
    case '$options':
      // Handled where the regex is constructed.
      return true;
    case '$not':
      return !matchesCondition(fieldValue, operand as Filter);
    case '$elemMatch': {
      if (!Array.isArray(fieldValue)) return false;
      return fieldValue.some((element) => matchesDocument({ _e: element }, { _e: operand as Filter }) || matchesCondition(element, operand as Filter));
    }
    case '$size':
      return Array.isArray(fieldValue) && fieldValue.length === Number(operand);
    case '$all': {
      if (!Array.isArray(fieldValue) || !Array.isArray(operand)) return false;
      return operand.every((o) => fieldValue.some((v) => valueEquals(v, o)));
    }
    case '$mod': {
      const [divisor, remainder] = operand as number[];
      const n = Number(fieldValue);
      return Number.isFinite(n) && Number(divisor) !== 0 && n % Number(divisor) === Number(remainder);
    }
    case '$type': {
      const expected = String(operand).toLowerCase();
      if (expected === 'date') return fieldValue instanceof Date;
      if (expected === 'array') return Array.isArray(fieldValue);
      if (expected === 'object') return fieldValue !== null && typeof fieldValue === 'object' && !Array.isArray(fieldValue);
      if (expected === 'null') return fieldValue === null;
      if (expected === 'string' || expected === 'number' || expected === 'boolean') return typeof fieldValue === expected;
      return false;
    }
    default:
      throw new Error(`Unsupported query operator "${operator}" in the embedded driver`);
  }
}

function valueEquals(fieldValue: unknown, operand: unknown): boolean {
  /**
   * MongoDB treats `null` and "field absent" as the same thing for equality queries:
   * `{ consumedAt: null }` matches documents where `consumedAt` is null *and* documents that
   * never had the field written at all. `deepEqual` deliberately distinguishes them (it is a
   * value comparison, not a query matcher), so the query layer has to bridge the gap.
   *
   * This is load-bearing: the OTP flow looks up unconsumed codes with `consumedAt: null`, and
   * soft-delete filtering uses `deletedAt: null`. Without this rule both silently match nothing
   * for documents created before the field was ever set — a fresh OTP is then "not found" and
   * login fails with no obvious cause.
   */
  if (operand === null || operand === undefined) {
    return fieldValue === null || fieldValue === undefined;
  }
  if (fieldValue === null || fieldValue === undefined) return false;

  if (deepEqual(fieldValue, operand)) return true;
  // Array field vs scalar operand matches when any element equals the operand.
  if (Array.isArray(fieldValue) && !Array.isArray(operand)) {
    return fieldValue.some((v) => deepEqual(v, operand));
  }
  return false;
}

function matchesCondition(fieldValue: unknown, condition: unknown): boolean {
  if (isOperatorObject(condition)) {
    const entries = Object.entries(condition as Record<string, unknown>);
    // $options must be merged into $regex.
    const options = (condition as Record<string, unknown>).$options as string | undefined;
    return entries.every(([op, operand]) => {
      if (op === '$options') return true;
      if (op === '$regex' && options) {
        if (fieldValue === undefined || fieldValue === null) return false;
        const re = new RegExp(String(operand), options);
        const candidates = Array.isArray(fieldValue) ? fieldValue : [fieldValue];
        return candidates.some((c) => typeof c === 'string' && re.test(c));
      }
      return matchesOperator(fieldValue, op, operand);
    });
  }
  return valueEquals(fieldValue, condition);
}

function matchesDocument(doc: Document, filter: Filter): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    switch (key) {
      case '$and':
        return (condition as Filter[]).every((sub) => matchesDocument(doc, sub));
      case '$or':
        return (condition as Filter[]).some((sub) => matchesDocument(doc, sub));
      case '$nor':
        return !(condition as Filter[]).some((sub) => matchesDocument(doc, sub));
      case '$not':
        return !matchesDocument(doc, condition as Filter);
      case '$expr':
        throw new Error('$expr is not supported by the embedded driver — rewrite the query');
      case '$where':
        throw new Error('$where is not supported');
      default: {
        if (key.startsWith('$')) {
          // Unknown top-level operator: could be a plain field literally named "$x"? No — fail loudly.
          if (!QUERY_OPERATORS.has(key)) throw new Error(`Unsupported top-level operator "${key}"`);
          return matchesCondition(doc, { [key]: condition } as Filter);
        }
        const value = getPath(doc, key);
        return matchesCondition(value, condition);
      }
    }
  });
}

export function matches(doc: Document, filter: Filter = {}): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  return matchesDocument(doc, filter);
}

/* --------------------------------- sorting -------------------------------- */

export function sortDocuments(docs: Document[], sort?: SortSpec): Document[] {
  if (!sort) return docs;
  const entries = Object.entries(sort).filter(([, dir]) => dir === 1 || dir === -1);
  if (entries.length === 0) return docs;
  return [...docs].sort((a, b) => {
    for (const [field, dir] of entries) {
      const cmp = compareValues(getPath(a, field), getPath(b, field));
      if (cmp !== 0) return dir === 1 ? cmp : -cmp;
    }
    return 0;
  });
}

/* ------------------------------- projection ------------------------------- */

export function projectDocument(doc: Document, projection?: Projection): Document {
  if (!projection || Object.keys(projection).length === 0) return doc;
  const entries = Object.entries(projection);
  const isInclusion = entries.some(([, v]) => v === 1);
  if (isInclusion) {
    const out: Document = { _id: doc._id };
    for (const [field, include] of entries) {
      if (include !== 1 || field === '_id') continue;
      const value = getPath(doc, field);
      if (value !== undefined) setPath(out, field, value);
    }
    if (projection._id === 0) delete out._id;
    return out;
  }
  const out: Document = structuredClone(doc);
  for (const [field, include] of entries) {
    if (include === 0) unsetPath(out, field);
  }
  return out;
}

/* --------------------------------- updates -------------------------------- */

const UPDATE_OPERATORS = new Set([
  '$set', '$setOnInsert', '$unset', '$inc', '$mul', '$min', '$max', '$currentDate',
  '$push', '$addToSet', '$pull', '$pullAll', '$rename', '$pop',
]);

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function arrayRemovePredicate(item: unknown, condition: unknown): boolean {
  if (condition !== null && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {
    const cond = condition as Filter;
    if (Object.keys(cond).some((k) => k.startsWith('$'))) {
      return matchesCondition(item, cond);
    }
    if (item !== null && typeof item === 'object') {
      return matchesDocument(item as Document, cond);
    }
    return false;
  }
  return deepEqual(item, condition);
}

/**
 * Apply an update document to a (cloned) target.
 * Returns true when at least one field changed.
 */
export function applyUpdate(target: Document, update: Update, opts: { isInsert?: boolean } = {}): boolean {
  const keys = Object.keys(update);
  const hasOperators = keys.some((k) => k.startsWith('$'));
  if (!hasOperators) {
    // Replacement update: keep `_id`, replace everything else.
    const id = target._id;
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, structuredClone(update), { _id: id });
    return true;
  }

  for (const key of keys) {
    if (!UPDATE_OPERATORS.has(key)) {
      throw new Error(`Unsupported update operator "${key}" in the embedded driver`);
    }
  }

  let changed = false;

  if (update.$setOnInsert && opts.isInsert) {
    for (const [path, value] of Object.entries(update.$setOnInsert as Document)) {
      setPath(target, path, structuredClone(value));
      changed = true;
    }
  }

  if (update.$set) {
    for (const [path, value] of Object.entries(update.$set as Document)) {
      const before = getPath(target, path);
      if (!deepEqual(before, value)) changed = true;
      setPath(target, path, structuredClone(value));
    }
  }

  if (update.$unset) {
    for (const path of Object.keys(update.$unset as Document)) {
      if (getPath(target, path) !== undefined) changed = true;
      unsetPath(target, path);
    }
  }

  if (update.$rename) {
    for (const [from, to] of Object.entries(update.$rename as Document)) {
      const value = getPath(target, from);
      if (value !== undefined) {
        unsetPath(target, from);
        setPath(target, String(to), value);
        changed = true;
      }
    }
  }

  if (update.$inc) {
    for (const [path, amount] of Object.entries(update.$inc as Document)) {
      const current = Number(getPath(target, path) ?? 0);
      const next = current + Number(amount);
      setPath(target, path, next);
      changed = true;
    }
  }

  if (update.$mul) {
    for (const [path, factor] of Object.entries(update.$mul as Document)) {
      const current = Number(getPath(target, path) ?? 0);
      setPath(target, path, current * Number(factor));
      changed = true;
    }
  }

  if (update.$min) {
    for (const [path, value] of Object.entries(update.$min as Document)) {
      const current = getPath(target, path);
      if (current === undefined || compareValues(value, current) < 0) {
        setPath(target, path, structuredClone(value));
        changed = true;
      }
    }
  }

  if (update.$max) {
    for (const [path, value] of Object.entries(update.$max as Document)) {
      const current = getPath(target, path);
      if (current === undefined || compareValues(value, current) > 0) {
        setPath(target, path, structuredClone(value));
        changed = true;
      }
    }
  }

  if (update.$currentDate) {
    for (const [path, spec] of Object.entries(update.$currentDate as Document)) {
      const wantDate = spec === true || (spec as Document)?.$type === 'date';
      setPath(target, path, wantDate ? new Date() : Date.now());
      changed = true;
    }
  }

  if (update.$push) {
    for (const [path, spec] of Object.entries(update.$push as Document)) {
      const list = asArray(getPath(target, path)).slice();
      if (spec && typeof spec === 'object' && '$each' in (spec as Document)) {
        const each = (spec as Document).$each as unknown[];
        const position = (spec as Document).$position as number | undefined;
        const slice = (spec as Document).$slice as number | undefined;
        const items = structuredClone(each);
        if (typeof position === 'number') list.splice(position, 0, ...items);
        else list.push(...items);
        if (typeof slice === 'number') {
          const sliced = slice >= 0 ? list.slice(0, slice) : list.slice(slice);
          setPath(target, path, sliced);
        } else {
          setPath(target, path, list);
        }
      } else {
        list.push(structuredClone(spec));
        setPath(target, path, list);
      }
      changed = true;
    }
  }

  if (update.$addToSet) {
    for (const [path, spec] of Object.entries(update.$addToSet as Document)) {
      const list = asArray(getPath(target, path)).slice();
      const items = spec && typeof spec === 'object' && '$each' in (spec as Document)
        ? ((spec as Document).$each as unknown[])
        : [spec];
      let added = false;
      for (const item of items) {
        if (!list.some((existing) => deepEqual(existing, item))) {
          list.push(structuredClone(item));
          added = true;
        }
      }
      if (added) {
        setPath(target, path, list);
        changed = true;
      }
    }
  }

  if (update.$pull) {
    for (const [path, condition] of Object.entries(update.$pull as Document)) {
      const list = asArray(getPath(target, path));
      const kept = list.filter((item) => !arrayRemovePredicate(item, condition));
      if (kept.length !== list.length) {
        setPath(target, path, kept);
        changed = true;
      }
    }
  }

  if (update.$pullAll) {
    for (const [path, values] of Object.entries(update.$pullAll as Document)) {
      const list = asArray(getPath(target, path));
      const removals = asArray(values);
      const kept = list.filter((item) => !removals.some((r) => deepEqual(item, r)));
      if (kept.length !== list.length) {
        setPath(target, path, kept);
        changed = true;
      }
    }
  }

  if (update.$pop) {
    for (const [path, direction] of Object.entries(update.$pop as Document)) {
      const list = asArray(getPath(target, path)).slice();
      if (list.length === 0) continue;
      if (Number(direction) === 1) list.pop();
      else list.shift();
      setPath(target, path, list);
      changed = true;
    }
  }

  return changed;
}

/* ------------------------------ aggregation ------------------------------ */

/** Resolves another collection's documents, for `$lookup`. */
export interface AggContext {
  getCollectionDocs(name: string): Document[];
}

function groupKey(doc: Document, idSpec: unknown): unknown {
  if (idSpec === null) return null;
  if (typeof idSpec === 'string' && idSpec.startsWith('$')) return getPath(doc, idSpec.slice(1));
  if (idSpec && typeof idSpec === 'object' && !Array.isArray(idSpec)) {
    // A compound `_id` must come back as the *object* Mongo would return, so callers can read
    // `row._id.status`. Stringifying it here would silently flatten every compound group and
    // leave downstream property reads undefined. Bucketing uses its own stable map key.
    const out: Document = {};
    for (const [k, v] of Object.entries(idSpec as Document)) out[k] = groupKey(doc, v);
    return out;
  }
  return idSpec;
}

const ACCUMULATORS = new Set([
  '$sum', '$avg', '$min', '$max', '$push', '$addToSet', '$first', '$last', '$count',
]);

function accumulate(spec: unknown, docs: Document[]): unknown {
  if (typeof spec !== 'object' || spec === null) return null;
  const [op, expr] = Object.entries(spec as Document)[0] ?? [];
  if (!op || !ACCUMULATORS.has(op)) {
    throw new Error(`Unsupported group accumulator "${op}" in the embedded driver`);
  }
  const values = docs.map((d) => resolveExpression(d, expr));
  switch (op) {
    case '$sum': {
      if (expr === 1) return docs.length;
      return values.reduce<number>((acc, v) => acc + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
    }
    case '$avg': {
      const nums = values.map(Number).filter((n) => Number.isFinite(n));
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    }
    case '$min':
      return values.filter((v) => v !== undefined && v !== null).reduce<unknown>((acc, v) => (acc === undefined || compareValues(v, acc) < 0 ? v : acc), undefined) ?? null;
    case '$max':
      return values.filter((v) => v !== undefined && v !== null).reduce<unknown>((acc, v) => (acc === undefined || compareValues(v, acc) > 0 ? v : acc), undefined) ?? null;
    case '$push':
      return values.filter((v) => v !== undefined);
    case '$addToSet':
      return values.filter((v) => v !== undefined).filter((v, i, arr) => arr.findIndex((o) => deepEqual(o, v)) === i);
    case '$first':
      return values[0] ?? null;
    case '$last':
      return values[values.length - 1] ?? null;
    case '$count':
      return docs.length;
    default:
      return null;
  }
}

function resolveExpression(doc: Document, expr: unknown): unknown {
  if (typeof expr === 'string' && expr.startsWith('$')) return getPath(doc, expr.slice(1));
  if (expr && typeof expr === 'object' && !Array.isArray(expr) && !(expr instanceof Date)) {
    const entries = Object.entries(expr as Document);
    if (entries.length === 1) {
      const [op, operand] = entries[0] as [string, unknown];
      switch (op) {
        case '$literal':
          return operand;
        case '$year':
          return toDate(resolveExpression(doc, operand)).getUTCFullYear();
        case '$month':
          return toDate(resolveExpression(doc, operand)).getUTCMonth() + 1;
        case '$dayOfMonth':
          return toDate(resolveExpression(doc, operand)).getUTCDate();
        case '$dateToString': {
          const spec = operand as Document;
          const d = toDate(resolveExpression(doc, spec.date));
          const format = String(spec.format ?? '%Y-%m-%d');
          return format
            .replace('%Y', String(d.getUTCFullYear()))
            .replace('%m', String(d.getUTCMonth() + 1).padStart(2, '0'))
            .replace('%d', String(d.getUTCDate()).padStart(2, '0'));
        }
        case '$concat': {
          return (operand as unknown[]).map((o) => String(resolveExpression(doc, o) ?? '')).join('');
        }
        case '$add': {
          return (operand as unknown[]).reduce<number>((acc, o) => acc + Number(resolveExpression(doc, o) ?? 0), 0);
        }
        case '$subtract': {
          const [a, b] = operand as unknown[];
          return Number(resolveExpression(doc, a) ?? 0) - Number(resolveExpression(doc, b) ?? 0);
        }
        case '$multiply': {
          return (operand as unknown[]).reduce<number>((acc, o) => acc * Number(resolveExpression(doc, o) ?? 1), 1);
        }
        case '$divide': {
          const [a, b] = operand as unknown[];
          const divisor = Number(resolveExpression(doc, b) ?? 0);
          return divisor === 0 ? 0 : Number(resolveExpression(doc, a) ?? 0) / divisor;
        }
        case '$cond': {
          const spec = operand as Document;
          const ifTrue = resolveExpression(doc, spec.if);
          return ifTrue ? resolveExpression(doc, spec.then) : resolveExpression(doc, spec.else);
        }
        case '$ifNull': {
          const [a, b] = operand as unknown[];
          const v = resolveExpression(doc, a);
          return v === null || v === undefined ? resolveExpression(doc, b) : v;
        }
        case '$size': {
          const v = resolveExpression(doc, operand);
          return Array.isArray(v) ? v.length : 0;
        }
        case '$toLower':
          return String(resolveExpression(doc, operand) ?? '').toLowerCase();
        case '$toUpper':
          return String(resolveExpression(doc, operand) ?? '').toUpperCase();
        default:
          throw new Error(`Unsupported aggregation expression "${op}" in the embedded driver`);
      }
    }
    // Plain object literal: resolve each field.
    const out: Document = {};
    for (const [k, v] of entries) out[k] = resolveExpression(doc, v);
    return out;
  }
  if (Array.isArray(expr)) return expr.map((e) => resolveExpression(doc, e));
  return expr;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const d = new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function applyProject(doc: Document, spec: Document): Document {
  const entries = Object.entries(spec);
  const inclusion = entries.filter(([, v]) => v === 1 || (typeof v === 'object' && v !== null));
  const exclusion = entries.filter(([, v]) => v === 0);

  let out: Document;
  if (inclusion.length > 0) {
    out = spec._id === 0 ? {} : { _id: doc._id };
    for (const [key, value] of inclusion) {
      if (key === '_id') continue;
      out[key] = value === 1 ? getPath(doc, key) : resolveExpression(doc, value);
    }
  } else {
    out = structuredClone(doc);
  }
  for (const [key] of exclusion) {
    if (key === '_id' && inclusion.length > 0) continue;
    delete out[key];
  }
  return out;
}

export function runAggregate(
  source: Document[],
  pipeline: Pipeline,
  ctx: AggContext,
  collectionName: string,
): Document[] {
  let docs = source.map((d) => structuredClone(d));

  for (const stage of pipeline) {
    const [op, spec] = Object.entries(stage)[0] ?? [];
    switch (op) {
      case '$match':
        docs = docs.filter((d) => matches(d, spec as Filter));
        break;
      case '$project':
      case '$set':
      case '$addFields': {
        if (op === '$project') {
          docs = docs.map((d) => applyProject(d, spec as Document));
        } else {
          docs = docs.map((d) => {
            const out = structuredClone(d);
            for (const [key, value] of Object.entries(spec as Document)) {
              setPath(out, key, resolveExpression(out, value));
            }
            return out;
          });
        }
        break;
      }
      case '$unset': {
        const fields = Array.isArray(spec) ? (spec as string[]) : [spec as string];
        docs = docs.map((d) => {
          const out = structuredClone(d);
          for (const f of fields) unsetPath(out, f);
          return out;
        });
        break;
      }
      case '$group': {
        const gspec = spec as Document;
        const buckets = new Map<string, { key: unknown; docs: Document[] }>();
        for (const d of docs) {
          const rawKey = groupKey(d, gspec._id);
          const mapKey = typeof rawKey === 'string' ? rawKey : JSON.stringify(rawKey ?? null);
          const bucket = buckets.get(mapKey) ?? { key: rawKey, docs: [] };
          bucket.docs.push(d);
          buckets.set(mapKey, bucket);
        }
        docs = Array.from(buckets.values()).map(({ key, docs: groupDocs }) => {
          const out: Document = { _id: key };
          for (const [field, accSpec] of Object.entries(gspec)) {
            if (field === '_id') continue;
            out[field] = accumulate(accSpec, groupDocs);
          }
          return out;
        });
        break;
      }
      case '$sort':
        docs = sortDocuments(docs, spec as SortSpec);
        break;
      case '$limit':
        docs = docs.slice(0, Number(spec));
        break;
      case '$skip':
        docs = docs.slice(Number(spec));
        break;
      case '$count':
        docs = [{ [spec as string]: docs.length }];
        break;
      case '$unwind': {
        const uspec = typeof spec === 'string' ? { path: spec } : (spec as Document);
        const path = String(uspec.path).replace(/^\$/, '');
        const preserveNull = Boolean(uspec.preserveNullAndEmptyArrays);
        const out: Document[] = [];
        for (const d of docs) {
          const value = getPath(d, path);
          if (Array.isArray(value)) {
            if (value.length === 0 && preserveNull) out.push(d);
            value.forEach((item, index) => {
              const copy = structuredClone(d);
              setPath(copy, path, item);
              if (uspec.includeArrayIndex) copy[uspec.includeArrayIndex as string] = index;
              out.push(copy);
            });
          } else if (value !== undefined && value !== null) {
            out.push(d);
          } else if (preserveNull) {
            out.push(d);
          }
        }
        docs = out;
        break;
      }
      case '$sortByCount': {
        const path = String(spec).replace(/^\$/, '');
        const counts = new Map<unknown, number>();
        for (const d of docs) {
          const v = getPath(d, path);
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        docs = Array.from(counts.entries())
          .map(([_id, count]) => ({ _id, count }))
          .sort((a, b) => b.count - a.count);
        break;
      }
      case '$replaceRoot': {
        const newPath = (spec as Document).newRoot as string;
        docs = docs.map((d) => resolveExpression(d, newPath) as Document);
        break;
      }
      case '$facet': {
        const result: Document = {};
        for (const [name, subPipeline] of Object.entries(spec as Document)) {
          result[name] = runAggregate(docs, subPipeline as Pipeline, ctx, collectionName);
        }
        docs = [result];
        break;
      }
      case '$lookup': {
        const lspec = spec as Document;
        const from = String(lspec.from);
        const foreign = ctx.getCollectionDocs(from);
        if (!foreign || foreign.length === 0) {
          // Same-database equality lookups only; an unknown/empty collection yields [].
          docs = docs.map((d) => ({ ...d, [lspec.as as string]: [] }));
          break;
        }
        const localField = lspec.localField ? String(lspec.localField) : undefined;
        const foreignField = lspec.foreignField ? String(lspec.foreignField) : undefined;
        if (!localField || !foreignField) {
          throw new Error('Embedded $lookup supports equality (localField/foreignField) only');
        }
        const index = new Map<string, Document[]>();
        for (const f of foreign) {
          const key = String(getPath(f, foreignField) ?? '');
          const list = index.get(key) ?? [];
          list.push(f);
          index.set(key, list);
        }
        docs = docs.map((d) => {
          const key = String(getPath(d, localField) ?? '');
          return { ...d, [lspec.as as string]: (index.get(key) ?? []).map((x) => structuredClone(x)) };
        });
        break;
      }
      case '$out':
      case '$merge':
        throw new Error(`"${op}" is not supported by the embedded driver`);
      default:
        throw new Error(`Unsupported aggregation stage "${op}" in the embedded driver`);
    }
  }

  return docs;
}

