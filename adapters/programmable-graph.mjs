import { encodeAbiParameters, encodeDeployData, encodeFunctionData, getCreate2Address, keccak256, stringToHex, toHex } from 'viem';
import { requireThat, integer } from '../src/shared/index.mjs';

const hash = text => keccak256(stringToHex(text));
const SALT = hash('ProgrammableCreate2GraphTargetSaltV1(uint256 chainId,address factory,bytes32 routeNamespace,bytes32 routeNonce,bytes32 targetIdHash,bytes32 applicantSalt,address authorizedLauncher)');
const TARGET = hash('ProgrammableCreate2GraphTargetCommitmentV1(uint256 targetIndex,bytes32 targetIdHash,bytes32 applicantSalt,uint256 deploymentValue,uint256 initializerValue,bytes32 initCodeHash,bytes32 initializerCalldataHash)');
const GRAPH = hash('ProgrammableCreate2GraphCommitmentV1(uint256 chainId,address factory,bytes32 routeNamespace,bytes32 routeNonce,bytes32 topologyHash,address authorizedLauncher,uint256 totalValue,bytes32 targetCommitmentsHash)');
const types = (...names) => names.map(type => ({ type }));
const address = x => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x) && !/^0x0{40}$/.test(x);
const word = x => typeof x === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x);
const bytes = x => typeof x === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(x);

function route(config) {
  integer(config.chainId, 1);
  requireThat(address(config.factory) && address(config.authorizedLauncher) && word(config.routeNamespace) &&
    word(config.routeNonce) && word(config.topologyHash) && ![config.routeNamespace, config.routeNonce, config.topologyHash].includes(toHex(0, { size: 32 })), 'invalid_graph_route');
}

export function effectiveTargetSalt(config, target) {
  route(config);
  requireThat(word(target.targetIdHash) && word(target.applicantSalt), 'invalid_graph_target');
  return keccak256(encodeAbiParameters(types('bytes32', 'uint256', 'address', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'address'),
    [SALT, BigInt(config.chainId), config.factory, config.routeNamespace, config.routeNonce, target.targetIdHash,
      target.applicantSalt, config.authorizedLauncher]));
}

export function predictGraphTarget(config, target) {
  requireThat(bytes(target.initCode) && target.initCode !== '0x' && target.initCode.length <= 2 + 49152 * 2, 'invalid_graph_initcode');
  return getCreate2Address({ from: config.factory, salt: effectiveTargetSalt(config, target), bytecodeHash: keccak256(target.initCode) });
}

// Exact factory commitment, not a Programmable admission or launch permit.
export function prepareGraph(config, targets) {
  route(config);
  requireThat(Array.isArray(targets) && targets.length >= 3 && targets.length <= 16, 'invalid_graph_size');
  const ids = new Set(), addresses = new Set(); let totalValue = 0n, inputBytes = 0;
  const predictions = targets.map((target, i) => {
    requireThat(word(target.targetIdHash) && target.targetIdHash !== toHex(0, { size: 32 }) &&
      !ids.has(target.targetIdHash.toLowerCase()) && bytes(target.initializerCalldata) &&
      target.initializerCalldata.length <= 2 + 131072 * 2, 'invalid_graph_target');
    ids.add(target.targetIdHash.toLowerCase());
    const deploymentValue = BigInt(target.deploymentValue), initializerValue = BigInt(target.initializerValue);
    requireThat(deploymentValue >= 0n && initializerValue >= 0n && (initializerValue === 0n || target.initializerCalldata !== '0x'), 'invalid_graph_value');
    totalValue += deploymentValue + initializerValue;
    requireThat(totalValue < 2n ** 256n, 'invalid_graph_value');
    const predicted = predictGraphTarget(config, target);
    requireThat(!addresses.has(predicted.toLowerCase()), 'duplicate_graph_address'); addresses.add(predicted.toLowerCase());
    inputBytes += (target.initCode.length + target.initializerCalldata.length - 4) / 2;
    const commitment = keccak256(encodeAbiParameters(types('bytes32', 'uint256', 'bytes32', 'bytes32', 'uint256', 'uint256', 'bytes32', 'bytes32'),
      [TARGET, BigInt(i), target.targetIdHash, target.applicantSalt, deploymentValue, initializerValue,
        keccak256(target.initCode), keccak256(target.initializerCalldata)]));
    return { address: predicted, salt: effectiveTargetSalt(config, target), commitment };
  });
  requireThat(inputBytes <= 524288, 'graph_input_too_large');
  const commitmentsHash = keccak256(encodeAbiParameters(types('bytes32[]'), [predictions.map(x => x.commitment)]));
  const graphCommitment = keccak256(encodeAbiParameters(types('bytes32', 'uint256', 'address', 'bytes32', 'bytes32', 'bytes32', 'address', 'uint256', 'bytes32'),
    [GRAPH, BigInt(config.chainId), config.factory, config.routeNamespace, config.routeNonce, config.topologyHash,
      config.authorizedLauncher, totalValue, commitmentsHash]));
  return { authorization: { routeNamespace: config.routeNamespace, routeNonce: config.routeNonce, topologyHash: config.topologyHash,
    graphCommitment, authorizedLauncher: config.authorizedLauncher, totalValue: totalValue.toString() }, targets, predictions };
}

