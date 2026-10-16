function workWalletFees(fees, bounds) {
  if (fees.maxFeePerGas <= 0n || fees.maxPriorityFeePerGas < 0n) throw Error("work_wallet_invalid_fee_quote");
  let maxPriorityFeePerGas = fees.maxPriorityFeePerGas > 1000000n ? fees.maxPriorityFeePerGas : 1000000n;
  let maxFeePerGas = fees.maxFeePerGas * 2n + maxPriorityFeePerGas;
  if (!bounds) return { maxPriorityFeePerGas, maxFeePerGas };
  const { gas, baseFeePerGas, maxCost, balance, value } = bounds;
  if (gas <= 0n || gas > 600000n) throw Error("work_wallet_gas_units_limit");
  if (baseFeePerGas === null || baseFeePerGas < 0n || maxCost <= 0n || value < 0n || balance < 0n) throw Error("work_wallet_invalid_fee_quote");
  if (balance <= value) throw Error("work_wallet_insufficient_eth");
  const budgetCeiling = maxCost / gas, cashCeiling = (balance - value) / gas;
  const ceiling = budgetCeiling < cashCeiling ? budgetCeiling : cashCeiling;
  if (budgetCeiling < baseFeePerGas + 1000000n) throw Error("work_wallet_gas_budget_below_current_base_fee");
  if (cashCeiling < baseFeePerGas + 1000000n) throw Error("work_wallet_insufficient_eth");
  const availableTip = ceiling - baseFeePerGas;
  if (maxPriorityFeePerGas > availableTip) maxPriorityFeePerGas = availableTip;
  if (maxFeePerGas > ceiling) maxFeePerGas = ceiling;
  if (maxFeePerGas < baseFeePerGas + maxPriorityFeePerGas) throw Error("work_wallet_fee_quote_below_current_base_fee");
  return { maxPriorityFeePerGas, maxFeePerGas };
}
export {
  workWalletFees
};
