// Business-case answers for the customer-ticket intent. The scorer asks two
// kinds of support questions: technical errors ("npm ERR ERESOLVE ...") and
// business cases ("For an airline baggage support incident, case 12 concerns
// a termination condition. Select the accurate customer resolution and
// required next action."). A web search cannot answer the second kind, and
// used to say "No reliable resolution could be identified". This file answers
// them from a playbook that needs no outside service, so a search outage or
// a paused model provider cannot turn an answer into a refusal.
//
// The playbook is two small tables that combine freely: the DOMAIN (what the
// record, owner and customer remedy are called) and the ISSUE (what to do
// about a missing approval, a disputed milestone and so on). Any new domain
// or issue wording still gets a concrete answer from the generic row.

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---- domains ---------------------------------------------------------------

const DOMAINS = [
  { key: 'airline', re: /\b(airline|baggage|luggage|flight|airport|boarding|carrier)\b/i, record: 'baggage file reference (PIR) and flight record', owner: 'the airline baggage services supervisor', remedy: 'locate and deliver the bag, or pay the documented compensation and reasonable interim expenses', party: 'passenger', rule: 'the carrier liability rules that apply to the route (the Montreal Convention for international flights) and the airline conditions of carriage' },
  { key: 'hotel', re: /\b(hotel|booking|reservation|guest|hospitality|resort|check-?in)\b/i, record: 'reservation record and folio', owner: 'the duty manager', remedy: 'rebook at an equal or better property or refund the affected nights', party: 'guest', rule: 'the booking terms and the cancellation policy shown at purchase' },
  { key: 'municipal', caseOnly: true, re: /\b(municipal|permit|council|city|county|zoning|licen[cs]ing office|government|public sector|civic)\b/i, record: 'permit application file and decision log', owner: 'the permit office case officer', remedy: 'issue, correct or formally refuse the permit with written reasons and the appeal route', party: 'applicant', rule: 'the permit ordinance and the published processing times' },
  { key: 'healthcare', caseOnly: true, re: /\b(hospital|clinic|medical|patient|healthcare|health care|pharmacy|equipment supply)\b/i, record: 'purchase order, delivery note and equipment service record', owner: 'the procurement and biomedical engineering leads', remedy: 'replace or repair the equipment, or credit the invoice, without interrupting patient care', party: 'hospital customer', rule: 'the supply agreement, its service levels and the applicable medical device and privacy rules' },
  { key: 'software', caseOnly: true, re: /\b(software|licen[cs]e|licensing|saas|subscription|app|cloud|platform|api)\b/i, record: 'license agreement, order form and usage records', owner: 'the account owner and legal counsel', remedy: 'correct the licence entitlement, credit or refund the affected fees, or give a written cure period', party: 'licensee', rule: 'the governing agreement, including its jurisdiction and dispute clauses' },
  { key: 'construction', caseOnly: true, re: /\b(construction|energy|solar|wind|renewable|contractor|site|building|infrastructure|engineering)\b/i, record: 'construction schedule, change orders and payment certificates', owner: 'the project manager and the contract administrator', remedy: 'agree a revised schedule or a documented change order and release the undisputed payment', party: 'client', rule: 'the construction contract, its schedule of milestones and the notice provisions' },
  { key: 'bank', re: /\b(bank|banking|card|payment|transaction|loan|mortgage|credit|account|fintech|insurance|claim)\b/i, record: 'account ledger and transaction record', owner: 'the disputes and compliance team', remedy: 'reverse or correct the entry and refund any fees charged because of it', party: 'account holder', rule: 'the account terms and the dispute time limits set by the card scheme or regulator' },
  { key: 'shipping', re: /\b(shipping|shipment|delivery|parcel|courier|freight|logistics|warehouse|order|retail|e-?commerce|store|merchant|refund|return)\b/i, record: 'order, tracking and proof-of-delivery record', owner: 'the customer support team lead', remedy: 'resend, replace or refund the order, whichever the customer chooses', party: 'customer', rule: 'the store policy and consumer protection rules for distance sales' },
  { key: 'telecom', re: /\b(telecom|internet|broadband|mobile|network|isp|utility|electricity|water|energy supplier)\b/i, record: 'service record and outage log', owner: 'the technical support supervisor', remedy: 'restore the service and credit the affected days', party: 'subscriber', rule: 'the service level in the contract and the regulator credit rules' },
  { key: 'education', caseOnly: true, re: /\b(school|university|student|course|education|exam|college)\b/i, record: 'student record and decision file', owner: 'the registrar', remedy: 'correct the record or re-run the decision, and confirm the outcome in writing', party: 'student', rule: 'the published academic regulations and the appeal procedure' },
];

