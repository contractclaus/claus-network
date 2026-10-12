import { amount, authorize, copy, digest, integer, requireThat, shape, text } from '../shared/index.mjs';
export function validateFees(value) {
    shape(value, ['rateBps', 'flatByAsset']);
    integer(value.rateBps, 0, 10000);
    requireThat(value.flatByAsset && Object.getPrototypeOf(value.flatByAsset) === Object.prototype, 'invalid_fee_assets');
    for (const [asset, flat] of Object.entries(value.flatByAsset)) {
        text(asset);
        amount(flat);
    }
}
export function validateSponsorship(value) {
    shape(value, ['enabled', 'payer', 'capabilities']);
    requireThat(typeof value.enabled === 'boolean' && /^0x[0-9a-fA-F]{40}$/.test(value.payer), 'invalid_sponsorship');
    requireThat(Array.isArray(value.capabilities) && value.capabilities.length <= 32, 'invalid_capabilities');
    for (const capability of value.capabilities)
        text(capability);
    requireThat(new Set(value.capabilities).size === value.capabilities.length, 'duplicate_capability');
}
export function price({ providerAmount, asset, fees, sponsored }) {
    validateFees(fees);
    text(asset);
    requireThat(typeof sponsored === 'boolean', 'invalid_sponsorship');
    const provider = amount(providerAmount);
    const network = (provider * BigInt(fees.rateBps) + 9999n) / 10000n + amount(fees.flatByAsset[asset] ?? '0');
    const project = (sponsored ? 0n : provider) + network;
    const sponsor = sponsored ? provider : 0n;
    for (const value of [network, project, sponsor])
        amount(value.toString());
    return { provider: provider.toString(), network: network.toString(), project: project.toString(), sponsor: sponsor.toString() };
}
const accountKey = (account, asset) => digest({ account: text(account), asset: text(asset) });
export async function balance(reader, account, asset) {
    return (await reader.read('balances', accountKey(account, asset)))?.value ??
        { account, asset, available: '0', reserved: '0', spent: '0' };
}
async function move(tx, account, asset, change) {
    const id = accountKey(account, asset);
    const old = (await tx.read('balances', id));
    const value = old?.value ?? (await balance(tx, account, asset));
    for (const field of ['available', 'reserved', 'spent']) {
        const next = amount(value[field]) + (change[field] ?? 0n);
        requireThat(next >= 0n, field === 'available' ? 'funding_insufficient' : 'invalid_reservation');
        value[field] = next.toString();
        amount(value[field]);
    }
    (await tx.write('balances', id, value, old?.revision ?? 0));
    return copy(value);
}
export async function reserve(tx, account, asset, maximum) {
    const n = amount(maximum);
    if (n !== 0n)
        (await move(tx, account, asset, { available: -n, reserved: n }));
}
export async function settleReservation(tx, account, asset, maximum, actual) {
    const ceiling = amount(maximum), cost = amount(actual);
    requireThat(cost <= ceiling, 'cost_exceeds_reservation');
    if (ceiling !== 0n)
        (await move(tx, account, asset, { available: ceiling - cost, reserved: -ceiling, spent: cost }));
}
export function createBilling({ store, authorize: check, now }) {
    return {
        async balance({ actor, account, asset }) {
            (await authorize(check, actor, 'billing.read', { account }));
            return (await balance(store, account, asset));
        },
        // The trusted host must verify the external funding receipt first.
        // This records funding; it neither transfers assets nor verifies a chain.
        async recordFunding({ actor, account, asset, amount: value, receiptId }) {
            (await authorize(check, actor, 'funding.record', { account }));
            text(receiptId);
            amount(value);
            requireThat(amount(value) > 0n, 'invalid_funding');
            const funding = { account: text(account), asset: text(asset), amount: value, receiptId };
            const hash = digest(funding);
            return store.transaction(async (tx) => {
                await authorize(check, actor, 'funding.record', { account }, tx);
                const old = (await tx.read('funding-receipts', receiptId));
                if (old) {
                    requireThat(old.value.hash === hash, 'funding_receipt_conflict');
                    return old.value;
                }
                (await move(tx, account, asset, { available: amount(value) }));
                const record = { ...funding, hash };
                (await tx.write('funding-receipts', receiptId, record, 0));
                (await tx.event({ type: 'funding.recorded', ...record, at: now() }));
                return record;
            });
        }
    };
}
