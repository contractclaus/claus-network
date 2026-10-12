import { encodeFunctionData, keccak256, parseAbi, zeroAddress } from 'viem';
import { requireThat } from '../src/shared/index.mjs';

export const vaultAbi = parseAbi([
  'function admissionPolicy() view returns (address)',
  'function principal(address) view returns (uint256)',
  'function totalPrincipal() view returns (uint256)',
  'function deposit() payable',
  'function withdraw(uint256,address)'
]);
const address = value => requireThat(typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) &&
  value.toLowerCase() !== zeroAddress, 'invalid_address');

export function createVaultRead({ client }) {
  async function verify(vault) {
    requireThat(await client.getChainId() === 11155111 && vault.chainId === 11155111, 'wrong_chain');
    requireThat(keccak256(await client.getCode({ address: vault.address })) === vault.codeHash, 'vault_code_changed');
    const policy = await client.readContract({ address: vault.address, abi: vaultAbi, functionName: 'admissionPolicy' });
    requireThat(policy.toLowerCase() === vault.policy.target.toLowerCase(), 'project_binding_changed');
  }
  return {
    async transaction(vault, { kind, amountWei, recipient }) {
      requireThat(['deposit', 'withdraw'].includes(kind), 'invalid_vault_action');
      requireThat(typeof amountWei === 'string' && /^[1-9][0-9]{0,77}$/.test(amountWei) &&
        BigInt(amountWei) < 2n ** 256n, 'invalid_amount');
      if (kind === 'withdraw') {
        address(recipient); requireThat(recipient.toLowerCase() !== vault.address.toLowerCase(), 'invalid_address');
      } else requireThat(recipient === undefined, 'invalid_vault_action');
      await verify(vault);
      return { chainId: 11155111, to: vault.address, value: kind === 'deposit' ? amountWei : '0',
        data: encodeFunctionData({ abi: vaultAbi, functionName: kind,
          args: kind === 'withdraw' ? [BigInt(amountWei), recipient] : [] }) };
    },
    async balance(vault, account) {
      address(account); await verify(vault);
      const block = await client.getBlock({ blockTag: 'finalized' });
      const [principal, totalPrincipal] = await Promise.all(['principal', 'totalPrincipal'].map(functionName =>
        client.readContract({ address: vault.address, abi: vaultAbi, functionName,
          args: functionName === 'principal' ? [account] : [], blockNumber: block.number })));
      return { chainId: 11155111, address: vault.address, account, principalWei: principal.toString(),
        totalPrincipalWei: totalPrincipal.toString(), blockNumber: block.number.toString(), blockHash: block.hash };
    }
  };
}