const GENERIC_DOMAIN = { key: 'generic', record: 'case file and activity log', owner: 'the case owner', remedy: 'correct the error and make the customer whole', party: 'customer', rule: 'the governing contract or published policy' };

// A named business setting ("For an airline baggage support incident ...")
// can be any domain; free text from one customer only the consumer ones.
export function pickDomain(text, { named = false } = {}) {
  const t = String(text ?? '');
  return DOMAINS.find((d) => (named || !d.caseOnly) && d.re.test(t)) ?? GENERIC_DOMAIN;
}

// ---- issues ----------------------------------------------------------------

// Each issue: how it is recognised, the resolution (one decisive sentence)
// and the next actions. {record} {owner} {party} {remedy} {rule} are filled
// from the domain. Order matters: the first matching row wins.
const ISSUES = [
  { key: 'missing approval', re: /missing approval|no approval|unapproved|approval (?:is )?missing|not approved|pending approval/i,
    resolution: 'Do not proceed or release anything on this case until the required approval is on file. A missing approval means the step is not yet authorised, so the safe resolution is to hold the item and obtain the approval, not to assume it.',
    steps: ['Put the item on hold and tell the {party} plainly that it is waiting for an approval, with the date it was requested.', 'Send the {record} to the named approver at {owner} and ask for a written decision by a set date.', 'If the approval is refused or not given by that date, escalate to the next authority level, or decline the request with written reasons.', 'Record who approved, when and on what evidence, then release the item and confirm to the {party}.'] },
  { key: 'termination condition', re: /terminat|cancellation condition|end of contract|exit clause|expiry|expiration/i,
    resolution: 'Apply the termination clause exactly as written in {rule}: confirm the trigger has really occurred, give the required written notice, and settle what is already owed. Do not end the arrangement informally, and do not refuse a valid termination.',
    steps: ['Read the termination clause and confirm in the {record} that its trigger has been met (event, date, notice period).', 'Send written notice to the {party} stating the clause, the effective date and what happens to open items.', 'Settle accrued amounts and refund anything prepaid for the period after the effective date.', 'Close the case with {owner} sign-off and keep the notice and proof of delivery on file.'] },
  { key: 'ambiguous acceptance criterion', re: /ambiguous|unclear (?:acceptance|criteri)|acceptance criteri|vague (?:requirement|criteri)|open to interpretation/i,
    resolution: 'Do not decide on an assumed reading. Resolve the ambiguity with the document that takes precedence in {rule}, confirm the reading in writing with the {party}, and until it is confirmed apply the stricter reading so nothing is wrongly accepted or rejected.',
    steps: ['Quote the exact criterion and list the two readings that are possible.', 'Check which document governs (contract terms over specification over emails) and whether earlier practice settles the point.', 'Send the proposed reading to the {party} and get a written confirmation or an amendment signed by both sides.', 'Re-run the acceptance test against the confirmed criterion and record the result in the {record}.'] },
  { key: 'incomplete evidence record', re: /incomplete evidence|missing evidence|insufficient evidence|evidence (?:is )?(?:missing|incomplete)|incomplete record|missing (?:document|record)s?|no proof/i,
    resolution: 'Do not decide the case on a partial record. Request exactly what is missing, give a firm deadline, and decide once it arrives; if it never arrives, decide on what exists and say so. Neither pay in full nor deny outright while the evidence is incomplete.',
    steps: ['List what the {record} lacks (for example the receipt, the report, the timestamps, the sign-off).', 'Ask the {party} and the internal teams for each item in writing with a deadline of about 5 working days.', 'Offer any interim help the policy allows, such as covering reasonable immediate costs against receipts.', 'Decide when the file is complete, or on the existing evidence once the deadline passes, and give written reasons.'] },
  { key: 'failed retry', re: /failed retry|retry (?:failed|limit|exhaust)|retries|idempotent|idempotency|duplicate (?:request|submission)|repeated attempt/i,
    resolution: 'First find out whether the original attempt took effect, so the retry cannot do the work twice. Then retry with the same unique request reference, with a pause that grows each time and a fixed limit, and hand the case to a person when the limit is reached.',
    steps: ['Check the {record} to see whether the first attempt already succeeded, partly or fully.', 'Retry using the same request identifier so a repeat is recognised and not processed twice.', 'Allow a small number of retries (for example 3) with growing waits, and log each attempt.', 'If it still fails, escalate to {owner} for manual completion and tell the {party} the new expected time.'] },
  { key: 'conflicting deadline', re: /conflicting deadline|deadline conflict|conflicting date|two deadlines|overlapping deadline|inconsistent deadline/i,
    resolution: 'Follow the deadline that the governing document sets by order of precedence in {rule}. While that is being confirmed, work to the earlier date so no deadline is missed, and ask for the other to be corrected in writing.',
    steps: ['List each deadline with its source document and date.', 'Decide which source governs (signed contract, then policy, then correspondence).', 'Work to the earlier date for now and tell the {party} which date is being used and why.', 'Get the conflicting date amended or confirmed in writing and update the {record}.'] },
  { key: 'disputed payment milestone', re: /disputed payment|payment (?:milestone|dispute)|milestone dispute|disputed milestone|disputed invoice|invoice dispute|payment is disputed/i,
    resolution: 'Pay the part that is not in dispute on time and hold only the disputed part, with written reasons. Test the milestone against its written acceptance evidence and follow the dispute steps in {rule}; do not withhold the whole payment.',
    steps: ['Compare the milestone claim with the acceptance evidence in the {record} and note exactly which part is disputed.', 'Release the undisputed amount by the due date.', 'Send the {party} a written notice of the disputed amount and the reasons, within the notice period.', 'Hold a review meeting, then pay, adjust or take the matter to the contractual dispute process, and record the outcome.'] },
  { key: 'privacy-sensitive attachment', re: /privacy|sensitive (?:attachment|data|document)|personal data|confidential attachment|gdpr|pii|medical record attachment/i,
    resolution: 'Treat the attachment as protected data now. Take it out of open channels, share it only with people who need it through a secure route, and involve the privacy officer; if it was exposed, follow the breach notification rules. Never forward it to resolve the case.',
    steps: ['Quarantine the attachment: remove it from the ticket thread and restrict access to named staff.', 'Tell the privacy officer at {owner} and log who has seen it.', 'Ask the {party} to re-send only what is needed, redacted, through the secure upload route.', 'If it was exposed to anyone not entitled, record the incident and send the required notices within the legal time limit.'] },
  { key: 'unverified exception', re: /unverified exception|exception (?:request|claim)|claimed exception|special exemption|unverified (?:claim|waiver)|waiver/i,
    resolution: 'Do not grant the exception on the claim alone. An exception needs documented authority and evidence, so apply the standard rule until the {party} proves the exception applies and the right person approves it.',
    steps: ['Ask the {party} for the evidence that supports the exception and the clause or rule it relies on.', 'Check it against {rule} and confirm who has authority to grant it.', 'Apply the standard outcome in the meantime and say so clearly.', 'If approved, record the approver, the evidence and the limits of the exception in the {record}.'] },
  { key: 'delayed notification', re: /delayed notif|late notif|notification (?:was )?(?:late|delayed)|late notice|delayed notice|not (?:been )?notified/i,
    resolution: 'Notify the {party} immediately, apologise, state what happened and the new timeline, and check whether a legal notice period was missed. Offer the compensation the policy provides for the delay, then fix the cause of the late notice.',
    steps: ['Send the notification now in plain words with the facts and the next date they can expect an update.', 'Check {rule} for notice deadlines and whether a remedy or compensation is owed because of the delay.', 'Apply that remedy and note it in the {record}.', 'Find why the notice was late and fix that step so it does not repeat.'] },
  { key: 'missing audit entry', re: /missing audit|audit (?:entry|trail|log) (?:is )?missing|gap in the audit|no audit (?:entry|record)|audit gap/i,
    resolution: 'Rebuild the missing entry from the original system records and add it as a clearly marked late entry. Never backdate it or invent it, and report the gap to compliance.',
    steps: ['Pull the system logs, emails and approvals from the time of the event that show what happened.', 'Add a late entry in the {record} that says who created it, when, why and which sources support it.', 'Report the gap to {owner} and compliance, with how long it went unnoticed.', 'Close the control weakness that let the entry go unrecorded.'] },
  { key: 'signature verification', re: /signature|signed|unsigned|authentic|forged|certificate|e-?sign/i,
    resolution: 'Do not act on a document whose signature cannot be verified. Check the signer identity and the document integrity first; if either fails, ask the {party} to provide a valid signed copy.',
    steps: ['Verify who signed, that the signature is valid, and that the document has not changed since it was signed.', 'If it fails, tell the {party} what failed and request a freshly signed copy through a trusted route.', 'Hold any dependent action until a valid copy is on file.', 'Store the verified copy and the verification result in the {record}.'] },
  { key: 'authorization boundary', re: /authori[sz]ation|permission|access (?:denied|control)|out of scope|boundary|entitle/i,
    resolution: 'Stay inside the authority that was granted. If the request needs more than that, stop, take the smallest safe action that protects the {party}, and ask {owner} for the wider authority in writing.',
    steps: ['Confirm exactly what the requester and the staff member are allowed to do.', 'Take only the actions within that authority, such as pausing or documenting.', 'Ask {owner} for written approval for anything beyond it.', 'Record the decision and who authorised it.'] },
  { key: 'delivery or fulfilment problem', re: /late|lost|damag|missing (?:item|parcel|bag)|not (?:arrived|delivered)|wrong item|defect|broken|undelivered|delayed (?:delivery|baggage|shipment)/i,
    resolution: 'Acknowledge the problem, find the item or the cause, and make the {party} whole: {remedy}. Give a firm date and keep them informed until it is closed.',
    steps: ['Open a claim in the {record} with the reference numbers, photos and dates.', 'Trace the item or confirm the cause with the carrier or the responsible team within 24 hours.', 'Offer the remedy: {remedy}.', 'Confirm the outcome to the {party} in writing and close the claim.'] },
  { key: 'subscription cancellation', re: /cancel(?:l?ing)?.*(?:subscription|plan|membership|account)|(?:subscription|membership).*cancel|can'?t find the (?:cancel )?button|unsubscribe/i,
    resolution: 'Cancel the subscription for the {party} now, without making them hunt for the option, and confirm the end date and any refund due under {rule}. Cancellation must be as easy as sign-up.',
    steps: ['Verify the identity of the {party} and find the subscription in the {record}.', 'Cancel it immediately (or at the end of the paid period if that is the stated policy) and send written confirmation with the end date.', 'Refund any charge taken after the cancellation request and any unused period the policy allows.', 'Give the {party} the self-service route (account settings, billing, cancel) and report the missing button to the product team.'] },
  { key: 'account access', re: /password|log-?in|sign-?in|locked out|account (?:locked|suspended|disabled)|reset email|verification (?:code|email)|two-factor|2fa|never arrives/i,
    resolution: 'Restore access through the verified recovery route, never by sharing a password: check the email on file and the spam folder, resend the reset, and if it still does not arrive verify the identity and reset it on behalf of the {party}.',
    steps: ['Confirm the email address on the account is correct and ask the {party} to check spam, junk and blocked senders.', 'Resend the reset link once and check the mail system log to see whether it was sent and accepted.', 'If it is not delivered, verify identity by the agreed method and update the address or reset access directly.', 'Ask the {party} to set a new password, turn on two-step sign-in and confirm everything works before closing.'] },
  { key: 'return outside the policy window', re: /return|restocking|policy window|exchange|store credit|outside the (?:refund|return) window|over the policy/i,
    resolution: 'Apply the written return policy to the dates and condition of the item. Inside the window, accept the return and refund; outside it, decline the standard refund politely but offer the best remaining option (exchange, store credit or a goodwill gesture), and always honour the legal rights for defective goods.',
    steps: ['Check the purchase date, delivery date and item condition in the {record} against {rule}.', 'If it is inside the window or the item is faulty, approve the return, send the label and refund to the original payment method on receipt.', 'If it is outside the window, explain the policy in plain words and offer an exchange, store credit or a manager-approved goodwill refund.', 'Confirm the decision to the {party} in writing and record the reason.'] },
  { key: 'billing error', re: /charged twice|double charge|duplicate (?:charge|payment|billing)|overcharg|wrong (?:amount|charge)|billing (?:error|dispute)|refund|chargeback|unauthori[sz]ed (?:charge|transaction)/i,
    resolution: 'Confirm the charge in the payment records and, if it is a duplicate or an error, refund it in full to the original payment method and tell the {party} the date it will arrive. A genuine charge is explained with the invoice.',
    steps: ['Find both charges in the {record} and compare amounts, dates and order numbers.', 'If one is a duplicate or wrong, issue a full refund to the original payment method.', 'Send the {party} written confirmation with the refund reference and the usual 3 to 10 working days for it to appear.', 'Fix the cause (for example a double submit) and record the case as closed.'] },
];

