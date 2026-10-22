// PULSO POS V2: authority-neutral, pure commercial-offer domain.
// No V1 imports; no Supabase, SQL, payment, reservation or side effects.
const DOMAIN = 'PULSO_POS_V2_OFFER';
const CHANNELS = new Set(['counter', 'table', 'pickup', 'delivery', 'web', 'marketplace', 'messaging']);
const TAX_MODES = new Set(['EXCLUSIVE', 'INCLUSIVE']);

function fail(code, Type = Error) {
  throw new Type(code);
}
function id(value, name) {
  if (typeof value !== 'string' || !/^[\w.:-]{1,96}$/.test(value)) fail(name + '_invalid', TypeError);
  return value;
}
function cop(value, name, allowZero = true) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) fail(name + '_invalid', RangeError);
  return value;
}
function utc(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    fail(name + '_invalid', TypeError);
  }
  const timestamp = Date.parse(value);
  const timestampParts = value.slice(0, -1).split('.');
  const canonical = timestampParts[0] + '.' + (timestampParts[1] ?? '').padEnd(3, '0') + 'Z';
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== canonical) {
    fail(name + '_invalid', TypeError);
  }
  return timestamp;
}
function channels(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > CHANNELS.size) {
    fail('channels_invalid', RangeError);
  }
  const found = new Set();
  for (const channel of value) {
    if (!CHANNELS.has(channel) || found.has(channel)) fail('channel_invalid', TypeError);
    found.add(channel);
  }
  return Object.freeze([...found].sort());
}
function freeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function allowedKeys(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('payload_invalid', TypeError);
  for (const key of Object.keys(value)) if (!names.includes(key)) fail('unsupported_field_' + key, TypeError);
}
function validateTerms(input) {
  const terms = {
    unitPriceCop: cop(input.unitPriceCop, 'unit_price'),
    unitDiscountCop: cop(input.unitDiscountCop ?? 0, 'unit_discount'),
    taxBps: cop(input.taxBps, 'tax_rate'),
    taxMode: input.taxMode,
    channels: channels(input.channels),
    validFrom: input.validFrom,
    validUntil: input.validUntil,
  };
  if (terms.unitDiscountCop > terms.unitPriceCop) fail('discount_exceeds_unit_price', RangeError);
  if (terms.taxBps > 10000) fail('tax_rate_out_of_range', RangeError);
  if (!TAX_MODES.has(terms.taxMode)) fail('tax_mode_unsupported', TypeError);
  if (utc(terms.validUntil, 'valid_until') <= utc(terms.validFrom, 'valid_from')) {
    fail('validity_window_invalid', RangeError);
  }
  return terms;
}
function offerCheck(offer) {
  if (!offer || offer.domain !== DOMAIN || !Number.isSafeInteger(offer.revision) || offer.revision < 1) {
    fail('pos_v2_offer_required', TypeError);
  }
}
function auditEvent(type, from, to, actorId, at, revision, decisionId = null, reason = null) {
  return freeze({ sequence: null, type, from, to, actorId, at, revision, decisionId, reason });
}
function appendEvent(offer, type, nextStatus, actorId, at, decisionId = null, reason = null) {
  const event = { ...auditEvent(type, offer.status, nextStatus, actorId, at, offer.revision, decisionId, reason),
    sequence: offer.audit.length + 1 };
  return freeze([...offer.audit, freeze(event)]);
}
function actorAuthorization(offer, { actorId, decision, type, at }) {
  id(actorId, 'actor');
  if (!decision || decision.allowed !== true || decision.actorId !== actorId ||
      decision.siteId !== offer.siteId || decision.action !== 'pos_v2.offer.' + type.toLowerCase() ||
      typeof decision.decisionId !== 'string' || !decision.decisionId.trim() ||
      utc(decision.expiresAt, 'decision_expiry') <= utc(at, 'at')) {
    fail('authorization_decision_required');
  }
  return decision.decisionId;
}
function validateMoment(offer, at) {
  const t = utc(at, 'at');
  if (t < utc(offer.audit.at(-1).at, 'audit_at')) fail('event_time_regression');
  return t;
}

