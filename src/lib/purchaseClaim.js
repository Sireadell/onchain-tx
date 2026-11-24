// Reads a purchase claim written as a question ("verify order #ABC from The
// Gadget Hub: a Wireless Mouse for $25.99 and a USB-C Hub for $49.50, total
// $75.49, was the payment authorized?") and checks what can be checked from
// the text alone: that the stated item prices add up to the stated total. A
// merchant's own order system and a card processor's records are not public,
// so the order itself is reported as unverified, never as a mismatch.

const MONEY = String.raw`(?:US)?\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
const toNum = (s) => Number(String(s).replace(/,/g, ''));
const usd = (n) => `$${n.toFixed(2)}`;

export function readClaim(text) {
  const t = String(text ?? '');
  const order = t.match(/\b(?:order|purchase)(?:\s+(?:number|no\.?|id|#))?\s*(?:is\s+)?[:#]?\s*['"“]?\s*(?:#|number\s+|id\s+)?\s*((?=[A-Z-]*\d)[A-Z0-9][A-Z0-9-]{3,})/i)?.[1]
    ?? t.match(/#\s?((?=[A-Z-]*\d)[A-Z0-9][A-Z0-9-]{3,})/i)?.[1] ?? null;
  const merchant = t.match(/\bfrom\s+(?:the\s+)?['"“]([^'"”]{2,60})['"”]/i)?.[1]
    ?? t.match(/\b(?:from|at|on)\s+((?:[A-Z][\w&.'-]*\s?){1,4})(?=[,.?]|\s+(?:with|for|order|and|totaling|that|I|on)\b)/)?.[1]?.trim()
    ?? t.match(/\bfor\s+['"“]([^'"”]{2,60})['"”]\?/i)?.[1] ?? null;

  // Every dollar amount, in order. The one after a total word is the total;
  // with a single amount and no total word ("order #X for $75.50"), that
  // amount is the total; every other amount is an item price.
  const amounts = [];
  const moneyRe = new RegExp(MONEY, 'g');
  let m;
  while ((m = moneyRe.exec(t))) amounts.push({ value: toNum(m[1]), index: m.index, end: m.index + m[0].length });
  const isTotal = (a) => /(?:total(?:ing|led|ed)?|total (?:charge|amount|price|cost)|charged(?:\s+to\s+my\s+\w+)?|charge|amount|sum)\s*(?:of|was|is|should be|comes to|came to|amounting to|:|=)?\s*(?:about\s+)?$/i
    .test(t.slice(Math.max(0, a.index - 40), a.index));
  let totalAt = amounts.findIndex(isTotal);
  if (totalAt < 0 && amounts.length === 1) totalAt = 0;
  const total = totalAt >= 0 ? amounts[totalAt].value : null;

  const items = amounts.filter((_, i) => i !== totalAt).map((a) => {
    // Only the text since the previous amount or clause break can name this item.
    let before = t.slice(Math.max(0, a.index - 80), a.index);
    before = before.split(/\$\s?[\d,.]+|[,;:?]|\band\b|\binclud(?:e|es|ed|ing)\b|\bshows?\b|\bconfirmation of\b|\.\s/i).pop();
    const quoted = [...before.matchAll(/['"“]([^'"”]{2,70})['"”]/g)].pop()?.[1];
    const words = before.replace(/\s+(?:for|at|costing|priced at|\()\s*$/i, '')
      .replace(/^\s*(?:(?:a|an|the|one|two|it|should|I'?m|looking|for|of|with|items?)\s+)+/i, '').trim();
    return { name: (quoted ?? (words || 'item')).replace(/\s+/g, ' ').trim(), price: a.value };
  });
  const askedPayment = /\b(authori[sz]ed|payment|paid|charged|charge)\b/i.test(t);
  const askedShipping = /\b(shipped|delivered|delivery|shipping)\b/i.test(t);
  return { order, merchant, total, items, askedPayment, askedShipping };
}

export function checkClaim(text) {
  const c = readClaim(text);
  if (!c.order && !c.items.length && c.total == null) return null;
  const sum = Number(c.items.reduce((a, i) => a + i.price, 0).toFixed(2));
  let arithmetic = null;
  if (c.items.length >= 1 && c.total != null) {
    const diff = Number((c.total - sum).toFixed(2));
    arithmetic = { items_sum: sum, stated_total: c.total, difference: diff, adds_up: Math.abs(diff) < 0.005 };
  }
  const who = [c.order ? `Order ${c.order}` : 'The order', c.merchant ? `from ${c.merchant}` : null].filter(Boolean).join(' ');
  const parts = [`Unverified. ${who} cannot be confirmed: the merchant's order records are not public and no receipt, payment or delivery record was supplied.`];
  if (arithmetic) {
    const list = c.items.map((i) => `${i.name} ${usd(i.price)}`).join(' + ');
    if (arithmetic.adds_up) {
      parts.push(`The claim is internally consistent: ${list} = ${usd(sum)}, which matches the stated total of ${usd(c.total)}.`);
    } else if (arithmetic.difference > 0) {
      parts.push(`The stated items do not add up to the total: ${list} = ${usd(sum)}, against a stated total of ${usd(c.total)}, a gap of ${usd(arithmetic.difference)} (about ${((arithmetic.difference / sum) * 100).toFixed(1)}% of the items) that tax, shipping or a missing item would have to explain.`);
    } else {
      parts.push(`The stated items come to more than the total: ${list} = ${usd(sum)}, against a stated total of ${usd(c.total)}, ${usd(-arithmetic.difference)} short, so a discount or a wrong price would have to explain it.`);
    }
  } else if (c.total != null) {
    parts.push(`The stated total is ${usd(c.total)}; no item prices were given to check it against.`);
  } else if (c.items.length) {
    parts.push(`The stated items come to ${usd(sum)}; no total was given to check them against.`);
  }
  if (c.askedPayment) parts.push('Payment authorization cannot be confirmed without the card processor or merchant record.');
  if (c.askedShipping) parts.push('Shipping status needs the carrier tracking number.');
  parts.push('To verify it, check the order page or confirmation email from the merchant, and the matching line on the card or bank statement.');
  const answer = parts.join(' ');
  return {
    verdict: 'Unverified',
    status_detail: 'unverified',
    answer,
    order_id: c.order,
    merchant: c.merchant,
    stated_total: c.total,
    items: c.items,
    arithmetic,
  };
}