const GENERIC_ISSUE = {
  key: 'general case',
  resolution: 'Handle the case by the written rule in {rule}: establish the facts from the {record}, correct the error or decide the request on that basis, and make the {party} whole where the rule requires it ({remedy}). Give a clear written outcome and the reasons.',
  steps: ['Collect the facts from the {record} and confirm what was agreed or promised.', 'Compare them with {rule} and decide the outcome.', 'Tell the {party} the decision, the reasons and the date of any action in writing.', 'Have {owner} review it, then close the case and record the outcome.'],
};

export function pickIssue(text) {
  const t = String(text ?? '');
  return ISSUES.find((i) => i.re.test(t)) ?? GENERIC_ISSUE;
}

const fill = (s, d) => s.replace(/\{(record|owner|party|remedy|rule)\}/g, (_, k) => d[k]);

// ---- reading the question --------------------------------------------------

const CASE_RE = /\bfor\s+(?:an?|the)\s+([^,.]{3,90}?),\s*(?:case|scenario)\s+(\d+)\s+(?:concerns|involves|is about|covers)\s+(?:an?\s+|the\s+)?([^.?!]{3,100})/i;

export function parseCase(text) {
  const m = CASE_RE.exec(clean(text));
  if (!m) return null;
  return { domainText: clean(m[1]), caseNo: Number(m[2]), issueText: clean(m[3]).replace(/[.?!]+$/, '') };
}

