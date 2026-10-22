import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOfferDraft, transitionOffer, assessOffer, quotePublishedOffer,
} from '../../src/modules/pos-v2/domain/offer.mjs';

const AT = '2026-10-22T12:03:00.000Z';
function draft(patch = {}) {
  return createOfferDraft({
    offerId: 'OFFER_V2_001', siteId: 'SITE_A', productId: 'NEXO_PRODUCT_A',
    recipeId: null, unitPriceCop: 10000, unitDiscountCop: 1000,
    taxBps: 1900, taxMode: 'EXCLUSIVE',
    channels: ['counter', 'table'],
    validFrom: '2026-10-22T12:00:00.000Z',
    validUntil: '2026-10-23T12:00:00.000Z',
    actorId: 'EDITOR_A', at: '2026-10-22T12:00:00.000Z',
    ...patch,
  });
}
function command(type, extras = {}) {
  const actorId = extras.actorId ?? 'MANAGER_A';
  const at = extras.at ?? '2026-10-22T12:01:00.000Z';
  return {
    type, actorId, at,
    decision: { allowed: true, action: 'pos_v2.offer.' + type.toLowerCase(),
      actorId, siteId: 'SITE_A', decisionId: type + '-DECISION-1',
      expiresAt: '2026-10-23T23:00:00.000Z' },
    ...extras,
  };
}
function published(patch = {}) {
  let offer = draft(patch);
  offer = transitionOffer(offer, command('APPROVE'));
  return transitionOffer(offer, command('PUBLISH', { at: '2026-10-22T12:02:00.000Z' }));
}
function evidence(offer, extras = {}) {
  return {
    nexo: { owner: 'NEXO', reference: 'NEXO-READ-01', siteId: offer.siteId,
      productId: offer.productId, availableQuantityMilli: 5000,
      observedAt: '2026-10-22T12:02:00.000Z', expiresAt: '2026-10-22T12:10:00.000Z' },
    ...(offer.recipeId ? { fogo: { owner: 'FOGO', reference: 'FOGO-READY-01',
      recipeId: offer.recipeId, siteId: offer.siteId, ready: true,
      observedAt: '2026-10-22T12:02:00.000Z', expiresAt: '2026-10-22T12:09:00.000Z' } } : {}),
    ...extras,
  };
}
function input(offer, extras = {}) {
  return { siteId: offer.siteId, channel: 'counter', quantityMilli: 1000,
    at: AT, evidence: evidence(offer), requestKey: 'POS-V2-REQUEST-00001', ...extras };
}