// Acyclic three-target candidate: token -> initializer -> hook. The reviewed
// policy is an explicit external dependency. No private key, HTTP or broadcast.
// Platform fee settlement, metadata admission and Router permit remain separate.
export function prepareClausMarketGraph(config, market, artifacts, { maximumMiningAttempts = 1000000 } = {}) {
  route(config); integer(maximumMiningAttempts, 1, 1000000);
  for (const key of ['manager', 'policy', 'quoteToken', 'owner']) requireThat(address(market[key]), 'invalid_market_address');
  requireThat(typeof market.name === 'string' && market.name.length > 0 && market.name.length <= 80 &&
    typeof market.symbol === 'string' && market.symbol.length > 0 && market.symbol.length <= 16, 'invalid_market_identity');
  integer(market.tickSpacing, 1, 32767); integer(market.maximumFee, 0, 100000); integer(market.fallbackFee, 0, market.maximumFee);
  requireThat(BigInt(market.supply) > 0n && BigInt(market.startingPrice) > 0n, 'invalid_market_amount');
  const target = (name, artifact, args) => ({ targetIdHash: hash(name), applicantSalt: toHex(0, { size: 32 }), deploymentValue: '0',
    initializerValue: '0', initCode: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args }), initializerCalldata: '0x' });
  const token = target('claus.market.token', artifacts.token, [market.name, market.symbol, BigInt(market.supply), market.owner]);
  const tokenAddress = predictGraphTarget(config, token);
  const initializer = target('claus.market.initializer', artifacts.initializer, [config.factory, market.manager, tokenAddress,
    market.quoteToken, market.tickSpacing, BigInt(market.startingPrice)]);
  const initializerAddress = predictGraphTarget(config, initializer);
  const hook = target('claus.market.hook', artifacts.hook, [market.manager, market.policy, tokenAddress, market.quoteToken,
    initializerAddress, market.tickSpacing, market.maximumFee, market.fallbackFee]);
  let hookAddress, attempts = 0;
  for (; attempts < maximumMiningAttempts; attempts++) {
    hook.applicantSalt = toHex(attempts, { size: 32 }); hookAddress = predictGraphTarget(config, hook);
    if ((BigInt(hookAddress) & 0x3fffn) === 0x2080n) break;
  }
  requireThat(attempts < maximumMiningAttempts, 'hook_salt_not_found');
  initializer.initializerCalldata = encodeFunctionData({ abi: artifacts.initializer.abi, functionName: 'initialize', args: [hookAddress] });
  return { state: 'unsigned_candidate', ...prepareGraph(config, [token, initializer, hook]),
    addresses: { token: tokenAddress, initializer: initializerAddress, hook: hookAddress }, miningAttempts: attempts + 1,
    limitations: ['platform_fee_settlement_missing', 'profile_admission_missing', 'router_permit_missing', 'no_liquidity_supplied'] };
}
