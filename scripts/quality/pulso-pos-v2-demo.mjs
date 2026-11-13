// Deterministic synthetic walkthrough. NO Supabase, real stock reservations or payments.
import {
  createOfferDraft, transitionOffer, assessOffer, quotePublishedOffer,
} from '../../src/modules/pos-v2/domain/offer.mjs';

const siteId = 'SITE_SYNTHETIC';
const actorId = 'MANAGER_SYNTHETIC';
const at = '2026-10-22T12:01:00.000Z';
const authorise = (type) => ({
  allowed: true, actorId, siteId,
  action: 'pos_v2.offer.' + type.toLowerCase(),
  decisionId: 'SYNTHETIC-DECISION-' + type,
  expiresAt: '2026-10-23T00:00:00.000Z',
});
let offer = createOfferDraft({
  offerId: 'OFFER_SYNTHETIC_001', siteId,
  productId: 'NEXO_PRODUCT_SYNTHETIC', recipeId: 'FOGO_RECIPE_SYNTHETIC',
  unitPriceCop: 12000, unitDiscountCop: 1000,
  taxBps: 1900, taxMode: 'INCLUSIVE',
  channels: ['counter', 'table'],
  validFrom: '2026-10-22T12:00:00.000Z',
  validUntil: '2026-10-23T12:00:00.000Z',
  actorId: 'EDITOR_SYNTHETIC', at: '2026-10-22T12:00:00.000Z',
});
offer = transitionOffer(offer, {
  type: 'APPROVE', actorId, at,
  decision: authorise('APPROVE'),
});
offer = transitionOffer(offer, {
  type: 'PUBLISH', actorId,
  at: '2026-10-22T12:02:00.000Z',
  decision: authorise('PUBLISH'),
});
const input = {
  siteId, channel: 'counter', quantityMilli: 2000,
  requestKey: 'SYNTHETIC-REQUEST-0001',
  at: '2026-10-22T12:03:00.000Z',
  evidence: {
    nexo: {
      owner: 'NEXO', reference: 'SYNTHETIC-STOCK-READ-001',
      productId: offer.productId, siteId, availableQuantityMilli: 5000,
      observedAt: '2026-10-22T12:02:00.000Z',
      expiresAt: '2026-10-22T12:15:00.000Z',
    },
    fogo: {
      owner: 'FOGO', reference: 'SYNTHETIC-RECIPE-READY-001',
      recipeId: offer.recipeId, siteId, ready: true,
      observedAt: '2026-10-22T12:02:00.000Z',
      expiresAt: '2026-10-22T12:12:00.000Z',
    },
  },
};
const check = assessOffer(offer, input);
const quote = quotePublishedOffer(offer, input);
process.stdout.write(JSON.stringify({
  scenario: 'SYNTHETIC_ONLY_NO_COMMERCIAL_SALE',
  state: offer.status, offerRevision: offer.revision,
  auditActions: offer.audit.map(event => event.type),
  availability: check, quote,
  actualInventoryReserved: false,
  moneyCaptured: false,
  saleCommitted: false,
  productionEnabled: false,
}, null, 2) + '\n');