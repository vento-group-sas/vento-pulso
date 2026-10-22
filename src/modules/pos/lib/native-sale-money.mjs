// PULSO native POS: pure quotation; never captures payments or changes inventory.
const positive=(x,n,zero=false)=>{if(!Number.isSafeInteger(x)||(zero?x<0:x<=0))throw new RangeError(n);return x};
const add=(x,y)=>{const z=x+y;if(!Number.isSafeInteger(z))throw new RangeError('money_overflow');return z};
const halfUp=(a,b)=>{const z=(a+b/2n)/b;if(z>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('money_overflow');return Number(z)};
export function quoteSale(lines,{idempotencyKey,tipCop=0}={}){
  if(typeof idempotencyKey!=='string'||!/^[a-zA-Z0-9_-]{16,128}$/.test(idempotencyKey))throw new TypeError('idempotency_key_required');
  if(!Array.isArray(lines)||lines.length<1||lines.length>200)throw new RangeError('sale_lines_invalid');
  positive(tipCop,'tip_invalid',true);
  let subtotal=0,discount=0,tax=0,total=0;
  const snapshot=lines.map(line=>{
    if(typeof line?.productId!=='string'||!line.productId.trim())throw new TypeError('product_required');
    const qty=positive(line.quantityMilli,'quantity_invalid');
    const price=positive(line.unitPriceCop,'price_invalid',true);
    const reduction=positive(line.discountCop??0,'discount_invalid',true);
    const rate=positive(line.taxBps??0,'tax_invalid',true);
    if(rate>10000)throw new RangeError('tax_rate_invalid');
    const base=halfUp(BigInt(qty)*BigInt(price),1000n);
    if(reduction>base)throw new RangeError('discount_exceeds_subtotal');
    const lineTax=halfUp(BigInt(base-reduction)*BigInt(rate),10000n);
    const amount=add(base-reduction,lineTax);
    subtotal=add(subtotal,base);discount=add(discount,reduction);tax=add(tax,lineTax);total=add(total,amount);
    return Object.freeze({productId:line.productId.trim(),quantityMilli:qty,unitPriceCop:price,discountCop:reduction,taxBps:rate,subtotalCop:base,taxCop:lineTax,totalCop:amount});
  });
  return Object.freeze({idempotencyKey,currency:'COP',lines:Object.freeze(snapshot),subtotalCop:subtotal,discountCop:discount,taxCop:tax,tipCop,dueCop:add(total,tipCop)});
}
export function quoteTenders(quote,tenders){
  if(!quote||quote.currency!=='COP'||!Number.isSafeInteger(quote.dueCop)||quote.dueCop<0)throw new TypeError('quote_invalid');
  if(!Array.isArray(tenders)||tenders.length<1||tenders.length>12)throw new RangeError('tenders_invalid');
  let paid=0,cash=0;
  const out=tenders.map(t=>{
    if(!['cash','card','transfer','digital'].includes(t?.method))throw new TypeError('tender_method_invalid');
    const amount=positive(t.amountCop,'tender_amount_invalid');
    paid=add(paid,amount);if(t.method==='cash')cash=add(cash,amount);
    return Object.freeze({method:t.method,amountCop:amount});
  });
  if(paid<quote.dueCop)throw new RangeError('payment_incomplete');
  const change=paid-quote.dueCop;
  if(change>cash)throw new RangeError('noncash_change_forbidden');
  return Object.freeze({currency:'COP',dueCop:quote.dueCop,paidCop:paid,changeCop:change,tenders:Object.freeze(out),status:'QUOTED_NOT_CAPTURED'});
}