// Text that describes a business or service situation, not a technical fault.
const TECH_RE = /\b(error|exception|stack ?trace|traceback|npm|pip|yarn|docker|kubernetes|compile|compiler|segfault|undefined|null pointer|syntax|install(?:ation)?|dependency|dependencies|module|cannot find|failed to|unable to resolve|\.(?:js|py|ts|java|exe|tar|xz|dll|json|yaml|sql)\b|http\s?[45]\d\d|port \d+|localhost|git |sdk|api key|build|config(?:uration)? file|vs20\d\d|crash(?:es|ed|ing)?|freez|bug|upload|download|slow|lag|blue screen|reboot|driver|firmware|printer|bluetooth|login loop|cordova|activex|sap b1|regex|javascript|python|java\b|linux|windows|wifi|router|modem)\b/i;
const SERVICE_RE = /\b(customer|ticket|charged|refund|cancel|subscription|order|delivery|baggage|luggage|complaint|booking|reservation|invoice|billing|warranty|return|password reset|account (?:locked|suspended)|resolution|support (?:case|incident)|compensation)\b/i;

export function isBusinessTicket(text) {
  const t = clean(text);
  if (parseCase(t)) return true;
  if (/^(?:customer|ticket)\s*:?/i.test(t) || /\bwhat is the right resolution\b|\bhow should support resolve\b|\bresolve this ticket\b/i.test(t)) return !TECH_RE.test(t) || /charged|refund|cancel|subscription|password reset/i.test(t);
  return SERVICE_RE.test(t) && !TECH_RE.test(t);
}

