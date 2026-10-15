const origin = "https://claus-network-api.vercel.app";
function validateLogin(challenge, address, now = Date.now()) {
  if (challenge?.chainId !== 1 || typeof challenge.id !== "string" || !/^auth_[A-Za-z0-9-]+$/.test(challenge.id) || typeof challenge.message !== "string" || challenge.message.length > 1200 || !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt <= now || challenge.expiresAt > now + 301e3) throw Error("invalid_network_login");
  const domain = new URL(origin).hostname;
  const prefix = `${domain} wants you to sign in with your Ethereum account:
${address.toLowerCase()}

Sign in to Claus Network. This does not authorize a blockchain transaction.

URI: https://${domain}/network
Version: 1
Chain ID: 1
Nonce: `;
  const rest = challenge.message.slice(prefix.length);
  const match = /^([a-f0-9]{32})\nIssued At: ([^\n]+)\nExpiration Time: ([^\n]+)\nRequest ID: ([A-Za-z0-9_-]+)$/.exec(rest);
  if (!challenge.message.startsWith(prefix) || !match || match[4] !== challenge.id || Date.parse(match[3]) !== challenge.expiresAt || !Number.isFinite(Date.parse(match[2])) || Math.abs(now - Date.parse(match[2])) > 301e3) throw Error("invalid_network_login");
}
export {
  validateLogin
};