export function createOfferDraft(input) {
  allowedKeys(input, ['offerId', 'siteId', 'productId', 'recipeId', 'unitPriceCop',
    'unitDiscountCop', 'taxBps', 'taxMode', 'channels', 'validFrom', 'validUntil',
    'actorId', 'at']);
  const offerId = id(input.offerId, 'offer_id');
  const siteId = id(input.siteId, 'site_id');
  const productId = id(input.productId, 'nexo_product_id');
  const recipeId = input.recipeId == null ? null : id(input.recipeId, 'fogo_recipe_id');
  const actorId = id(input.actorId, 'actor');
  utc(input.at, 'at');
  const terms = validateTerms(input);
  const event = freeze({ ...auditEvent('DRAFT_CREATED', null, 'DRAFT', actorId, input.at, 1), sequence: 1 });
  return freeze({
    domain: DOMAIN, offerId, siteId, productId, recipeId,
    ...terms, currency: 'COP', revision: 1, status: 'DRAFT',
    approvedBy: null, approvedAt: null, publishedAt: null,
    createdBy: actorId, audit: [event],
  });
}

// The decision MUST be resolved by the trusted server, never received from a client.
// This pure-domain check is not a replacement for authorization at the DB/RPC boundary.
export function transitionOffer(offer, command) {
  offerCheck(offer);
  allowedKeys(command, ['type', 'actorId', 'decision', 'at', 'reason', 'changes']);
  const at = command.at;
  const t = validateMoment(offer, at);
  const type = command.type;
  if (!['APPROVE', 'PUBLISH', 'SUSPEND', 'RESUME', 'REVISE', 'RETIRE'].includes(type)) {
    fail('offer_transition_unknown');
  }
  const decisionId = actorAuthorization(offer, { ...command, type });
  const statuses = {
    APPROVE: ['DRAFT'],
    PUBLISH: ['APPROVED'],
    SUSPEND: ['PUBLISHED'],
    RESUME: ['SUSPENDED'],
    REVISE: ['DRAFT', 'APPROVED', 'SUSPENDED'],
    RETIRE: ['DRAFT', 'APPROVED', 'PUBLISHED', 'SUSPENDED'],
  };
  if (!statuses[type].includes(offer.status)) fail('offer_transition_invalid');
  if (['PUBLISH', 'RESUME'].includes(type) &&
    (t < utc(offer.validFrom, 'valid_from') || t >= utc(offer.validUntil, 'valid_until'))) {
    fail('offer_outside_validity');
  }
  if (['RETIRE', 'SUSPEND'].includes(type) &&
      (typeof command.reason !== 'string' || command.reason.trim().length < 8)) {
    fail('transition_reason_required');
  }

  let updated = { ...offer };
  if (type === 'REVISE') {
    const changes = command.changes;
    allowedKeys(changes, ['unitPriceCop', 'unitDiscountCop', 'taxBps', 'taxMode',
      'channels', 'validFrom', 'validUntil']);
    if (Object.keys(changes).length === 0) fail('revision_changes_required');
    const terms = validateTerms({ ...offer, ...changes });
    updated = { ...updated, ...terms, revision: offer.revision + 1, status: 'DRAFT',
      approvedBy: null, approvedAt: null, publishedAt: null };
  } else if (type === 'APPROVE') {
    updated = { ...updated, status: 'APPROVED', approvedBy: command.actorId, approvedAt: at };
  } else if (type === 'PUBLISH' || type === 'RESUME') {
    updated = { ...updated, status: 'PUBLISHED', publishedAt: at };
  } else if (type === 'SUSPEND') {
    updated = { ...updated, status: 'SUSPENDED' };
  } else if (type === 'RETIRE') {
    updated = { ...updated, status: 'RETIRED' };
  }
  const reason = command.reason == null ? null : String(command.reason).trim();
  updated.audit = appendEvent(updated === offer ? offer : { ...offer, revision: updated.revision },
    type, updated.status, command.actorId, at, decisionId, reason);
  return freeze(updated);
}