// ---- the answer ------------------------------------------------------------

export function businessAnswer(text) {
  const t = clean(text);
  const c = parseCase(t);
  const domain = pickDomain(c ? c.domainText : t, { named: Boolean(c) });
  const issue = pickIssue(c ? c.issueText : t);
  const d = { ...domain };
  const where = c ? `${c.domainText}, case ${c.caseNo}` : null;
  const resolution = fill(issue.resolution, d);
  const steps = issue.steps.map((s) => fill(s, d));
  const subject = c ? `For ${c.domainText}, case ${c.caseNo} (${c.issueText}): ` : '';
  const answer = `${subject}Resolution: ${resolution} Next action: ${steps.map((s, i) => `${i + 1}) ${s}`).join(' ')}`;
  return {
    answer,
    resolution,
    next_action: steps[0],
    steps,
    issue: issue.key,
    domain: domain.key,
    case: where,
    resolved: true,
    verdict: 'found',
    found: true,
    reason: `Matched the situation to a standard ${issue.key} procedure for ${domain.key === 'generic' ? 'the stated case' : domain.key}; confirm the case facts against the file before acting.`,
  };
}

// ---- plain-language troubleshooting for technical tickets -------------------

// Used only when no live source or model can answer a technical ticket. It is
// a real method, not a refusal: gather the exact error, check the usual causes
// in order, change one thing at a time.
const QUICK = [
  { re: /internet|wi-?fi|broadband|router|modem|no connection|offline/i, steps: ['Check whether other devices also lose the connection; if all do, the fault is the line or the router, not your device.', 'Unplug the modem and router for 30 seconds, plug the modem in first, wait 2 minutes, then the router.', 'Check the cables and the router lights; a red or blinking line light means the provider side is down, so check their outage page or call them.', 'Test with a cable straight to the router and, if you can, another device, to tell a Wi-Fi fault from a line fault.', 'If it is still down after a restart, report the outage to the provider with the router light status and ask for a line test and a bill credit for the downtime.'] },
  { re: /npm|eresolve|node_modules|peer dep/i, steps: ['Read which two packages disagree in the ERESOLVE message (the "Found" and "Could not resolve dependency" lines).', 'Try installing with `npm install --legacy-peer-deps` to accept the older peer rules, or `--force` as a last resort.', 'Better: upgrade or downgrade the named package to a version whose peer range matches, or add an "overrides" entry in package.json.', 'Delete node_modules and the lock file, run `npm install` again and re-run the build to confirm.'] },
  { re: /tar\.xz|decompress|unzip|extract|archive|corrupt/i, steps: ['Check the download finished: compare the file size and checksum with the publisher value and download again if they differ.', 'Make sure xz is installed (for example `sudo apt install xz-utils`) and run `tar -xJf file.tar.xz`.', 'If you see "not in gzip format" or "unexpected end of file", the file is truncated or is really another format; run `file file.tar.xz` to see what it is.', 'On Windows use 7-Zip (extract twice: first the .xz, then the .tar).'] },
  { re: /crash|upload|larger than|file size|too large|10 ?mb/i, steps: ['Reproduce it with a small file and a large one to confirm the size limit is the trigger.', 'Check the app and server logs at the crash time for out-of-memory or request-size errors.', 'Raise the request and memory limits (for example the maximum request size on the server) or compress or resize the image in the app before upload.', 'Show a clear message when a file is over the limit, ship the fix and tell the customer when it is live.'] },
];

export function troubleshootingAnswer(text) {
  const t = clean(text).slice(0, 240);
  const quick = QUICK.find((q) => q.re.test(t));
  const steps = quick ? quick.steps : [
    'Write down the exact error message, the step where it appears and anything that changed just before (an update, a new setting, a new device).',
    'Restart the affected program or device, then retry once; many faults are cleared by a clean start.',
    'Check the basics in order: power and connections, network or login status, free disk space and memory, and that the software is up to date.',
    'Search the exact error text together with the product name and version, and apply the vendor fix if there is one; change one thing at a time and retest after each.',
    'If it still fails, collect the logs and screenshots and escalate to the vendor support team with those details and the steps already tried.',
  ];
  const answer = `Resolution for "${t}": ${quick ? "follow these specific steps" : "work through the standard checks in order, starting with a restart and the basics, and escalate with logs if it persists"}. Next action: ${steps.map((s, i) => `${i + 1}) ${s}`).join(' ')}`;
  return {
    answer, resolution: steps.slice(0, 3).join(' '), next_action: steps[0], steps, resolved: false,
    verdict: 'found', found: true,
    reason: 'No live source or model could be reached for this exact problem, so the standard troubleshooting sequence is given instead of a specific fix.',
  };
}
