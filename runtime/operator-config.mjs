// Host configuration only; never accepted from API input or archive contents.
export function operatorConfig(env = process.env) {
  return {
    ...(env.CLAUS_SITE_ORIGIN ? { siteOrigin: env.CLAUS_SITE_ORIGIN } : {}),
    ...(env.CLAUS_OPERATOR_ID ? { operatorId: env.CLAUS_OPERATOR_ID } : {}),
    ...(env.CLAUS_ARCHIVE_SIGNING_KEY ? { signingKey: env.CLAUS_ARCHIVE_SIGNING_KEY } : {}),
    ...(env.CLAUS_TRUSTED_OPERATORS ? { trustedOperators: JSON.parse(env.CLAUS_TRUSTED_OPERATORS) } : {})
  };
}
