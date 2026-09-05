#!/usr/bin/env node
/**
 * Contract check for the mobile apps: exercises every endpoint the resident and
 * security apps call, against the live seeded API, asserting the shapes the apps render.
 */
const BASE = 'http://localhost:4000/api';
let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL  ${name}  ${detail}`); }
}

async function call(method, path, { token, societyId, body, query } = {}) {
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (societyId) headers['x-society-id'] = societyId;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json };
}

const today = new Date().toISOString().slice(0, 10);
const plus2 = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);

async function main() {
  console.log('== resident app: auth ==');
  const login = await call('POST', '/auth/login', { body: { identifier: '+919800000101', password: 'Resident@123' } });
  check('resident password login', login.status === 200 && login.json?.data?.accessToken, JSON.stringify(login.json)?.slice(0, 200));
  const rToken = login.json?.data?.accessToken;
  const societyId = login.json?.data?.user?.preferredSocietyId ?? login.json?.data?.user?.memberships?.[0]?.societyId;
  check('login returns society membership', Boolean(societyId), JSON.stringify(login.json?.data?.user ?? {}));

  const who = await call('GET', '/whoami', { token: rToken, societyId });
  check('whoami', who.status === 200 && who.json?.data?.user?.fullName, JSON.stringify(who.json)?.slice(0, 200));
  check('whoami society currency', Boolean(who.json?.data?.society?.currency));
  const primaryUnit = who.json?.data?.membership?.primaryUnitId;
  check('whoami primary unit', Boolean(primaryUnit));

  // Admin (society office) — used to generate a bill so the payment flow is exercised.
  const aLogin = await call('POST', '/auth/login', { body: { identifier: 'admin@greenvalley.local', password: 'GreenValley@1' } });
  const adminToken = aLogin.json?.data?.accessToken;

  console.log('== resident app: dashboard feeds ==');
  const bills = await call('GET', '/bills/mine', { token: rToken, societyId, query: { limit: 12 } });
  check('bills/mine lists', bills.status === 200 && Array.isArray(bills.json?.data?.bills ?? bills.json?.data?.items), `status=${bills.status} ${JSON.stringify(bills.json?.data ?? {})?.slice(0, 120)}`);
  const complaints = await call('GET', '/complaints/mine', { token: rToken, societyId, query: { limit: 12 } });
  check('complaints/mine lists', complaints.status === 200 && Array.isArray(complaints.json?.data?.items), `status=${complaints.status}`);
  const bookings = await call('GET', '/amenity-bookings/mine', { token: rToken, societyId, query: { limit: 12 } });
  check('amenity-bookings/mine lists', bookings.status === 200 && Array.isArray(bookings.json?.data?.items), `status=${bookings.status}`);

  console.log('== resident app: complaints ==');
  const newC = await call('POST', '/complaints', {
    token: rToken, societyId,
    body: { category: 'PLUMBING', title: 'Mobile app contract check', description: 'Raised by the mobile-app contract verification script.', priority: 'LOW', locationType: 'UNIT', unitId: primaryUnit },
  });
  // The create response wraps the row: { complaint: { _id, ... } }
  const complaintId = newC.json?.data?.complaint?._id ?? newC.json?.data?._id;
  check('create complaint', [200, 201].includes(newC.status) && Boolean(complaintId), `status=${newC.status} ${JSON.stringify(newC.json)?.slice(0, 200)}`);
  const cDetail = await call('GET', `/complaints/${complaintId}`, { token: rToken, societyId });
  check('get complaint detail', cDetail.status === 200 && cDetail.json?.data?.title, `status=${cDetail.status}`);
  const cComments = await call('GET', `/complaints/${complaintId}/comments`, { token: rToken, societyId });
  check('complaint comments shape', cComments.status === 200 && (Array.isArray(cComments.json?.data) || Array.isArray(cComments.json?.data?.items)), `status=${cComments.status} ${JSON.stringify(cComments.json)?.slice(0, 150)}`);

  console.log('== resident app: bills + payment ==');
  let dueBill = (bills.json?.data?.bills ?? bills.json?.data?.items ?? []).find((b) => (b.dueAmount ?? 0) > 0.009);
  if (!dueBill) {
    // The demo seed ships no billed months; generate one for the demo unit (same as the e2e suite) so the payment flow is exercised.
    const gen = await call('POST', '/bills/generate', {
      token: adminToken, societyId,
      body: {
        period: today.slice(0, 7),
        dueDate: plus2,
        scope: 'UNITS',
        unitIds: [primaryUnit],
        includeFixedCharges: true,
        includeWater: true,
        includeParking: true,
      },
    });
    if ([200, 201].includes(gen.status)) {
      const bills2 = await call('GET', '/bills/mine', { token: rToken, societyId, query: { limit: 12 } });
      dueBill = (bills2.json?.data?.bills ?? bills2.json?.data?.items ?? []).find((b) => (b.dueAmount ?? 0) > 0.009);
    } else {
      console.log(`  (bill generation failed — status=${gen.status} ${JSON.stringify(gen.json?.message ?? {})?.slice(0, 120)})`);
    }
  }
  if (dueBill) {
    const bDetail = await call('GET', `/bills/${dueBill._id}`, { token: rToken, societyId });
    check('bill detail', bDetail.status === 200 && bDetail.json?.data?.period, `status=${bDetail.status}`);
    const intent = await call('POST', '/payments/intent', {
      token: rToken, societyId,
      body: { purpose: 'MAINTENANCE', billId: dueBill._id, clientRequestId: `mob-${Date.now()}` },
    });
    const order = intent.json?.data?.order;
    check('payment intent', [200, 201].includes(intent.status) && intent.json?.data?.payment?._id && order?.orderId, `status=${intent.status} ${JSON.stringify(intent.json?.data ?? {})?.slice(0, 250)}`);
    const verify = await call('POST', '/payments/verify', {
      token: rToken, societyId,
      body: {
        paymentId: intent.json?.data?.payment?._id,
        gatewayOrderId: order?.orderId,
        gatewayPaymentId: order?.mockPaymentId ?? `pay_mob_${Date.now()}`,
        signature: order?.mockSignature ?? 'x',
      },
    });
    const payStatus = String(verify.json?.data?.payment?.status ?? '').toUpperCase();
    check('payment verify/capture', [200, 201].includes(verify.status) && ['CAPTURED', 'PAID', 'SUCCESS', 'COMPLETED'].includes(payStatus), `status=${verify.status} pay=${payStatus} ${JSON.stringify(verify.json?.data ?? {})?.slice(0, 200)}`);
    check('receipt issued', /^RCP-/.test(String(verify.json?.data?.receipt?.receiptNumber ?? verify.json?.data?.payment?.receiptNumber ?? '')));
  } else {
    console.log('  (no due bills for the demo resident — payment flow exercised by the e2e suite instead)');
  }

  console.log('== resident app: amenities ==');
  const amenities = await call('GET', '/amenities', { token: rToken, societyId, query: { limit: 100 } });
  const amenity = (amenities.json?.data?.items ?? []).find((a) => a.isActive !== false);
  check('amenities list', amenities.status === 200 && Boolean(amenity), `status=${amenities.status}`);
  if (amenity) {
    const aDetail = await call('GET', `/amenities/${amenity._id}`, { token: rToken, societyId });
    check('amenity detail', aDetail.status === 200 && aDetail.json?.data?.name, `status=${aDetail.status}`);
    const avail = await call('GET', `/amenities/${amenity._id}/availability`, { token: rToken, societyId, query: { date: plus2 } });
    const slots = avail.json?.data?.slots ?? [];
    check('availability', avail.status === 200 && Array.isArray(slots), `status=${avail.status} closed=${avail.json?.data?.closed}`);
    const slot = slots.find((s) => s.available && !s.isPast);
    if (slot) {
      const book = await call('POST', '/amenity-bookings', {
        token: rToken, societyId,
        body: { amenityId: amenity._id, slotId: slot.slotId, date: plus2, startTime: slot.startTime, endTime: slot.endTime, numberOfPeople: 1 },
      });
      // The create response wraps the row: { booking: { _id, status, … } }.
      const bookingId = book.json?.data?.booking?._id ?? book.json?.data?._id;
      const bookingStatus = String(book.json?.data?.booking?.status ?? book.json?.data?.status ?? '').toUpperCase();
      check('create booking', [200, 201].includes(book.status) && Boolean(bookingId), `status=${book.status} ${JSON.stringify(book.json)?.slice(0, 250)}`);
      if (bookingId) {
        // If the slot fee makes it a held (PENDING_PAYMENT) booking, exercise the same
        // intent→verify the resident app's "Pay to confirm" button uses, then confirm it settled.
        if (bookingStatus === 'PENDING_PAYMENT') {
          const bookIntent = await call('POST', '/payments/intent', {
            token: rToken, societyId,
            body: { purpose: 'AMENITY_BOOKING', bookingId, clientRequestId: `mob-book-${Date.now()}` },
          });
          const bOrder = bookIntent.json?.data?.order ?? {};
          const bPaymentId = bookIntent.json?.data?.payment?._id;
          check('booking payment intent', [200, 201].includes(bookIntent.status) && bPaymentId && bOrder.orderId, `status=${bookIntent.status} ${JSON.stringify(bookIntent.json?.data ?? {})?.slice(0, 200)}`);
          const bookVerify = await call('POST', '/payments/verify', {
            token: rToken, societyId,
            body: { paymentId: bPaymentId, gatewayOrderId: bOrder.orderId, gatewayPaymentId: bOrder.mockPaymentId ?? `pay_mob_book_${Date.now()}`, signature: bOrder.mockSignature ?? 'x' },
          });
          const bPayStatus = String(bookVerify.json?.data?.payment?.status ?? '').toUpperCase();
          check('booking payment captured', [200, 201].includes(bookVerify.status) && ['CAPTURED', 'PAID', 'SUCCESS', 'COMPLETED'].includes(bPayStatus), `status=${bookVerify.status} pay=${bPayStatus}`);
          const confirmed = await call('GET', `/amenity-bookings/${bookingId}`, { token: rToken, societyId });
          check('booking confirmed after payment', confirmed.status === 200 && (['CONFIRMED'].includes(String(confirmed.json?.data?.status ?? '').toUpperCase()) || confirmed.json?.data?.isPaid), `status=${confirmed.status} booking=${confirmed.json?.data?.status} isPaid=${confirmed.json?.data?.isPaid}`);
        }
        const cancel = await call('POST', `/amenity-bookings/${bookingId}/cancel`, { token: rToken, societyId, body: { reason: 'contract check' } });
        check('cancel booking', [200, 201].includes(cancel.status), `status=${cancel.status} ${JSON.stringify(cancel.json)?.slice(0, 150)}`);
      }
    } else {
      console.log('  (no free slot on +2d — booking flow exercised by the e2e suite instead)');
    }
  }

  console.log('== resident app: visitors + QR pass ==');
  const pre = await call('POST', '/visitors/pre-approve', {
    token: rToken, societyId,
    body: {
      visitorName: 'Mobile Contract Guest', visitDate: today, expectedArrival: '10:30', purpose: 'Contract verification',
      visitorType: 'GUEST', numberOfVisitors: 1, generateQrPass: true,
    },
  });
  check('pre-approve visitor', [200, 201].includes(pre.status) && pre.json?.data?.visitor?._id, `status=${pre.status} ${JSON.stringify(pre.json?.data ?? {})?.slice(0, 250)}`);
  const visitorId = pre.json?.data?.visitor?._id;
  const qr = await call('GET', `/visitors/${visitorId}/qr`, { token: rToken, societyId });
  check('visitor QR pass', qr.status === 200 && qr.json?.data?.dataUrl?.startsWith('data:image'), `status=${qr.status} ${JSON.stringify(qr.json?.data ?? {})?.slice(0, 150)}`);
  const mine = await call('GET', '/visitors/mine', { token: rToken, societyId, query: { limit: 10 } });
  check('visitors/mine', mine.status === 200 && Array.isArray(mine.json?.data?.items) && (mine.json?.data?.items ?? []).some((v) => v._id === visitorId));

  console.log('== security app: auth + shift ==');
  const gLogin = await call('POST', '/auth/login', { body: { identifier: '+919800000901', password: 'Guard@1234' } });
  check('guard password login', gLogin.status === 200 && gLogin.json?.data?.accessToken, `status=${gLogin.status} ${JSON.stringify(gLogin.json)?.slice(0, 200)}`);
  const gToken = gLogin.json?.data?.accessToken;
  const gSociety = gLogin.json?.data?.user?.preferredSocietyId ?? gLogin.json?.data?.user?.memberships?.[0]?.societyId;
  const gWho = await call('GET', '/whoami', { token: gToken, societyId: gSociety });
  check('guard whoami security scope', gWho.status === 200 && (gWho.json?.data?.clientHints?.isSecurityScope || gWho.json?.data?.user?.roles?.includes('SECURITY_GUARD')), `status=${gWho.status} roles=${JSON.stringify(gWho.json?.data?.user?.roles)}`);

  const gates = await call('GET', '/gates', { token: gToken, societyId: gSociety });
  const gateList = Array.isArray(gates.json?.data) ? gates.json.data : (gates.json?.data?.items ?? []);
  check('gates list', gates.status === 200 && gateList.length > 0, `status=${gates.status} n=${gateList.length}`);
  const gateId = gateList[0]?._id ?? gateList[0]?.id;

  const shift = await call('POST', '/guards/shift/login', { token: gToken, societyId: gSociety, body: { gateId } });
  check('guard shift login', [200, 201].includes(shift.status) && shift.json?.data?.shiftLogId, `status=${shift.status} ${JSON.stringify(shift.json?.data ?? {})?.slice(0, 200)}`);

  console.log('== security app: queue + decisions ==');
  const queue = await call('GET', '/gate/queue', { token: gToken, societyId: gSociety, query: { gateId } });
  const q = queue.json?.data;
  check('gate queue shape', queue.status === 200 && Array.isArray(q?.awaitingApproval) && Array.isArray(q?.inside) && q?.counts, `status=${queue.status} ${JSON.stringify(q?.counts ?? {})}`);
  const awaiting = (q?.awaitingApproval ?? [])[0];
  if (awaiting) {
    const decide = await call('POST', `/visitors/${awaiting.id}/decide`, { token: gToken, societyId: gSociety, body: { decision: 'APPROVE' } });
    check('decide approve', [200, 201].includes(decide.status), `status=${decide.status} ${JSON.stringify(decide.json?.data ?? {})?.slice(0, 150)}`);
  } else {
    // use the resident-created pre-approved visitor instead
    const approve = await call('POST', `/visitors/${visitorId}/decide`, { token: gToken, societyId: gSociety, body: { decision: 'APPROVE' } });
    check('decide approve (resident visitor)', [200, 201].includes(approve.status), `status=${approve.status} ${JSON.stringify(approve.json?.data ?? {})?.slice(0, 150)}`);
  }

  const queue2 = await call('GET', '/gate/queue', { token: gToken, societyId: gSociety, query: { gateId } });
  const approved = (queue2.json?.data?.approvedNotEntered ?? [])[0];
  if (approved) {
    const checkIn = await call('POST', `/visitors/${approved.id}/check-in`, { token: gToken, societyId: gSociety, body: { gateId } });
    check('manual check-in', [200, 201].includes(checkIn.status) && checkIn.json?.data?.entry, `status=${checkIn.status} ${JSON.stringify(checkIn.json?.data ?? {})?.slice(0, 150)}`);
    if (checkIn.json?.data?.entry) {
      const checkOut = await call('POST', `/visitors/${approved.id}/check-out`, { token: gToken, societyId: gSociety, body: { gateId } });
      check('manual check-out', [200, 201].includes(checkOut.status) && typeof checkOut.json?.data?.durationMinutes === 'number', `status=${checkOut.status} ${JSON.stringify(checkOut.json?.data ?? {})?.slice(0, 150)}`);
    }
  } else {
    console.log('  (no approved visitor to check in — check-in/out exercised by the e2e suite)');
  }

  console.log('== security app: QR scan ==');
  // An invalid pass is rejected with an error envelope (4xx) — the app surfaces err.message.
  const scanBad = await call('POST', '/gate/scan', { token: gToken, societyId: gSociety, body: { token: 'totally-invalid-token-123456', gateId, action: 'CHECK_IN' } });
  const badRejected =
    (scanBad.status === 200 && scanBad.json?.data?.valid === false) ||
    (scanBad.status >= 400 && Boolean(scanBad.json?.message));
  check('scan invalid rejected', badRejected, `status=${scanBad.status} ${JSON.stringify(scanBad.json ?? {})?.slice(0, 150)}`);
  // A fresh pass for the valid scan (the queue flow above may already have consumed the first one).
  const scanPre = await call('POST', '/visitors/pre-approve', {
    token: rToken, societyId,
    body: { visitorName: 'Mobile Contract Scanner', visitDate: today, expectedArrival: '11:00', purpose: 'QR scan contract check', visitorType: 'GUEST', generateQrPass: true },
  });
  const scanVisitorId = scanPre.json?.data?.visitor?._id;
  const rescan = scanVisitorId
    ? await call('GET', `/visitors/${scanVisitorId}/qr`, { token: rToken, societyId })
    : { json: { data: null } };
  const token2 = rescan.json?.data?.token;
  if (token2) {
    const scanOk = await call('POST', '/gate/scan', { token: gToken, societyId: gSociety, body: { token: token2, gateId, action: 'CHECK_IN' } });
    // CHECK_IN answers with { visitor, entry, … } — success is the entry row, not a `valid` flag.
    check('scan valid pass (check-in)', scanOk.status === 200 && Boolean(scanOk.json?.data?.entry), `status=${scanOk.status} ${JSON.stringify(scanOk.json?.data ?? {})?.slice(0, 200)}`);
    if (scanOk.json?.data?.entry) {
      const scanOut = await call('POST', '/gate/scan', { token: gToken, societyId: gSociety, body: { token: token2, gateId, action: 'CHECK_OUT' } });
      check('scan check-out', scanOut.status === 200 && Boolean(scanOut.json?.data?.entry) && typeof scanOut.json?.data?.durationMinutes === 'number', `status=${scanOut.status} ${JSON.stringify(scanOut.json?.data ?? {})?.slice(0, 150)}`);
    }
  }

  console.log('== security app: log + dashboard + shift end ==');
  const log = await call('GET', '/visitors/entries/log', { token: gToken, societyId: gSociety, query: { gateId, limit: 20 } });
  check('entry log', log.status === 200 && Array.isArray(log.json?.data?.items), `status=${log.status} n=${log.json?.data?.items?.length}`);
  const board = await call('GET', '/guards/dashboard', { token: gToken, societyId: gSociety });
  const b = board.json?.data;
  check('security dashboard', board.status === 200 && Array.isArray(b?.gates) && Array.isArray(b?.guardsOnDuty) && Array.isArray(b?.hourly) && b?.queue, `status=${board.status} gates=${b?.gates?.length} duty=${b?.guardsOnDuty?.length}`);
  const endShift = await call('POST', '/guards/shift/logout', { token: gToken, societyId: gSociety, body: {} });
  check('guard shift logout', endShift.status === 200, `status=${endShift.status} ${JSON.stringify(endShift.json?.data ?? {})?.slice(0, 120)}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log('failures:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('script error:', err);
  process.exit(2);
});
