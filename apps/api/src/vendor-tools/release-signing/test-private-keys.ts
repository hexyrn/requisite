/**
 * DEV/TEST release-signing private keys. Hexyrn-side / test use only: this directory is excluded from
 * the customer build (tsconfig "exclude"), so customer installs never contain a signing key.
 */
export const TEST_RELEASE_PRIVATE_KEY_1_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIPX27uWNdwQXWj/pUcKG35p3HloYmUn5fgn6NHKrrHuM
-----END PRIVATE KEY-----`;
export const TEST_RELEASE_PRIVATE_KEY_2_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIL/CX7MbqNrH0MU+w3/00LY5f7jVGxvdZZj0kPutYpTk
-----END PRIVATE KEY-----`;
