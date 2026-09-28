// React Native has no WebCrypto. Supabase needs crypto.subtle.digest (SHA-256)
// for secure PKCE sign-in, so provide it (and getRandomValues) via expo-crypto.
import * as ExpoCrypto from 'expo-crypto';

const g = globalThis as { crypto?: { -readonly [K in keyof Crypto]?: Crypto[K] } };
g.crypto ??= {};

if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = ExpoCrypto.getRandomValues as Crypto['getRandomValues'];
}

if (!g.crypto.subtle) {
  g.crypto.subtle = {
    digest: (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
      if (name.toUpperCase() !== 'SHA-256') throw new Error(`Unsupported digest algorithm: ${name}`);
      return ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, data);
    },
  } as SubtleCrypto;
}
