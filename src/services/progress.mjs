// A read-only projection of the accepted order. Never advances work or payment.
export function serviceProgress(order, now = Date.now()) {
  const terminal = ['cancelled', 'expired'].includes(order.state);
  const accepted = order.state === 'delivered' && order.acceptance === 'accepted';
  const probeComplete = order.purpose === 'conformance' && order.state === 'delivered';
  const phase = terminal ? order.state : probeComplete ? 'probe_delivered' : accepted ? 'accepted'
    : order.state === 'delivered' ? (order.acceptance === 'disputed' ? 'disputed' : 'awaiting_acceptance')
    : order.state;
  const payment = order.payment ?? {};
  return {
    phase,
    nextActor: terminal || accepted || probeComplete || phase === 'disputed' || (order.state !== 'delivered' && now >= order.deadline) ? null
      : ['awaiting_payment', 'awaiting_acceptance'].includes(phase) ? 'buyer' : 'provider',
    delivery: { state: order.state, deliveredAt: order.deliveredAt ?? null,
      deadline: order.deadline, deadlinePassed: !terminal && order.state !== 'delivered' && now >= order.deadline },
    acceptance: { state: order.acceptance },
    payment: { mode: payment.state === 'not_required' ? 'free' : 'direct-prepayment',
      state: payment.state, amountWei: payment.state === 'not_required' ? '0' : payment.amountWei ?? payment.evidence?.amountWei ?? payment.maximumWei ?? null,
      chainId: payment.evidence?.chainId ?? (payment.state === 'not_required' ? null : 11155111),
      transactionHash: payment.evidence?.transactionHash ?? null },
    scope: 'Recorded service order. Delivery, buyer acceptance and payment are separate. Direct prepayment is not escrow or an automatic refund.'
  };
}
