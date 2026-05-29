/**
 * Stricter config used by `prepublishOnly` to catch issues n8n's verification
 * pipeline flags before a release is published.
 *
 * @type {import('@types/eslint').ESLint.ConfigData}
 */
const baseConfig = require('./.eslintrc.js');

module.exports = {
  ...baseConfig,
  overrides: (baseConfig.overrides || []).map((override) => ({
    ...override,
    rules: {
      ...override.rules,
      'n8n-nodes-base/community-package-json-name-still-default': 'error',
    },
  })),
};
