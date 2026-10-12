import { encodeFunctionData, keccak256, recoverTypedDataAddress, zeroAddress } from 'viem';
import { amount, digest, integer, requireThat, shape } from '../src/shared/index.mjs';
import { walletAbi } from './wallet-abi.mjs';

const fields = list => list.map(([name, type]) => ({ name, type }));
export const sessionTypes = { SessionAuthorization: fields([
  ['sessionId','bytes32'],['signer','address'],['asset','address'],['recipient','address'],
  ['perPayment','uint128'],['total','uint128'],['validAfter','uint64'],['validUntil','uint64'],['generation','uint64'],['deadline','uint64']
]) };
export const paymentTypes = { Payment: fields([
  ['sessionId','bytes32'],['generation','uint64'],['asset','address'],['recipient','address'],['amount','uint128'],
  ['quoteHash','bytes32'],['nonce','uint256'],['deadline','uint64']
]) };
export const walletDomain = address => ({ name: 'Claus Project Wallet', version: '1', chainId: 11155111, verifyingContract: address });
const bytes32 = x => requireThat(/^0x[0-9a-f]{64}$/i.test(x) && x !== '0x'+'0'.repeat(64), 'invalid_session');
const address = x => requireThat(/^0x[0-9a-f]{40}$/i.test(x) && x.toLowerCase() !== zeroAddress, 'invalid_address');
export function createWalletRead({ client, now = () => Date.now() }) {
  const read = (wallet, functionName, args = []) => client.readContract({ address: wallet.address, abi: walletAbi, functionName, args });
  async function validate(wallet) {
    requireThat(await client.getChainId() === 11155111, 'wrong_chain');
    const code = await client.getCode({ address: wallet.address });
    requireThat(code && keccak256(code) === wallet.codeHash &&
      (await read(wallet, 'owner')).toLowerCase() === wallet.owner.toLowerCase(), 'wallet_profile_changed');
  }
  return {
    validate,
    async validateAction(wallet, typedData, signature) {
      await validate(wallet); const m=typedData.message, seconds=Math.floor(now()/1000);
      requireThat(m.deadline>seconds,'payment_expired');
      const s=await read(wallet,'sessions',[m.sessionId]);
      if(typedData.primaryType==='SessionAuthorization') {
        requireThat(!await read(wallet,'revokedSessions',[m.sessionId]),'session_retired');
        requireThat(BigInt(m.generation)===s[8]+1n,'session_stale');
        requireThat(await this.verify(typedData,wallet.owner,signature),'session_stale');
      } else {
        requireThat(s[0]!==zeroAddress && BigInt(m.generation)===s[8] && s[1].toLowerCase()===m.asset.toLowerCase() &&
          s[2].toLowerCase()===m.recipient.toLowerCase() && BigInt(m.amount)<=s[3] && s[5]+BigInt(m.amount)<=s[4] &&
          BigInt(seconds)>=s[6] && BigInt(seconds)<s[7] && !await read(wallet,'paidQuotes',[m.sessionId,m.quoteHash]) &&
          !await read(wallet,'paymentNonces',[m.sessionId,BigInt(m.nonce)]),'session_payment_denied');
        requireThat(await this.verify(typedData,s[0],signature),'session_stale');
      }
    },
    async session(wallet, input) {
      shape(input, ['sessionId','signer','recipient','perPayment','total','validUntil']);
      bytes32(input.sessionId);address(input.signer);address(input.recipient);
      requireThat(input.recipient.toLowerCase() !== wallet.address.toLowerCase(), 'invalid_session');
      requireThat(amount(input.perPayment) > 0n && amount(input.total) >= amount(input.perPayment) &&
        amount(input.total) <= 2n * 10n ** 18n, 'invalid_session_limit');
      const seconds = Math.floor(now()/1000);
      integer(input.validUntil, seconds+60, seconds+30*86400);
      await validate(wallet);
      requireThat(!await read(wallet,'revokedSessions',[input.sessionId]),'session_retired');
      const session = await read(wallet, 'sessions', [input.sessionId]);
      return { domain: walletDomain(wallet.address), types: sessionTypes, primaryType: 'SessionAuthorization',
        message: { ...input, asset: zeroAddress, validAfter: seconds, generation: Number(session[8])+1,
          deadline: Math.min(seconds+3600,input.validUntil) } };
    },
    async payment(wallet, sessionId, { order, quote }) {
      bytes32(sessionId);await validate(wallet);
      requireThat(quote.chainId === 11155111 && quote.asset === 'native', 'unsupported_payment_asset');
      const s = await read(wallet, 'sessions', [sessionId]), seconds = Math.floor(now()/1000);
      requireThat(s[0] !== zeroAddress && s[1] === zeroAddress && s[2].toLowerCase() === quote.recipient.toLowerCase() &&
        BigInt(quote.maximumWei) > 0n && BigInt(quote.maximumWei) <= s[3] && s[5]+BigInt(quote.maximumWei) <= s[4] &&
        BigInt(seconds) >= s[6] && BigInt(seconds) < s[7], 'session_payment_denied');
      const quoteHash = '0x'+order.quoteHash.slice(7);
      requireThat(!await read(wallet, 'paidQuotes', [sessionId,quoteHash]), 'payment_already_complete');
      return { signer: s[0], typedData: { domain: walletDomain(wallet.address), types: paymentTypes, primaryType: 'Payment',
        message: { sessionId, generation: Number(s[8]), asset: zeroAddress, recipient: quote.recipient,
          amount: quote.maximumWei, quoteHash, nonce: BigInt('0x'+digest({orderId:order.id,wallet:wallet.address}).slice(7)).toString(),
          deadline: Math.min(Number(s[7]), Math.floor(order.deadline/1000)) } } };
    },
    async verify(typedData, expected, signature) {
      try { return (await recoverTypedDataAddress({ ...typedData, signature })).toLowerCase() === expected.toLowerCase(); }
      catch { return false; }
    },
    async revoke(wallet, sessionId) {
      bytes32(sessionId);await validate(wallet);
      return { chainId:11155111,from:wallet.owner,to:wallet.address,value:'0',
        data:encodeFunctionData({abi:walletAbi,functionName:'revokeSession',args:[sessionId]}) };
    }
  };
}