test('V2-01 draft has no publication and preserves immutable audit', () => {
  const offer = draft();
  assert.equal(offer.status, 'DRAFT');
  assert.equal(offer.revision, 1);
  assert.equal(offer.audit[0].type, 'DRAFT_CREATED');
  assert.ok(Object.isFrozen(offer.channels));
  assert.ok(Object.isFrozen(offer.audit));
  assert.throws(() => { offer.unitPriceCop = 1; }, TypeError);
});
test('V2-02 overposting and unknown fields fail closed', () => {
  assert.throws(() => draft({ legacyPosId: 'Makos' }), /unsupported_field_legacyPosId/);
  assert.throws(() => draft({ productId: '' }), /nexo_product_id_invalid/);
});
test('V2-03 price, tax and channel definition validated', () => {
  assert.throws(() => draft({ unitPriceCop: -1 }), /unit_price_invalid/);
  assert.throws(() => draft({ unitDiscountCop: 11000 }), /discount_exceeds_unit_price/);
  assert.throws(() => draft({ taxBps: 11000 }), /tax_rate_out_of_range/);
  assert.throws(() => draft({ taxMode: 'UNKNOWN' }), /tax_mode_unsupported/);
  assert.throws(() => draft({ channels: ['counter', 'counter'] }), /channel_invalid/);
});
test('V2-04 POS externo is not an offer channel', () => {
  assert.throws(() => draft({ channels: ['external_pos'] }), /channel_invalid/);
});
test('V2-05 approval requires a trusted-decision-shaped record', () => {
  assert.throws(() => transitionOffer(draft(), command('APPROVE', { decision: null })), /authorization_decision_required/);
  assert.throws(() => transitionOffer(draft(), command('APPROVE', {
    decision: { ...command('APPROVE').decision, allowed: false },
  })), /authorization_decision_required/);
});
test('V2-06 decision cannot authorize a different actor or site', () => {
  const o = draft();
  for (const alteration of [{ actorId: 'SOMEONE_ELSE' }, { siteId: 'SITE_B' }, { action: 'pos_v2.offer.retire' }]) {
    assert.throws(() => transitionOffer(o, command('APPROVE', {
      decision: { ...command('APPROVE').decision, ...alteration },
    })), /authorization_decision_required/);
  }
});
test('V2-07 expired decision fails closed', () => {
  assert.throws(() => transitionOffer(draft(), command('APPROVE', {
    decision: { ...command('APPROVE').decision, expiresAt: '2026-10-22T12:00:01.000Z' },
  })), /authorization_decision_required/);
});
test('V2-08 draft cannot publish before approval', () => {
  assert.throws(() => transitionOffer(draft(), command('PUBLISH')), /offer_transition_invalid/);
});
test('V2-09 approval plus publication forms sequential auditable revisions', () => {
  const p = published();
  assert.equal(p.status, 'PUBLISHED');
  assert.equal(p.revision, 1);
  assert.deepEqual(p.audit.map(e => e.sequence), [1, 2, 3]);
  assert.deepEqual(p.audit.map(e => e.type), ['DRAFT_CREATED', 'APPROVE', 'PUBLISH']);
  assert.ok(p.audit[1].decisionId);
  assert.equal(p.approvedBy, 'MANAGER_A');
});
test('V2-10 no publication outside validity window', () => {
  let o = draft({ validFrom: '2026-10-23T12:00:00.000Z', validUntil: '2026-10-24T12:00:00.000Z' });
  o = transitionOffer(o, command('APPROVE'));
  assert.throws(() => transitionOffer(o, command('PUBLISH', { at: '2026-10-22T12:02:00.000Z' })), /offer_outside_validity/);
});
test('V2-11 editing approved offer resets authorization and increments version', () => {
  let o = transitionOffer(draft(), command('APPROVE'));
  o = transitionOffer(o, command('REVISE', { at: '2026-10-22T12:02:00.000Z',
    changes: { unitPriceCop: 22000 } }));
  assert.equal(o.status, 'DRAFT');
  assert.equal(o.revision, 2);
  assert.equal(o.approvedAt, null);
  assert.throws(() => transitionOffer(o, command('PUBLISH', { at: AT })), /offer_transition_invalid/);
  assert.equal(o.unitPriceCop, 22000);
});
test('V2-12 revisions may not reassign product or site', () => {
  assert.throws(() => transitionOffer(draft(), command('REVISE', { changes: { siteId: 'SITE_B' } })), /unsupported_field_siteId/);
  assert.throws(() => transitionOffer(draft(), command('REVISE', { changes: {} })), /revision_changes_required/);
});
test('V2-13 suspend, resume, retire require correct state and reason', () => {
  let o = published();
  assert.throws(() => transitionOffer(o, command('SUSPEND', { at: AT })), /transition_reason_required/);
  o = transitionOffer(o, command('SUSPEND', { at: AT, reason: 'Sin capacidad de entrega' }));
  assert.equal(o.status, 'SUSPENDED');
  assert.equal(assessOffer(o, input(o)).sellable, false);
  o = transitionOffer(o, command('RESUME', { at: '2026-10-22T12:04:00.000Z' }));
  assert.equal(o.status, 'PUBLISHED');
  o = transitionOffer(o, command('RETIRE', { at: '2026-10-22T12:05:00.000Z', reason: 'Retiro definitivo de oferta' }));
  assert.equal(o.status, 'RETIRED');
  assert.throws(() => transitionOffer(o, command('APPROVE', { at: '2026-10-22T12:06:00.000Z' })), /offer_transition_invalid/);
});
test('V2-14 timestamps cannot go backwards', () => {
  assert.throws(() => transitionOffer(published(), command('SUSPEND', { at: '2026-10-22T11:59:00.000Z', reason: 'Suspensión controlada' })), /event_time_regression/);
});
test('V2-15 no quote from draft or approved offer', () => {
  assert.equal(assessOffer(draft(), input(draft())).reason, 'NOT_PUBLISHED');
  assert.throws(() => quotePublishedOffer(draft(), input(draft())), /offer_not_sellable_NOT_PUBLISHED/);
});
test('V2-16 site and channel mismatches deny selection', () => {
  const o = published();
  assert.equal(assessOffer(o, input(o, { siteId: 'SITE_B' })).reason, 'SITE_MISMATCH');
  assert.equal(assessOffer(o, input(o, { channel: 'web' })).reason, 'CHANNEL_NOT_APPROVED');
});
test('V2-17 absence of NEXO availability denies quote', () => {
  const o = published();
  assert.equal(assessOffer(o, input(o, { evidence: {} })).reason, 'NEXO_STOCK_UNVERIFIED');
  assert.throws(() => quotePublishedOffer(o, input(o, { evidence: {} })), /NEXO_STOCK_UNVERIFIED/);
});
test('V2-18 wrong NEXO product and insufficient stock fail closed', () => {
  const o = published(); const e = evidence(o);
  assert.equal(assessOffer(o, input(o, { evidence: { nexo: { ...e.nexo, productId: 'OTHER' } } })).sellable, false);
  assert.equal(assessOffer(o, input(o, { quantityMilli: 6000 })).reason, 'NEXO_STOCK_UNVERIFIED');
});
test('V2-19 stale and future NEXO observations deny quote', () => {
  const o = published();const e = evidence(o);
  assert.equal(assessOffer(o, input(o, { evidence: { nexo: { ...e.nexo, expiresAt: AT } } })).reason, 'NEXO_STOCK_STALE');
  assert.equal(assessOffer(o, input(o, { evidence: { nexo: { ...e.nexo, observedAt: '2026-10-22T13:00:00.000Z' } } })).reason, 'NEXO_STOCK_STALE');
});
test('V2-20 offers with FOGO recipe require FOGO confirmation', () => {
  const o = published({ recipeId: 'FOGO_RECIPE_A' });
  assert.equal(assessOffer(o, input(o, { evidence: { nexo: evidence(o).nexo } })).reason, 'FOGO_RECIPE_UNVERIFIED');
  assert.equal(assessOffer(o, input(o)).sellable, true);
  assert.equal(quotePublishedOffer(o, input(o)).fogoReference, 'FOGO-READY-01');
});
test('V2-21 FOGO readiness and freshness deny if missing', () => {
  const o = published({ recipeId: 'FOGO_RECIPE_A' });const e = evidence(o);
  assert.equal(assessOffer(o, input(o, { evidence: { ...e, fogo: { ...e.fogo, ready: false } } })).reason, 'FOGO_RECIPE_UNVERIFIED');
  assert.equal(assessOffer(o, input(o, { evidence: { ...e, fogo: { ...e.fogo, expiresAt: AT } } })).reason, 'FOGO_RECIPE_STALE');
});
test('V2-22 exclusive taxes, discounts and owner references are snapshotted', () => {
  const o = published(), q = quotePublishedOffer(o, input(o));
  assert.equal(q.status, 'PREVIEW_NOT_RESERVED');
  assert.equal(q.grossCop, 10000);
  assert.equal(q.discountCop, 1000);
  assert.equal(q.netCop, 9000);
  assert.equal(q.taxCop, 1710);
  assert.equal(q.totalCop, 10710);
  assert.equal(q.nexoReference, 'NEXO-READ-01');
  assert.equal(q.siteId, 'SITE_A');
  assert.equal(q.offerRevision, 1);
});
test('V2-23 inclusive tax separates net without charging tax twice', () => {
  const o = published({ unitPriceCop: 11900, unitDiscountCop: 0, taxMode: 'INCLUSIVE' });
  const q = quotePublishedOffer(o, input(o));
  assert.equal(q.totalCop, 11900);
  assert.equal(q.netCop, 10000);
  assert.equal(q.taxCop, 1900);
});
test('V2-24 fractional quantity rounds COP once and consistently', () => {
  const o = published({ unitPriceCop: 999, unitDiscountCop: 0, taxBps: 0 });
  assert.equal(quotePublishedOffer(o, input(o, { quantityMilli: 1250 })).totalCop, 1249);
});
test('V2-25 overflow is rejected and cannot silently lose money', () => {
  const o = published({ unitPriceCop: Number.MAX_SAFE_INTEGER, unitDiscountCop: 0, taxBps: 0 });
  assert.throws(() => quotePublishedOffer(o, input(o, { quantityMilli: 5000 })), /money_overflow/);
});
test('V2-26 quote has immutable price and provenance', () => {
  const o = published();
  const q = quotePublishedOffer(o, input(o));
  assert.ok(Object.isFrozen(q));
  assert.throws(() => { q.totalCop = 1; }, TypeError);
  assert.equal(o.unitPriceCop, q.unitPriceCop);
  assert.equal(q.currency, 'COP');
});
test('V2-27 short request identifiers cannot be mistaken for idempotency evidence', () => {
  const o = published();
  assert.throws(() => quotePublishedOffer(o, input(o, { requestKey: 'abc' })), /request_key_too_short/);
  assert.equal(quotePublishedOffer(o, input(o)).requestKey, 'POS-V2-REQUEST-00001');
});
test('V2-28 expired commercial offers cannot be quoted', () => {
  const o = published();
  assert.equal(assessOffer(o, input(o, { at: '2026-10-23T12:00:00.000Z' })).reason, 'OUTSIDE_VALIDITY');
});
test('V2-29 no legacy POS imports are present in V2 domain module', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../src/modules/pos-v2/domain/offer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"][^'"]*(?:\/pos\/|sales-imports)|\.from\(|\.rpc\(|process_order_payment|pulso_post_daily_sales_import|makos/i);
});