function evidenceCheck(offer, siteId, at, qty, evidence) {
  const stock = evidence?.nexo;
  if (!stock || stock.owner !== 'NEXO' || stock.siteId !== siteId ||
    stock.productId !== offer.productId || typeof stock.reference !== 'string' ||
    !/^[\w.:-]{1,96}$/.test(stock.reference) ||
    !Number.isSafeInteger(stock.availableQuantityMilli) ||
    stock.availableQuantityMilli < qty) return { ok: false, reason: 'NEXO_STOCK_UNVERIFIED' };
  if (utc(stock.observedAt, 'nexo_observed') > at ||
      utc(stock.expiresAt, 'nexo_expiry') <= at) return { ok: false, reason: 'NEXO_STOCK_STALE' };
  let validUntil = utc(stock.expiresAt, 'nexo_expiry');
  if (offer.recipeId) {
    const recipe = evidence?.fogo;
    if (!recipe || recipe.owner !== 'FOGO' || recipe.siteId !== siteId ||
      recipe.recipeId !== offer.recipeId || recipe.ready !== true ||
      typeof recipe.reference !== 'string' || !/^[\w.:-]{1,96}$/.test(recipe.reference)) {
      return { ok: false, reason: 'FOGO_RECIPE_UNVERIFIED' };
    }
    if (utc(recipe.observedAt, 'fogo_observed') > at ||
      utc(recipe.expiresAt, 'fogo_expiry') <= at) return { ok: false, reason: 'FOGO_RECIPE_STALE' };
    validUntil = Math.min(validUntil, utc(recipe.expiresAt, 'fogo_expiry'));
  }
  return { ok: true, validUntil, stockRef: stock.reference,
    recipeRef: offer.recipeId ? evidence.fogo.reference : null };
}

export function assessOffer(offer, { siteId, channel, quantityMilli, at, evidence } = {}) {
  offerCheck(offer);
  const t = utc(at, 'at');
  const quantity = cop(quantityMilli, 'quantity', false);
  if (offer.status !== 'PUBLISHED') return freeze({ sellable: false, reason: 'NOT_PUBLISHED' });
  if (siteId !== offer.siteId) return freeze({ sellable: false, reason: 'SITE_MISMATCH' });
  if (!offer.channels.includes(channel)) return freeze({ sellable: false, reason: 'CHANNEL_NOT_APPROVED' });
  if (t < utc(offer.validFrom, 'valid_from') || t >= utc(offer.validUntil, 'valid_until')) {
    return freeze({ sellable: false, reason: 'OUTSIDE_VALIDITY' });
  }
  const result = evidenceCheck(offer, siteId, t, quantity, evidence);
  if (!result.ok) return freeze({ sellable: false, reason: result.reason });
  return freeze({ sellable: true, reason: 'PREVIEW_ONLY_NOT_RESERVED',
    expiresAt: new Date(Math.min(result.validUntil, utc(offer.validUntil, 'valid_until'))).toISOString(),
    nexoReference: result.stockRef, fogoReference: result.recipeRef });
}
function halfUp(numerator, denominator) {
  const value = (numerator + denominator / 2n) / denominator;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('money_overflow', RangeError);
  return Number(value);
}
function safeAdd(a, b) {
  const n = a + b;
  if (!Number.isSafeInteger(n)) fail('money_overflow', RangeError);
  return n;
}

export function quotePublishedOffer(offer, input) {
  const key = id(input?.requestKey, 'request_key');
  if (key.length < 16) fail('request_key_too_short', RangeError);
  const assessment = assessOffer(offer, input);
  if (!assessment.sellable) fail('offer_not_sellable_' + assessment.reason);
  const quantity = cop(input.quantityMilli, 'quantity', false);
  const gross = halfUp(BigInt(quantity) * BigInt(offer.unitPriceCop), 1000n);
  const discount = halfUp(BigInt(quantity) * BigInt(offer.unitDiscountCop), 1000n);
  if (discount > gross) fail('discount_exceeds_gross', RangeError);
  const discounted = gross - discount;
  const tax = offer.taxMode === 'INCLUSIVE'
    ? halfUp(BigInt(discounted) * BigInt(offer.taxBps), BigInt(10000 + offer.taxBps))
    : halfUp(BigInt(discounted) * BigInt(offer.taxBps), 10000n);
  const total = offer.taxMode === 'INCLUSIVE' ? discounted : safeAdd(discounted, tax);
  const net = offer.taxMode === 'INCLUSIVE' ? discounted - tax : discounted;
  return freeze({
    domain: 'PULSO_POS_V2_QUOTE',
    status: 'PREVIEW_NOT_RESERVED',
    requestKey: key, offerId: offer.offerId, offerRevision: offer.revision,
    productId: offer.productId, recipeId: offer.recipeId,
    siteId: offer.siteId, channel: input.channel, currency: 'COP',
    createdAt: input.at, expiresAt: assessment.expiresAt,
    quantityMilli: quantity, unitPriceCop: offer.unitPriceCop,
    unitDiscountCop: offer.unitDiscountCop, taxBps: offer.taxBps,
    taxMode: offer.taxMode,
    grossCop: gross, discountCop: discount, netCop: net, taxCop: tax, totalCop: total,
    nexoReference: assessment.nexoReference, fogoReference: assessment.fogoReference,
  });
}